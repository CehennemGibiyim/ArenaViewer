import { NextResponse, type NextRequest } from "next/server";
import { accessEnabled, checkAccess } from "@/lib/server/access";
import {
  buildCsp,
  checkCsrf,
  clientKey,
  CSRF_COOKIE,
  isStateChanging,
  newCsrfToken,
  RateLimiter,
  ruleFor,
} from "@/lib/webSecurity";

/**
 * Hız sınırı sayaçları (g-webhard). Proxy süreç belleğinde tutulur: tek örnekli
 * kurulumda yeterlidir, çok örnekli dağıtımda Redis tabanlı bir depo gerekir.
 * `globalThis` üzerinde: geliştirme modunda modül yeniden yüklenince sıfırlanmasın.
 */
const g = globalThis as unknown as { __avRate?: RateLimiter };
const limiter = (g.__avRate ??= new RateLimiter());

/**
 * Önizleme panelleri uygulamayı bazen kökeni "null" olan kısıtlı bir iframe içinde açar.
 * Bu durumda tarayıcı aynı sunucuya giden API isteklerini bile "farklı köken" sayar ve engeller
 * (ölçüm kaydı, rapor, çalışma listesi sessizce çalışmaz). Yalnızca iki köken kabul edilir:
 * uygulamanın kendi kökeni ve sandbox iframe'in "null" kökeni — üçüncü taraf siteler değil.
 */
function allowedOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (origin === "null") return "null";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (host && new URL(origin).host === host) return origin;
  } catch {
    /* geçersiz Origin */
  }
  return null;
}

/** Erişim anahtarı varken kapıdan önce geçmesi gereken yollar. */
function isPublic(pathname: string): boolean {
  if (
    pathname === "/api/health" ||
    pathname === "/giris" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/setup" ||
    pathname === "/favicon.ico"
  ) {
    return true;
  }
  return (
    pathname.startsWith("/_next/") ||
    // Statik çözücü kaynakları (JS + WASM) kimlik kapısının dışındadır: herkese açık
    // kütüphanelerdir, hasta verisi taşımazlar ve önizleme iframe'inden de yüklenir.
    pathname.startsWith("/codecs/") ||
    pathname.startsWith("/wasm/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/downloads/")
  );
}

/** İsteğin kendi kökeni (ters vekil arkasında x-forwarded-host ile). */
function selfOrigin(req: NextRequest): string | null {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return null;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // ── 1) Hız sınırı: API uçlarında IP (ve oturum varsa kullanıcı) bazlı ──
  // `AV_RATE_LIMIT=off` testler/ölçüm için kapatır (varsayılan: açık).
  const rule = process.env.AV_RATE_LIMIT === "off" ? null : ruleFor(path, req.method);
  if (rule) {
    const r = limiter.hit(clientKey(req.headers), rule.rule);
    if (!r.ok) {
      return NextResponse.json(
        { error: `Çok fazla istek (${rule.name}). ${r.retryAfterSec} sn sonra deneyin.`, retryAfter: r.retryAfterSec },
        {
          status: 429,
          headers: {
            "Retry-After": String(r.retryAfterSec),
            "X-RateLimit-Limit": String(r.limit),
            "X-RateLimit-Remaining": "0",
            "Cache-Control": "no-store",
          },
        },
      );
    }
  }

  // ── 2) CSRF: durum değiştiren API istekleri ──
  if (path.startsWith("/api/") && isStateChanging(req.method)) {
    const csrf = checkCsrf({ method: req.method, headers: req.headers, selfOrigin: selfOrigin(req) });
    if (!csrf.ok) {
      return NextResponse.json({ error: csrf.reason ?? "CSRF koruması", needsCsrfToken: !!csrf.needsToken }, { status: 403 });
    }
  }

  const origin = allowedOrigin(req);
  const cors: Record<string, string> = origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : {};

  // İsteğe bağlı erişim kapısı: ACCESS_TOKEN tanımlıysa sayfa istekleri /giris'e,
  // API istekleri 401 döner. Tanım yoksa davranış değişmez (demo).
  if (accessEnabled() && !isPublic(req.nextUrl.pathname) && !checkAccess(req)) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Kimlik doğrulama gerekli" }, { status: 401 });
    }
    const hedef = new URL("/giris", req.url);
    hedef.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(hedef, 303);
  }

  if (req.method === "OPTIONS") return new NextResponse(null, { status: origin ? 204 : 403, headers: cors });
  // ── 3) Sayfa/AI yanıtları: CSP (nonce) + X-Frame-Options ──
  // Next.js, inline bootstrap betiğine nonce eklemek için CSP'yi **istek**
  // başlıklarından okur; bu yüzden aynı politika isteğe de yazılır ki sayfadaki
  // nonce ile yanıt başlığındaki nonce birebir eşleşsin (eşleşmezse tarayıcı
  // tüm betikleri engeller — G1'de CSP bu yüzden geri çekilmişti).
  const belge = !path.startsWith("/_next/") && !path.startsWith("/codecs/") && !path.startsWith("/wasm/");
  const nonce = belge ? newCsrfToken().slice(0, 32) : "";
  const csp = belge ? buildCsp({ nonce, dev: process.env.NODE_ENV !== "production" }) : "";
  const requestHeaders = new Headers(req.headers);
  if (belge) {
    requestHeaders.set("x-csp-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
  }
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  if (belge) {
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("X-Frame-Options", "SAMEORIGIN");
    res.headers.set("x-csp-nonce", nonce);
  }

  // CSRF çerezini (çift gönderim jetonu) yoksa oluştur; HttpOnly DEĞİL çünkü
  // istemci aynı değeri `x-csrf-token` başlığında göndermek zorunda.
  if (!req.cookies.get(CSRF_COOKIE)) {
    res.cookies.set(CSRF_COOKIE, newCsrfToken(), {
      sameSite: "strict",
      secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
      path: "/",
      // Oturum süresince geçerli; oturum çereziyle birlikte ölür.
      httpOnly: false,
    });
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };

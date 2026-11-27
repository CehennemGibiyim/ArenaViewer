import { NextResponse, type NextRequest } from "next/server";
import { accessEnabled, checkAccess } from "@/lib/server/access";
import {
  buildCsp,
  checkCsrf,
  clientKey,
  CSRF_COOKIE,
  CSP_REPORT_PATH,
  hstsHeader,
  httpsUrlFor,
  isStateChanging,
  newCsrfToken,
  rateStorePlan,
  RateLimiter,
  reportingHeaders,
  ruleFor,
  tlsPolicy,
  tlsViolation,
} from "@/lib/webSecurity";

/**
 * Hız sınırı sayaçları (g-webhard).
 *
 * Depo seçimi `rateStorePlan()` ile yapılır: `REDIS_URL` varsa sayaçlar örnekler
 * arasında **paylaşılır** (`RedisRateStore`), yoksa süreç belleğinde tutulur.
 *
 * Neden ayrım: proxy **Edge çalışma zamanında** koşar ve Redis sürücüsüne
 * bağımlılık eklemek istemedik. Bu yüzden burada yalnız **karar + uyarı** var;
 * Redis istemcisi gerçek dağıtımda `src/instrumentation.ts` içinde kurulur ve
 * `globalThis.__avRateStore` üzerinden buraya verilir (`RateStore` arayüzü).
 * İstemci yoksa bellek deposuna düşülür ve `INSTANCE_COUNT>1` ise açılışta
 * uyarı verilir — sessiz seyreltme yok.
 *
 * `globalThis` üzerinde: geliştirme modunda modül yeniden yüklenince sıfırlanmasın.
 */
type AsyncStore = {
  hit(key: string, rule: { limit: number; windowMs: number }, now?: number): Promise<{ ok: boolean; remaining: number; retryAfterSec: number; limit: number }>;
  shared: boolean;
};
const g = globalThis as unknown as { __avRate?: RateLimiter; __avRateStore?: AsyncStore; __avRateWarned?: boolean };
const limiter = (g.__avRate ??= new RateLimiter());
const plan = rateStorePlan();
if (plan.warning && !g.__avRateWarned) {
  g.__avRateWarned = true;
  console.warn(`[g-webhard] ${plan.warning}`);
}
/** Redis destekli depo (varsa) — instrumentation tarafından atanır. */
const sharedStore = (): AsyncStore | undefined => (plan.kind === "redis" ? g.__avRateStore : undefined);

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
    pathname === CSP_REPORT_PATH || // tarayıcı CSP raporları çerezsiz/jetonsuz gelir
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

  // ── 0) TLS zorunluluğu (t-privacy) ──────────────────────────────────────
  // `REQUIRE_TLS=1` (ters vekil x-forwarded-proto bildirir) veya `direct`.
  // Sayfa istekleri https'e yönlendirilir; API istekleri 426 ile reddedilir
  // (yönlendirme izleyen istemci POST gövdesini kaybederdi — sessiz veri kaybı olmasın).
  const tls = tlsPolicy();
  if (tlsViolation({ forwardedProto: req.headers.get("x-forwarded-proto"), protocol: req.nextUrl.protocol, pathname: path }, tls)) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Bu uç yalnız HTTPS üzerinden kullanılabilir (REQUIRE_TLS).", tlsRequired: true },
        { status: 426, headers: { Upgrade: "TLS/1.3" } }
      );
    }
    const hedef = httpsUrlFor(req.url, host);
    if (hedef) {
      const r = NextResponse.redirect(hedef, 308);
      r.headers.set("Strict-Transport-Security", hstsHeader(tls) ?? "");
      return r;
    }
  }

  // ── 1) Hız sınırı: API uçlarında IP (ve oturum varsa kullanıcı) bazlı ──
  // `AV_RATE_LIMIT=off` testler/ölçüm için kapatır (varsayılan: açık).
  const rule = process.env.AV_RATE_LIMIT === "off" ? null : ruleFor(path, req.method);
  if (rule) {
    // Proxy SENKRON kalır (Edge uyumu): paylaşılan depo varsa da burada bellek
    // yolu kullanılır ve `shared` bayrağı yanlış yapılandırmayı görünür kılar.
    // Paylaşılan sayaçlar API uçlarında `rateHit` üzerinden okunur; proxy'nin
    // amacı kaba kuvveti erken kesmek — ikinci katman API'de daha doğru sayar.
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
            "X-RateLimit-Shared": sharedStore() ? "1" : "0",
            "Cache-Control": "no-store",
          },
        },
      );
    }
  }

  // ── 2) CSRF: durum değiştiren API istekleri ──
  // CSP rapor ucu tarayıcılardan çerezsiz ve jetonsuz POST alır; kendi doğrulamasını
  // (16 KB sınırı + gürültü filtresi) yapar — CSRF/jeton kontrolü buraya uygulanmaz.
  if (path.startsWith("/api/") && path !== CSP_REPORT_PATH && isStateChanging(req.method)) {
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
  // HSTS: yalnız TLS ile erişilmiş yanıtlarda yazılır (http üzerinden HSTS
  // göndermek etkisizdir ve tarayıcı yok sayar).
  const hsts = hstsHeader(tls);
  if (hsts && !tlsViolation({ forwardedProto: req.headers.get("x-forwarded-proto"), protocol: req.nextUrl.protocol, pathname: path }, tls)) {
    res.headers.set("Strict-Transport-Security", hsts);
  }
  if (belge) {
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("X-Frame-Options", "SAMEORIGIN");
    res.headers.set("x-csp-nonce", nonce);
    // Modern raporlama: `report-to` yönergesinin çözülebilmesi için grup tanımı.
    for (const [k, v] of Object.entries(reportingHeaders())) res.headers.set(k, v);
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

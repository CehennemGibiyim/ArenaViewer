import { NextResponse, type NextRequest } from "next/server";
import { accessEnabled, checkAccess } from "@/lib/server/access";

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
    pathname === "/favicon.ico"
  ) {
    return true;
  }
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/codecs/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/downloads/")
  );
}

export function proxy(req: NextRequest) {
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
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };

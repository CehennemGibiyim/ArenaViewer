import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, accessEnabled, checkToken } from "@/lib/server/access";

export const dynamic = "force-dynamic";

/** /giris sayfasından gelen tek erişim anahtarını doğrular ve oturum çerezi yazar. */
export async function POST(req: NextRequest) {
  if (!accessEnabled()) {
    return NextResponse.json({ error: "Kimlik yapılandırılmadı (ACCESS_TOKEN tanımlı değil)" }, { status: 503 });
  }
  const b = (await req.json().catch(() => null)) as { token?: string } | null;
  const token = typeof b?.token === "string" ? b.token.trim() : "";
  if (!token || !checkToken(token)) {
    return NextResponse.json({ error: "Geçersiz erişim anahtarı" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

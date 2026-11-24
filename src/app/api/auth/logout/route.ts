import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/lib/server/access";

export const dynamic = "force-dynamic";

/** Oturum çerezini siler (erişim anahtarı tanımlıysa bir sonraki istek /giris'e düşer). */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

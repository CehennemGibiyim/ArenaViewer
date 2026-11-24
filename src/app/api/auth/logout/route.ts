import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/lib/server/access";
import { SESSION_COOKIE } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Oturum ve erişim çerezlerini siler. */
export async function POST(_req: NextRequest) {
  void _req;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

/** Şu anki oturumun kim olduğunu bildirir (istemci üst çubukta adı gösterebilir). */
export async function GET(req: NextRequest) {
  const { sessionUserId } = await import("@/lib/server/session");
  const { getUserById } = await import("@/lib/server/auth");
  const uid = sessionUserId(req);
  const u = await getUserById(uid);
  return NextResponse.json({ uid, user: u });
}

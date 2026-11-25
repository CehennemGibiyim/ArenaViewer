import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/lib/server/access";
import { audit } from "@/lib/server/audit";
import { currentUser } from "@/lib/server/auth";
import { SESSION_COOKIE, sessionFromRequest } from "@/lib/server/session";
import { revokeSession } from "@/lib/server/sessionStore";

export const dynamic = "force-dynamic";

/**
 * Oturum ve erişim çerezlerini siler.
 * Sunucu taraflı oturum kaydı varsa o kayıt da **iptal edilir**; böylece çerez
 * kopyalanmış olsa bile (ör. paylaşılan bilgisayar) yeniden kullanılamaz.
 */
export async function POST(req: NextRequest) {
  const payload = sessionFromRequest(req);
  if (payload?.sid) {
    try {
      const revoked = await revokeSession(payload.sid, payload.uid);
      if (revoked) {
        const user = await currentUser(req);
        await audit(user ?? { id: payload.uid, username: "" }, "auth.logout", "user", payload.uid, { session: payload.sid.slice(0, 6) });
      }
    } catch {
      /* denetim/iptal yazılamasa da çerez silinir */
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

/** Şu anki oturumun kim olduğunu bildirir (istemci üst çubukta adı gösterebilir). */
export async function GET(req: NextRequest) {
  const { getUserById } = await import("@/lib/server/auth");
  const payload = sessionFromRequest(req);
  const u = await getUserById(payload?.uid ?? null);
  return NextResponse.json({ uid: payload?.uid ?? null, user: u });
}

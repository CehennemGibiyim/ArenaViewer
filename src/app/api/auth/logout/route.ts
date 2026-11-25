import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/lib/server/access";
import { currentUser } from "@/lib/server/auth";
import { SESSION_COOKIE, sessionRef } from "@/lib/server/session";
import { revokeSession, sessionOwner } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * Oturum ve erişim çerezlerini siler.
 *
 * Çerezde sunucu oturum kimliği varsa kayıt da iptal edilir: kopyalanmış bir
 * çerez sunucuda artık geçerli olmaz. Kayıt başkasına aitse dokunulmaz
 * (çerez imzalı olduğundan pratikte olmaz; yine de savunmalı davranıyoruz).
 */
export async function POST(req: NextRequest) {
  const ref = sessionRef(req);
  if (ref?.sid) {
    const owner = await sessionOwner(ref.sid);
    if (owner && owner.userId === ref.uid && !owner.revokedAt) await revokeSession(ref.sid, ref.uid);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

/** Şu anki oturumun kim olduğunu bildirir (istemci üst çubukta adı gösterebilir). */
export async function GET(req: NextRequest) {
  const user = await currentUser(req);
  return NextResponse.json({ uid: user?.id ?? null, user });
}

import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { SESSION_ID_RE, sessionRef } from "@/lib/server/session";
import { listSessions, revokeSession, revokeUserSessions, sessionOwner } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * AKTİF OTURUMLAR (w-auth).
 *
 * GET  — yönetici tüm etkin oturumları, diğer rolleri yalnız kendi oturumlarını
 *        görür. Yanıtta hangi satırın bu isteği yapan çerez olduğu (`current`)
 *        işaretlenir; oturum kimliği istemciye yalnız bu listede, kısaltılmadan
 *        değil tam olarak döner (iptal için gereklidir, zaten kullanıcının
 *        kendi kimliğiyle erişilebilen bir bilgidir).
 * DELETE ?id=<sid> — kendi oturumunu ya da (yönetici) herhangi bir oturumu iptal
 *        eder. `?all=1` kullanıcının kendi diğer oturumlarını kapatır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const isAdmin = a.user.role === "yonetici";
  const currentId = sessionRef(req)?.sid ?? "";
  const rows = await listSessions({ userId: isAdmin ? undefined : a.user.id });
  return NextResponse.json({
    all: isAdmin,
    currentId,
    sessions: rows.map((s) => ({
      id: s.id,
      userId: s.userId,
      username: s.username,
      fullName: s.fullName,
      role: s.role,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === currentId,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const url = new URL(req.url);
  const isAdmin = a.user.role === "yonetici";
  const currentId = sessionRef(req)?.sid ?? "";

  if (url.searchParams.get("all") === "1") {
    const n = await revokeUserSessions(a.user.id, a.user.id, currentId || undefined);
    await audit(a.user, "auth.session.revoke_all", "user", a.user.id, { count: n });
    return NextResponse.json({ ok: true, revoked: n });
  }

  const id = (url.searchParams.get("id") ?? "").trim();
  if (!SESSION_ID_RE.test(id)) return NextResponse.json({ error: "Geçersiz oturum kimliği" }, { status: 400 });

  const owner = await sessionOwner(id);
  if (!owner) return NextResponse.json({ error: "Oturum bulunamadı" }, { status: 404 });
  if (!isAdmin && owner.userId !== a.user.id) {
    return NextResponse.json({ error: "Bu oturumu sonlandırma yetkiniz yok" }, { status: 403 });
  }
  if (owner.revokedAt) return NextResponse.json({ ok: true, alreadyRevoked: true });
  const done = await revokeSession(id, a.user.id);
  if (!done) return NextResponse.json({ error: "Oturum iptal edilemedi" }, { status: 500 });
  await audit(a.user, "auth.session.revoke", "session", 0, { session: id.slice(0, 8), owner: owner.userId, self: owner.userId === a.user.id });
  return NextResponse.json({ ok: true, revoked: true });
}

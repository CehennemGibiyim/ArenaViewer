import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { toSessionView } from "@/lib/sessionPolicy";
import { listSessions, revokeAllForUser, sessionRowMatchesSid, sessionsSupported } from "@/lib/server/sessionStore";
import { sessionFromRequest } from "@/lib/server/session";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSessions, users } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Açık oturumlar (w-auth).
 *
 * GET   ?scope=own|all (varsayılan own), &history=1 süresi dolmuş/iptal edilmişleri de getirir.
 *       Yönetici `scope=all` ile tüm kullanıcıların oturumlarını görür.
 * POST  { action: "revoke", id }            → tek oturumu iptal (kendi oturumu; yönetici herhangi)
 *       { action: "revoke-others" }         → bu cihaz dışındaki tüm oturumlarımı kapat
 *       { action: "revoke-user", userId }   → yönetici: kullanıcının tüm oturumlarını kapat
 *       { action: "purge-expired" }         → yönetici: süresi dolmuş kayıtları (son 90 gün) sil
 *
 * Oturum kimliği (sid) asla döndürülmez; liste yalnız IP, istemci ve zaman taşır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  if (!(await sessionsSupported())) {
    return NextResponse.json({
      supported: false,
      sessions: [],
      note: "Sunucu tarafı oturum kaydı için `user_sessions` tablosu gerekli: npx drizzle-kit push",
    });
  }
  const sp = new URL(req.url).searchParams;
  const wantAll = sp.get("scope") === "all";
  if (wantAll && a.user.role !== "yonetici") {
    return NextResponse.json({ error: "Tüm oturumları yalnız yönetici görebilir" }, { status: 403 });
  }
  const currentSid = sessionFromRequest(req)?.sid ?? null;
  const rows = await listSessions({
    userId: wantAll ? undefined : a.user.id,
    includeExpired: sp.get("history") === "1",
    limit: Number(sp.get("limit") ?? 100),
  });
  const now = Date.now();
  return NextResponse.json({
    supported: true,
    scope: wantAll ? "all" : "own",
    sessions: rows.map((r) =>
      toSessionView(
        { ...r, id: String(r.id) },
        // "Bu cihaz" işareti: çerezdeki sid'in hash'i satırdakiyle eşleşiyorsa.
        sessionRowMatchesSid(r, currentSid) ? String(r.id) : null,
        now
      )
    ),
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  if (!(await sessionsSupported())) {
    return NextResponse.json({ error: "Oturum kaydı tablosu yok (user_sessions). Şemayı uygulayın." }, { status: 503 });
  }
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: number; userId?: number };
  const action = b.action ?? "";
  const currentSid = sessionFromRequest(req)?.sid ?? null;

  if (action === "revoke") {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Oturum kimliği gerekli" }, { status: 400 });
    const row = (
      await db
        .select({ id: userSessions.id, userId: userSessions.userId, revokedAt: userSessions.revokedAt })
        .from(userSessions)
        .where(eq(userSessions.id, id))
        .limit(1)
    )[0];
    if (!row) return NextResponse.json({ error: "Oturum bulunamadı" }, { status: 404 });
    if (row.userId !== a.user.id && a.user.role !== "yonetici") {
      return NextResponse.json({ error: "Başkasının oturumunu kapatamazsınız" }, { status: 403 });
    }
    // Sid yerine satır no ile iptal: hash'ten geri dönüş yok, yönetici listesi id taşır.
    await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, id));
    const own = row.userId === a.user.id;
    await audit(a.user, own ? "auth.session_revoke" : "auth.session_revoke_other", "session", id, { userId: row.userId });
    return NextResponse.json({ ok: true, revoked: id });
  }

  if (action === "revoke-others") {
    if (!currentSid) return NextResponse.json({ error: "Geçerli oturum yok" }, { status: 400 });
    const n = await revokeAllForUser(a.user.id, currentSid);
    await audit(a.user, "auth.session_revoke_others", "user", a.user.id, { revoked: n });
    return NextResponse.json({ ok: true, revoked: n });
  }

  if (action === "revoke-user") {
    if (a.user.role !== "yonetici") return NextResponse.json({ error: "Yalnız yönetici" }, { status: 403 });
    const uid = Number(b.userId);
    if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: "Kullanıcı kimliği gerekli" }, { status: 400 });
    const target = (await db.select({ active: users.active, username: users.username }).from(users).where(eq(users.id, uid)).limit(1))[0];
    if (!target) return NextResponse.json({ error: "Kullanıcı bulunamadı" }, { status: 404 });
    const n = await revokeAllForUser(uid);
    await audit(a.user, "auth.session_revoke_user", "user", uid, { revoked: n, username: target.username });
    return NextResponse.json({ ok: true, revoked: n });
  }

  if (action === "purge-expired") {
    if (a.user.role !== "yonetici") return NextResponse.json({ error: "Yalnız yönetici" }, { status: 403 });
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const { and, lt } = await import("drizzle-orm");
    const del = await db
      .delete(userSessions)
      .where(and(lt(userSessions.expiresAt, cutoff), lt(userSessions.lastSeenAt, cutoff)))
      .returning({ id: userSessions.id });
    await audit(a.user, "auth.session_purge", "system", "", { deleted: del.length });
    return NextResponse.json({ ok: true, deleted: del.length });
  }

  return NextResponse.json({ error: "Bilinmeyen işlem" }, { status: 400 });
}

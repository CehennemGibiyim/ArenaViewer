import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { SESSION_ID_RE, SESSION_TTL_MS } from "./session";

/**
 * SUNUCU TARAFI OTURUM KAYITLARI.
 *
 * Amaç: "aktif oturum listesi" ve gerçek iptal. Çerez istemcide ne derse desin,
 * burada iptal edilmiş (revoked_at) ya da süresi geçmiş bir oturum kimliğiyle
 * gelen istek kimliksiz sayılır (bkz. auth.ts → currentUser).
 *
 * Kayıt oluşturma/iptal hataları giriş akışını kilitlememeli: liste okunamazsa
 * oturum yine geçerli sayılır (fail-open yalnızca DB arızasında; iptal edilmiş
 * satır okunabildiği sürece fail-closed davranış korunur).
 */
export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface SessionRow {
  id: string;
  userId: number;
  username: string;
  fullName: string;
  role: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string;
  userAgent: string;
}

/** Yeni rastgele oturum kimliği (32 hex). */
export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

/** Kullanıcı için oturum kaydı açar ve kimliğini döndürür. DB hatasında null. */
export async function createSession(userId: number, meta: SessionMeta = {}): Promise<string | null> {
  const id = newSessionId();
  const now = new Date();
  try {
    await db.insert(sessions).values({
      id,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ip: (meta.ip ?? "").slice(0, 64),
      userAgent: (meta.userAgent ?? "").slice(0, 240),
    });
    return id;
  } catch {
    return null;
  }
}

/** Oturum iptal edilmemiş ve süresi dolmamış mı? Okunamıyorsa true (DB arızası). */
export async function isSessionActive(sid: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sid)) return false;
  try {
    const row = (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sid), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
        .limit(1)
    )[0];
    return !!row;
  } catch {
    return true;
  }
}

/**
 * Son görülme zamanını günceller. Her istekte yazmamak için yalnız 60 saniyeden
 * eski kayıtlarda çalışır; hata yutulur (istek akışını etkilemez).
 */
export async function touchSession(sid: string): Promise<void> {
  if (!SESSION_ID_RE.test(sid)) return;
  try {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(sessions.id, sid), sql`${sessions.lastSeenAt} < now() - interval '60 seconds'`));
  } catch {
    /* son görülme güncellenemedi; oturum yine geçerli */
  }
}

/**
 * Oturum listesi. `userId` verilirse yalnız o kullanıcının; aksi halde tümü
 * (yönetici ekranı). Varsayılan olarak iptal edilmiş/süresi geçmiş satırlar
 * `includeInactive` ile isteğe bağlı gelir.
 */
export async function listSessions(opts: { userId?: number; includeInactive?: boolean; limit?: number } = {}): Promise<SessionRow[]> {
  const conds = [];
  if (opts.userId != null) conds.push(eq(sessions.userId, opts.userId));
  if (!opts.includeInactive) {
    conds.push(isNull(sessions.revokedAt));
    conds.push(gt(sessions.expiresAt, new Date()));
  }
  try {
    return await db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        username: users.username,
        fullName: users.fullName,
        role: users.role,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(sessions.lastSeenAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  } catch {
    return [];
  }
}

/** Tek oturumun sahibini döndürür (yetki kontrolü için); yoksa null. */
export async function sessionOwner(sid: string): Promise<{ userId: number; revokedAt: Date | null } | null> {
  if (!SESSION_ID_RE.test(sid)) return null;
  try {
    const row = (
      await db.select({ userId: sessions.userId, revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, sid)).limit(1)
    )[0];
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Oturumu iptal eder. `actorUserId` denetim izi içindir (kendi oturumunu
 * kapatan kullanıcı ya da yönetici). Zaten iptal edilmişse false döner.
 */
export async function revokeSession(sid: string, actorUserId: number | null): Promise<boolean> {
  if (!SESSION_ID_RE.test(sid)) return false;
  try {
    const rows = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedBy: actorUserId })
      .where(and(eq(sessions.id, sid), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Kullanıcının tüm etkin oturumlarını iptal eder; `exceptSid` (varsa) korunur. */
export async function revokeUserSessions(userId: number, actorUserId: number | null, exceptSid?: string): Promise<number> {
  try {
    const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSid) conds.push(ne(sessions.id, exceptSid));
    const rows = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedBy: actorUserId })
      .where(and(...conds))
      .returning({ id: sessions.id });
    return rows.length;
  } catch {
    return 0;
  }
}

import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { loginAttempts, userSessions, users } from "@/db/schema";
import { describeClient, lockPolicyFromEnv, lockState, type AttemptRow } from "@/lib/sessionPolicy";

/**
 * SUNUCU TARAFLI OTURUM KAYDI.
 *
 * Çerezde yalnızca rastgele `sid` taşınır; kayıt burada tutulur. İptal edilen
 * oturum, çerez süresi dolmamış olsa bile kabul edilmez.
 *
 * Tablo yoksa (şema henüz uygulanmamış eski kurulum) oturum kaydı **kapalı**
 * sayılır ve eski davranış (yalnız imzalı çerez) korunur; böylece yükseltme
 * sırasında kimse kilitlenmez.
 */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Oturum kimliği: 32 bayt rastgele → base64url (43 karakter). */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

let tableReady: boolean | null = null;

/** user_sessions tablosu var mı? (yalnız bir kez sorulur) */
export async function sessionsSupported(): Promise<boolean> {
  if (tableReady !== null) return tableReady;
  try {
    await db.execute(sql`select 1 from user_sessions limit 1`);
    tableReady = true;
  } catch {
    tableReady = false;
  }
  return tableReady;
}

/** Test/şema değişikliği sonrası önbelleği sıfırlar. */
export function resetSessionTableCache(): void {
  tableReady = null;
}

export interface CreateSessionInput {
  userId: number;
  ttlMs: number;
  ip?: string;
  userAgent?: string;
}

export interface CreatedSession {
  id: string;
  expiresAt: Date;
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession | null> {
  if (!(await sessionsSupported())) return null;
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + input.ttlMs);
  await db.insert(userSessions).values({
    idHash: sha256(id),
    userId: input.userId,
    expiresAt,
    ip: (input.ip ?? "").slice(0, 64),
    userAgent: describeClient({ userAgent: input.userAgent }),
  });
  return { id, expiresAt };
}

export interface SessionCheck {
  ok: boolean;
  reason?: "yok" | "iptal" | "suresi-dolmus" | "kullanici-yok";
  userId?: number;
}

/** Çerezdeki sid'i doğrular; her kullanımda son görülme zamanını tazeler. */
export async function checkSession(sid: string | undefined | null, userId: number | null): Promise<SessionCheck> {
  if (!sid || !(await sessionsSupported())) return { ok: true }; // kayıt yok → eski davranış
  const row = (
    await db
      .select({ id: userSessions.id, userId: userSessions.userId, expiresAt: userSessions.expiresAt, revokedAt: userSessions.revokedAt })
      .from(userSessions)
      .where(eq(userSessions.idHash, sha256(sid)))
      .limit(1)
  )[0];
  if (!row) return { ok: false, reason: "yok" };
  if (row.revokedAt) return { ok: false, reason: "iptal" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "suresi-dolmus" };
  if (userId != null && row.userId !== userId) return { ok: false, reason: "yok" };
  // 60 saniyede bir tazele: her istekte yazmak gereksiz.
  await db
    .update(userSessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(userSessions.id, row.id), lt(userSessions.lastSeenAt, new Date(Date.now() - 60_000))));
  return { ok: true, userId: row.userId };
}

/** Oturumu iptal eder; `userOnly` verilirse yalnız o kullanıcının oturumu. */
export async function revokeSession(sid: string, userOnly?: number): Promise<boolean> {
  if (!(await sessionsSupported())) return false;
  const where = userOnly
    ? and(eq(userSessions.idHash, sha256(sid)), eq(userSessions.userId, userOnly))
    : eq(userSessions.idHash, sha256(sid));
  const res = await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(where, isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  return res.length > 0;
}

/** Kullanıcının tüm açık oturumlarını kapatır; `exceptCurrent` sid korunur. */
export async function revokeAllForUser(userId: number, exceptSid?: string): Promise<number> {
  if (!(await sessionsSupported())) return 0;
  const exceptHash = exceptSid ? sha256(exceptSid) : "";
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userSessions.userId, userId),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date()),
        exceptHash ? sql`${userSessions.idHash} <> ${exceptHash}` : sql`true`
      )
    )
    .returning({ id: userSessions.id });
  return rows.length;
}

/** Çerezdeki sid bu satıra mı ait? ("Bu cihaz" işareti) */
export function sessionRowMatchesSid(row: { idHash: string }, sid: string | null | undefined): boolean {
  return !!sid && row.idHash === sha256(sid);
}

/** Sid'in hash'i (dışa verilmez; yalnız karşılaştırma). */
export function hashSessionId(sid: string): string {
  return sha256(sid);
}

export interface SessionListRow {
  id: number;
  /** Oturum kimliğinin SHA-256'sı — yalnız "bu cihaz" karşılaştırması için kullanılır, dışarı verilmez. */
  idHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string;
  userAgent: string;
  userId: number;
  username: string;
  fullName: string;
  role: string;
}

/** Bir kullanıcının (veya tüm kullanıcıların) oturumları — yeniden eskiye. */
export async function listSessions(opts: { userId?: number; includeExpired?: boolean; limit?: number }): Promise<SessionListRow[]> {
  if (!(await sessionsSupported())) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [];
  if (opts.userId) conds.push(eq(userSessions.userId, opts.userId));
  if (!opts.includeExpired) conds.push(gt(userSessions.expiresAt, new Date()));
  const q = db
    .select({
      id: userSessions.id,
      idHash: userSessions.idHash,
      createdAt: userSessions.createdAt,
      lastSeenAt: userSessions.lastSeenAt,
      expiresAt: userSessions.expiresAt,
      revokedAt: userSessions.revokedAt,
      ip: userSessions.ip,
      userAgent: userSessions.userAgent,
      userId: userSessions.userId,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .orderBy(desc(userSessions.lastSeenAt))
    .limit(limit);
  return conds.length ? q.where(and(...conds)) : q;
}

/** Oturum kimliği → kullanıcı (çerez doğrulaması için tek sorgu). */
export async function sessionUserBySid(sid: string): Promise<{ userId: number } | null> {
  if (!(await sessionsSupported())) return null;
  const row = (
    await db
      .select({ userId: userSessions.userId })
      .from(userSessions)
      .where(and(eq(userSessions.idHash, sha256(sid)), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())))
      .limit(1)
  )[0];
  return row ?? null;
}

// ───────────── Giriş denemeleri / kilitleme ─────────────

export async function recordAttempt(username: string, ip: string, ok: boolean, reason = ""): Promise<void> {
  try {
    await db.insert(loginAttempts).values({ username: (username ?? "").slice(0, 80), ip: (ip ?? "").slice(0, 64), ok, reason: reason.slice(0, 120) });
  } catch {
    /* deneme kaydı yazılamazsa giriş engellenmez (kilit yalnız savunma katmanı) */
  }
}

/** Son penceredeki denemeler (kilitleme kararı için). */
export async function recentAttempts(username: string, windowMs: number): Promise<AttemptRow[]> {
  try {
    const since = new Date(Date.now() - windowMs);
    return await db
      .select({ at: loginAttempts.at, ok: loginAttempts.ok })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.username, (username ?? "").slice(0, 80)), gt(loginAttempts.at, since)))
      .orderBy(asc(loginAttempts.at));
  } catch {
    return [];
  }
}

/** Giriş öncesi kilit kontrolü. */
export async function loginLocked(username: string): Promise<{ locked: boolean; retryAfterSec: number; failures: number }> {
  const policy = lockPolicyFromEnv();
  const rows = await recentAttempts(username, policy.windowMs);
  const s = lockState(rows, Date.now(), policy);
  return { locked: s.locked, retryAfterSec: s.retryAfterSec, failures: s.failures };
}

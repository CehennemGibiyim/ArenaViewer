/**
 * Oturum kaydı politikası — saf, test edilebilir mantık (sunucudan bağımsız).
 *
 * Amaç (kıyaslama: w-auth / f-kimlik-rbac, P0): oturumlar artık yalnızca imzalı
 * çerezde değil, **sunucu tarafında bir kayıt** olarak tutulur. Böylece
 *  - kullanıcı kendi açık oturumlarını listeleyip iptal edebilir,
 *  - yönetici tüm açık oturumları görüp gerektiğinde sonlandırabilir,
 *  - çalınmış/istenmeyen bir çerez `revoked_at` yazıldığı anda geçersizleşir,
 *  - hesap kilitleme (çok sayıda hatalı giriş) sunucuda uygulanır.
 *
 * Bu dosya yalnızca **karar** üretir; veritabanı erişimi `server/session.ts`'te.
 */

/** Çerezde taşınan oturum kimliği biçimi: base64url, 22–64 karakter. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Oturum süresi (ms). 8 saat: nöbet boyunca çalışır, ertesi gün yeniden giriş.
 * `SESSION_MAX_AGE_SECONDS` ile ortamdan değiştirilebilir (1 saat – 7 gün).
 */
export function sessionTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.SESSION_MAX_AGE_SECONDS ?? "");
  const sec = Number.isFinite(raw) && raw >= 3600 && raw <= 604800 ? raw : 8 * 60 * 60;
  return sec * 1000;
}

export interface SessionRecordView {
  id: string;
  userId: number;
  username: string;
  fullName: string;
  role: string;
  createdAt: Date | string;
  lastSeenAt: Date | string;
  expiresAt: Date | string;
  revokedAt?: Date | string | null;
  ip: string;
  userAgent: string;
}

export type SessionState = "aktif" | "suresi-dolmus" | "iptal-edilmis";

export function sessionState(row: Pick<SessionRecordView, "expiresAt" | "revokedAt">, now = Date.now()): SessionState {
  if (row.revokedAt) return "iptal-edilmis";
  const exp = typeof row.expiresAt === "string" ? Date.parse(row.expiresAt) : row.expiresAt.getTime();
  return Number.isFinite(exp) && exp > now ? "aktif" : "suresi-dolmus";
}

/**
 * Oturumun kullanılabilir olup olmadığı. İptal edilmiş veya süresi dolmuş oturum
 * hiçbir istekte kabul edilmez (imza geçerli olsa bile).
 */
export function sessionUsable(row: Pick<SessionRecordView, "expiresAt" | "revokedAt">, now = Date.now()): boolean {
  return sessionState(row, now) === "aktif";
}

/** İstemci parmak izi: kullanıcı ajanı kısaltılır; çerez/URL gibi sırlar saklanmaz. */
export function describeClient(headers: { userAgent?: string | null }): string {
  const ua = (headers.userAgent ?? "").trim();
  if (!ua) return "bilinmeyen istemci";
  // Tarayıcı adı + ana sürüm: uzun UA dizeleri denetim tablosunu şişirmesin.
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0] ??
    /Firefox\/(\d+)/.exec(ua)?.[0] ??
    /Chrome\/(\d+)/.exec(ua)?.[0] ??
    /Version\/(\d+).*Safari/.exec(ua)?.[0] ??
    ua.slice(0, 40);
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ").slice(0, 120);
}

/**
 * Oturum listesinde "bu cihaz" işareti için: işaretlenen kayıtla aynı olan mı?
 * (Kimlik karşılaştırması sabit zamanlı olmak zorunda değil; sır değil.)
 */
export function isCurrentSession(row: { id: string }, currentId: string | null | undefined): boolean {
  return !!currentId && row.id === currentId;
}

/** Oturum kaydının kullanıcıya gösterilecek güvenli özeti (sır/çerez yok). */
export function toSessionView(row: SessionRecordView, currentId?: string | null, now = Date.now()) {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    fullName: row.fullName,
    role: row.role,
    createdAt: iso(row.createdAt),
    lastSeenAt: iso(row.lastSeenAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    ip: row.ip,
    client: row.userAgent,
    state: sessionState(row, now),
    current: isCurrentSession(row, currentId),
  };
}

function iso(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

// ───────────── Hesap kilitleme (kaba kuvvet savunması) ─────────────

export interface LockPolicy {
  /** Bu süre içindeki başarısız girişler sayılır. */
  windowMs: number;
  /** Pencere içinde bu sayıya ulaşınca hesap kilitlenir. */
  maxFailures: number;
  /** Kilit süresi; süre dolunca sayaç sıfırlanır. */
  lockMs: number;
}

export const DEFAULT_LOCK: LockPolicy = {
  windowMs: 15 * 60 * 1000,
  maxFailures: 5,
  lockMs: 15 * 60 * 1000,
};

/** `LOGIN_LOCK_*` ortam değişkenlerinden politika (makul sınırlarla). */
export function lockPolicyFromEnv(env: Record<string, string | undefined> = process.env): LockPolicy {
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(env[k] ?? "");
    return Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  };
  return {
    windowMs: num("LOGIN_LOCK_WINDOW_MIN", 15, 1, 1440) * 60_000,
    maxFailures: num("LOGIN_LOCK_MAX_FAILURES", 5, 2, 100),
    lockMs: num("LOGIN_LOCK_MINUTES", 15, 1, 1440) * 60_000,
  };
}

export interface AttemptRow {
  at: Date | string;
  ok: boolean;
}

/**
 * Giriş denemelerine bakarak kilit kararı verir.
 * `lockedUntil` sütunu (varsa) "elle/otomatik kilit" bilgisini taşır; bu süre
 * dolmadan giriş reddedilir. Sayaç yalnızca penceredeki başarısız denemeleri sayar;
 * başarılı giriş pencereyi temizler.
 */
export function lockState(
  rows: readonly AttemptRow[],
  now = Date.now(),
  policy: LockPolicy = DEFAULT_LOCK
): { locked: boolean; retryAfterSec: number; failures: number; remaining: number } {
  const windowStart = now - policy.windowMs;
  const recent = rows.filter((r) => {
    const t = typeof r.at === "string" ? Date.parse(r.at) : r.at.getTime();
    return Number.isFinite(t) && t >= windowStart;
  });
  if (recent.some((r) => r.ok)) return { locked: false, retryAfterSec: 0, failures: 0, remaining: policy.maxFailures };
  const failures = recent.filter((r) => !r.ok).length;
  if (failures < policy.maxFailures) {
    return { locked: false, retryAfterSec: 0, failures, remaining: policy.maxFailures - failures };
  }
  const lastFail = Math.max(
    ...recent
      .filter((r) => !r.ok)
      .map((r) => (typeof r.at === "string" ? Date.parse(r.at) : r.at.getTime()))
  );
  const until = lastFail + policy.lockMs;
  return {
    locked: until > now,
    retryAfterSec: until > now ? Math.ceil((until - now) / 1000) : 0,
    failures,
    remaining: 0,
  };
}

/** Kilit mesajı: kaç dakika sonra yeniden deneneceği (kullanıcıya gösterilir). */
export function lockMessage(retryAfterSec: number): string {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Çok sayıda hatalı giriş nedeniyle hesap geçici olarak kilitlendi. ${min} dakika sonra yeniden deneyin.`;
}

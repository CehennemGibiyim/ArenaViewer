import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Role, UserInfo } from "@/lib/types";
import { hashPassword, verifyPassword } from "./passwords";
import { isLocked, lockRemainingMinutes, lockoutPolicy } from "./lockout";

/**
 * Kullanıcı hesapları: parola kurulumu, oturum ve TOTP ilkesi.
 *
 * `REQUIRE_TOTP_FOR_ROLES` (varsayılan "yonetici"): bu rollere sahip hesapların giriş
 * yapabilmesi için iki faktörlü doğrulama açık olmalıdır. Boş dize → zorunluluk yok.
 */
export function totpRequiredFor(role: Role): boolean {
  const raw = process.env.REQUIRE_TOTP_FOR_ROLES ?? "yonetici";
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(role);
}

export interface AccountRecord {
  id: number;
  username: string;
  passwordHash: string;
  fullName: string;
  title: string;
  regNo: string;
  role: Role;
  active: boolean;
  twoFactorSecret: string;
  twoFactorEnabled: boolean;
  /** Art arda başarısız giriş sayısı. */
  failedLoginCount: number;
  /** Kilit bitişi; null ise kilit yok. */
  lockedUntil: Date | null;
  /** Kurumsal kimlik bağlantısı (OIDC); boş dize = bağlı değil. */
  oidcIssuer?: string;
  oidcSubject?: string;
}

const selectAccount = () =>
  db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      fullName: users.fullName,
      title: users.title,
      regNo: users.regNo,
      role: users.role,
      active: users.active,
      twoFactorSecret: users.twoFactorSecret,
      twoFactorEnabled: users.twoFactorEnabled,
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
    })
    .from(users);
  // drizzle select sonucu rol alanı string; AccountRecord.tipine uyarlıyoruz.
  const toRec = (r: Omit<AccountRecord, "role"> & { role: string }): AccountRecord => ({ ...r, role: r.role as Role });

/** Hiç etkin kullanıcı var mı? (ilk kurulum kararı için) */
export async function hasAnyActiveUser(): Promise<boolean> {
  try {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
    return rows.length > 0;
  } catch {
    // Veritabanı henüz hazırsa kurulum sayfası yine açılmalı.
    return false;
  }
}

export async function findAccountByUsername(username: string): Promise<AccountRecord | null> {
  const u = (username ?? "").trim().toLocaleLowerCase("tr-TR");
  if (!u) return null;
  try {
    const row = (await selectAccount().where(eq(users.username, u)).limit(1))[0];
    return row ? toRec(row) : null;
  } catch {
    return null;
  }
}

export async function getAccountById(id: number): Promise<AccountRecord | null> {
  try {
    const row = (await selectAccount().where(eq(users.id, id)).limit(1))[0];
    return row ? toRec(row) : null;
  } catch {
    return null;
  }
}

/** Kullanıcı adı/parola doğrulaması; başarısızsa null. */
export async function authenticate(username: string, password: string): Promise<AccountRecord | null> {
  const acc = await findAccountByUsername(username);
  if (!acc || !acc.active) return null;
  if (!verifyPassword(password ?? "", acc.passwordHash)) return null;
  return acc;
}

/** Yalnız tüm kimlik doğrulama adımları ve imzalı oturum üretimi başarılıysa çağrılır. */
export async function recordSuccessfulLogin(id: number): Promise<void> {
  // Başarılı giriş sayacı ve olası süresi geçmiş kilidi temizler.
  await db.update(users).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, id));
}

/* ── Hesap kilitleme (w-auth) ────────────────────────────────────────────────
 *
 * Art arda `AUTH_LOCK_MAX_FAILURES` (varsayılan 5) başarısız denemeden sonra
 * hesap `AUTH_LOCK_MINUTES` (varsayılan 15) dakika kilitlenir. Sayaç başarılı
 * girişte sıfırlanır; yönetici kilidi elle açabilir. Kilit denetimi parola
 * doğrulamasından ÖNCE yapılır, böylece kilitliyken doğru parola da kabul
 * edilmez (kaba kuvvet denemesi zaman kazanamaz).
 */
export { lockoutPolicy };
export { isLocked, lockRemainingMinutes };

export type LoginOutcome =
  | { ok: true; account: AccountRecord }
  | { ok: false; kind: "unknown" | "inactive" }
  | { ok: false; kind: "locked"; lockedUntil: Date }
  | { ok: false; kind: "bad"; remaining: number; locked: false };

/** Başarısız bir denemeyi sayar; eşiğe ulaşıldıysa hesabı kilitler. */
export async function recordFailedAttempt(id: number): Promise<{ lockedUntil: Date | null; remaining: number }> {
  const { max, minutes } = lockoutPolicy();
  const now = new Date();
  const count = (
    await db
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, id))
      .returning({ n: users.failedLoginCount })
  )[0]?.n ?? 1;
  if (count >= max) {
    const until = new Date(now.getTime() + minutes * 60_000);
    await db.update(users).set({ lockedUntil: until }).where(eq(users.id, id));
    return { lockedUntil: until, remaining: 0 };
  }
  return { lockedUntil: null, remaining: Math.max(max - count, 0) };
}

/** Yönetici kilidi elle açar; sayaç da sıfırlanır. */
export async function unlockAccount(id: number): Promise<void> {
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, id));
}

/**
 * Kilitleme kurallarıyla parola doğrulaması.
 *
 * `authenticate` ile aynı sonucu verir ama kilit/sayaç durumunu da bildirir;
 * giriş ucu (login route) bunu kullanır.
 */
export async function attemptLogin(username: string, password: string): Promise<LoginOutcome> {
  const acc = await findAccountByUsername(username);
  if (!acc) return { ok: false, kind: "unknown" };
  if (!acc.active) return { ok: false, kind: "inactive" };
  if (isLocked(acc.lockedUntil)) return { ok: false, kind: "locked", lockedUntil: acc.lockedUntil! };
  if (!verifyPassword(password ?? "", acc.passwordHash)) {
    const r = await recordFailedAttempt(acc.id);
    if (r.lockedUntil) return { ok: false, kind: "locked", lockedUntil: r.lockedUntil };
    return { ok: false, kind: "bad", remaining: r.remaining, locked: false };
  }
  return { ok: true, account: acc };
}

export function toUserInfo(a: AccountRecord): UserInfo {
  return { id: a.id, username: a.username, fullName: a.fullName, title: a.title, regNo: a.regNo, role: a.role };
}

/** Parola kurma/inci denetim: en az 8 karakter, harf+räkäm karışımı değilse uyar. */
export function checkPasswordStrength(plain: string): { ok: boolean; reason?: string } {
  const p = plain ?? "";
  if (p.length < 8) return { ok: false, reason: "Parola en az 8 karakter olmalı." };
  if (p.length > 200) return { ok: false, reason: "Parola en fazla 200 karakter olabilir." };
  const hasLetter = /[a-zçğıöşüâîû]/i.test(p) || /[A-ZÇĞIİÖŞÜÂÎÛ]/.test(p);
  const hasDigit = /\d/.test(p);
  if (!hasLetter || !hasDigit) return { ok: false, reason: "Parola hem harf hem rakam içermeli." };
  return { ok: true };
}

export const makePasswordHash = hashPassword;

export async function setAccountPassword(id: number, plain: string): Promise<void> {
  await db.update(users).set({ passwordHash: hashPassword(plain) }).where(eq(users.id, id));
}

export async function setTwoFactor(id: number, secret: string, enabled: boolean): Promise<void> {
  await db.update(users).set({ twoFactorSecret: secret ?? "", twoFactorEnabled: !!enabled }).where(eq(users.id, id));
}

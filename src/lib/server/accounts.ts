import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Role, UserInfo } from "@/lib/types";
import { hashPassword, verifyPassword } from "./passwords";

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
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, acc.id));
  return acc;
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

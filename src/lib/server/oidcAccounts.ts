import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { AccountRecord } from "./accounts";
import { getAccountById } from "./accounts";
import type { MappedIdentity } from "./oidc";

/**
 * OIDC kimliği ↔ uygulama hesabı bağlantısı.
 *
 * Politika (bilinçli ve dar):
 *  1. Önce (issuer, subject) çiftiyle bağlı hesap aranır — kimliğin tek doğru eşi.
 *  2. Bağlı hesap yoksa ve `linkByEmail` açıksa, **e-posta doğrulanmış** kimlik
 *     için aynı kullanıcı adına sahip, henüz hiçbir OIDC kimliğine bağlı olmayan
 *     hesap devralınır (mevcut parolalı hesapların SSO'ya geçişi için).
 *  3. Aksi halde `autoProvision` açıksa yeni hesap açılır; kapalıysa giriş reddedilir.
 *  4. Rol: yönetici grubundaki kimlik yöneticiye **yükseltilir**; otomatik
 *     düşürme yapılmaz (yönetici rolünü IdP'deki bir hatayla kaybetmesin).
 */
export interface ResolvedOidcAccount {
  account: AccountRecord;
  created: boolean;
  linked: boolean;
  roleUpgraded: boolean;
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
      oidcIssuer: users.oidcIssuer,
      oidcSubject: users.oidcSubject,
    })
    .from(users);

type Row = Awaited<ReturnType<typeof selectAccount>>[number];

const toRecord = (r: Row): AccountRecord => ({
  id: r.id,
  username: r.username,
  passwordHash: r.passwordHash,
  fullName: r.fullName,
  title: r.title,
  regNo: r.regNo,
  role: r.role as AccountRecord["role"],
  active: r.active,
  twoFactorSecret: r.twoFactorSecret,
  twoFactorEnabled: r.twoFactorEnabled,
  failedLoginCount: r.failedLoginCount,
  lockedUntil: r.lockedUntil,
  oidcIssuer: r.oidcIssuer,
  oidcSubject: r.oidcSubject,
});

export async function findAccountBySubject(issuer: string, subject: string): Promise<AccountRecord | null> {
  if (!issuer || !subject) return null;
  const row = (await selectAccount().where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject))).limit(1))[0];
  return row ? toRecord(row) : null;
}

export async function linkAccount(id: number, issuer: string, subject: string): Promise<void> {
  await db.update(users).set({ oidcIssuer: issuer, oidcSubject: subject }).where(eq(users.id, id));
}

export async function upgradeToAdmin(id: number): Promise<void> {
  await db.update(users).set({ role: "yonetici" }).where(eq(users.id, id));
}

/** Çakışmasız kullanıcı adı üretir: `ad`, `ad.oidc`, `ad.oidc2`, … */
async function uniqueUsername(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : i === 1 ? `${base}.oidc` : `${base}.oidc${i}`;
    const hit = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate.slice(0, 40))).limit(1);
    if (hit.length === 0) return candidate.slice(0, 40);
  }
  return `${base.slice(0, 32)}.${Date.now().toString(36).slice(-6)}`;
}

/** Kimliği hesaba çözer; gerekirse bağlar/açar. Kural ihlalinde açıklayıcı hata atar. */
export async function resolveOidcAccount(
  issuer: string,
  ident: MappedIdentity,
  opts: { autoProvision: boolean; linkByEmail: boolean }
): Promise<ResolvedOidcAccount> {
  let acc = await findAccountBySubject(issuer, ident.subject);
  let created = false;
  let linked = false;

  if (!acc && opts.linkByEmail && ident.emailVerified) {
    const byName = (
      await db.select({ id: users.id, oidcSubject: users.oidcSubject }).from(users).where(eq(users.username, ident.username)).limit(1)
    )[0];
    if (byName) {
      if (byName.oidcSubject && byName.oidcSubject !== ident.subject) {
        throw new Error("Bu kullanıcı adı başka bir kurumsal kimliğe bağlı");
      }
      await linkAccount(byName.id, issuer, ident.subject);
      acc = await getAccountById(byName.id);
      linked = true;
    }
  }

  if (!acc) {
    if (!opts.autoProvision) throw new Error("Bu kimlik için tanımlı hesap yok (OIDC_AUTO_PROVISION=0)");
    const username = await uniqueUsername(ident.username);
    const ins = await db
      .insert(users)
      .values({
        username,
        passwordHash: "-", // parolasız: giriş yalnız kurumsal kimlikle
        fullName: ident.fullName,
        title: "",
        regNo: "",
        role: ident.role,
        active: true,
        oidcIssuer: issuer,
        oidcSubject: ident.subject,
      })
      .returning({ id: users.id });
    acc = await getAccountById(ins[0].id);
    created = true;
  }

  if (!acc) throw new Error("Hesap oluşturulamadı");
  if (!acc.active) throw new Error("Hesap pasif");

  let roleUpgraded = false;
  if (ident.role === "yonetici" && acc.role !== "yonetici") {
    await upgradeToAdmin(acc.id);
    acc = { ...acc, role: "yonetici" };
    roleUpgraded = true;
  }
  return { account: acc, created, linked, roleUpgraded };
}

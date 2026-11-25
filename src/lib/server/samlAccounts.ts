import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { samlReplay, users } from "@/db/schema";
import { getAccountById, type AccountRecord } from "./accounts";
import type { SamlIdentity } from "./saml";

/**
 * SAML kimliği ↔ uygulama hesabı bağlantısı.
 *
 * Politika (LDAP/OIDC ile aynı çizgi, bilinçli olarak dar):
 *  1. Önce (IdP entityID, NameID) çiftiyle bağlı hesap aranır.
 *  2. Yoksa ve `linkByEmail` açıksa, **aynı kullanıcı adına** sahip ve hiçbir
 *     SAML kimliğine bağlı olmayan hesap devralınır. (SAML'de "doğrulanmış
 *     e-posta" kavramı yok; bu yüzden varsayılan KAPALI.)
 *  3. Aksi halde `autoProvision` açıksa hesap açılır; kapalıysa giriş reddedilir.
 *  4. Yönetici grubundaki kimlik yöneticiye yükseltilir; otomatik düşürme yok.
 *  5. Pasif hesap giriş yapamaz (IdP kimliği doğrulamış olsa bile).
 */
export interface ResolvedSamlAccount {
  account: AccountRecord;
  created: boolean;
  linked: boolean;
  roleUpgraded: boolean;
}

async function findLinked(issuer: string, nameId: string): Promise<AccountRecord | null> {
  const row = (
    await db.select({ id: users.id }).from(users).where(and(eq(users.samlIssuer, issuer), eq(users.samlNameId, nameId))).limit(1)
  )[0];
  return row ? getAccountById(row.id) : null;
}

async function uniqueUsername(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = (i === 0 ? base : i === 1 ? `${base}.saml` : `${base}.saml${i}`).slice(0, 40);
    const hit = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
    if (!hit.length) return candidate;
  }
  return `${base.slice(0, 32)}.${Date.now().toString(36).slice(-6)}`;
}

export async function resolveSamlAccount(
  identity: SamlIdentity,
  opts: { autoProvision: boolean; linkByEmail: boolean }
): Promise<ResolvedSamlAccount> {
  let acc = await findLinked(identity.issuer, identity.nameId);
  let created = false;
  let linked = false;

  if (!acc && opts.linkByEmail) {
    const row = (await db.select({ id: users.id, samlIssuer: users.samlIssuer }).from(users).where(eq(users.username, identity.username)).limit(1))[0];
    if (row) {
      if (row.samlIssuer && row.samlIssuer !== identity.issuer) throw new Error("Bu kullanıcı adı başka bir SAML kimliğine bağlı");
      if (!row.samlIssuer) {
        await db.update(users).set({ samlIssuer: identity.issuer, samlNameId: identity.nameId }).where(eq(users.id, row.id));
        linked = true;
      }
      acc = await getAccountById(row.id);
    }
  }

  if (!acc) {
    if (!opts.autoProvision) throw new Error("Bu SAML kimliği için tanımlı hesap yok (SAML_AUTO_PROVISION=0)");
    const username = await uniqueUsername(identity.username);
    const ins = await db
      .insert(users)
      .values({
        username,
        passwordHash: "-", // parola yalnız IdP'de; uygulamada tutulmaz
        fullName: identity.fullName || username,
        title: "",
        regNo: "",
        role: identity.role,
        active: true,
        samlIssuer: identity.issuer,
        samlNameId: identity.nameId,
      })
      .returning({ id: users.id });
    acc = await getAccountById(ins[0].id);
    created = true;
  }

  if (!acc) throw new Error("Hesap oluşturulamadı");
  if (!acc.active) throw new Error("Hesap pasif");

  let roleUpgraded = false;
  if (identity.role === "yonetici" && acc.role !== "yonetici") {
    await db.update(users).set({ role: "yonetici" }).where(eq(users.id, acc.id));
    acc = { ...acc, role: "yonetici" };
    roleUpgraded = true;
  }
  return { account: acc, created, linked, roleUpgraded };
}

/**
 * Assertion'ı tek kullanımlık olarak işaretler.
 * `false` → daha önce kullanılmış (replay): giriş reddedilir.
 */
export async function consumeAssertion(assertionId: string, notOnOrAfter: number): Promise<boolean> {
  const expires = new Date(Math.max(notOnOrAfter, Date.now()) + 60_000);
  try {
    const ins = await db.insert(samlReplay).values({ assertionId, expiresAt: expires }).returning({ id: samlReplay.id });
    return ins.length > 0;
  } catch {
    return false; // benzersizlik ihlali = replay (ya da DB hatası: güvenli taraf)
  }
}

/** Süresi geçmiş tek kullanım kayıtlarını siler (giriş akışında ara sıra çağrılır). */
export async function pruneReplay(now = Date.now()): Promise<void> {
  try {
    await db.delete(samlReplay).where(lt(samlReplay.expiresAt, new Date(now)));
  } catch {
    /* temizlik başarısız olsa da giriş akışı sürer */
  }
}

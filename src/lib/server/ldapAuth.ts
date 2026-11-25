import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Role } from "@/lib/types";
import { getAccountById, type AccountRecord } from "./accounts";
import { LdapConnection } from "./ldapClient";
import {
  buildFilter,
  fillTemplate,
  ldapConfig,
  ldapErrorText,
  inAdminGroup,
  escapeFilterValue,
  type LdapConfig,
} from "./ldap";
import { sanitizeUsername } from "./usernames";

/**
 * LDAP/AD ile kimlik doğrulama ve hesap eşleme.
 *
 * Akış (arama modu — servis hesabı tanımlıysa):
 *   1. Servis hesabıyla bind → kullanıcıyı filtreyle ara → DN + ad/e-posta/gruplar
 *   2. Kullanıcının DN'i ve PAROLASIYLA bind → parola doğrulanır
 * Doğrudan mod (`LDAP_USER_DN_TEMPLATE`): kullanıcı DN'i şablondan üretilir ve
 * doğrudan bind edilir; gruplar (varsa taban DN ile) kullanıcı yetkisiyle aranır.
 *
 * Boş parola hiç ağa çıkmadan reddedilir: LDAP'te boş parolalı simple bind
 * "unauthenticated bind" sayılabilir ve bazı sunucular başarı döndürür.
 */
export interface LdapIdentity {
  username: string;
  fullName: string;
  email: string;
  dn: string;
  groups: string[];
  role: Role;
}

export type LdapOutcome =
  | { ok: true; account: AccountRecord; created: boolean; linked: boolean; roleUpgraded: boolean; dn: string }
  | { ok: false; reason: "kapali" | "bicim" | "kimlik" | "hesap" | "sunucu"; detail?: string };

const first = (v: string[] | undefined): string => (v && v.length ? v[0] : "");

async function findAccountByLdapDn(dn: string): Promise<AccountRecord | null> {
  if (!dn) return null;
  const row = (await db.select({ id: users.id }).from(users).where(eq(users.ldapDn, dn)).limit(1))[0];
  return row ? getAccountById(row.id) : null;
}

function uniqueUsername(base: string): Promise<string> {
  return (async () => {
    for (let i = 0; i < 20; i++) {
      const candidate = (i === 0 ? base : i === 1 ? `${base}.ldap` : `${base}.ldap${i}`).slice(0, 40);
      const hit = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
      if (!hit.length) return candidate;
    }
    return `${base.slice(0, 32)}.${Date.now().toString(36).slice(-6)}`;
  })();
}

/**
 * Dizin kimliğini uygulama hesabına çözer.
 *  1. `ldap_dn` birebir eşleşmesi
 *  2. Aynı kullanıcı adına sahip, henüz bir dizin kimliğine bağlı olmayan hesap (devralma)
 *  3. `autoProvision` açıksa yeni hesap; kapalıysa reddet
 *  4. Yönetici grubu rolü yükseltir; otomatik düşürme yapılmaz.
 */
export async function resolveLdapAccount(
  ident: LdapIdentity,
  opts: { autoProvision: boolean }
): Promise<{ account: AccountRecord; created: boolean; linked: boolean; roleUpgraded: boolean }> {
  let acc = await findAccountByLdapDn(ident.dn);
  let created = false;
  let linked = false;

  if (!acc) {
    const byName = await db.select({ id: users.id, ldapDn: users.ldapDn }).from(users).where(eq(users.username, ident.username)).limit(1);
    const row = byName[0];
    if (row) {
      if (row.ldapDn && row.ldapDn !== ident.dn) throw new Error("Bu kullanıcı adı başka bir dizin kimliğine bağlı");
      if (!row.ldapDn) {
        await db.update(users).set({ ldapDn: ident.dn }).where(eq(users.id, row.id));
        linked = true;
      }
      acc = await getAccountById(row.id);
    }
  }

  if (!acc) {
    if (!opts.autoProvision) throw new Error("Bu dizin kimliği için tanımlı hesap yok (LDAP_AUTO_PROVISION=0)");
    const username = await uniqueUsername(ident.username);
    const ins = await db
      .insert(users)
      .values({
        username,
        passwordHash: "-", // parola yalnız dizinde; uygulamada tutulmaz
        fullName: ident.fullName || username,
        title: "",
        regNo: "",
        role: ident.role,
        active: true,
        ldapDn: ident.dn,
      })
      .returning({ id: users.id });
    acc = await getAccountById(ins[0].id);
    created = true;
  }

  if (!acc) throw new Error("Hesap oluşturulamadı");
  if (!acc.active) throw new Error("Hesap pasif");

  let roleUpgraded = false;
  if (ident.role === "yonetici" && acc.role !== "yonetici") {
    await db.update(users).set({ role: "yonetici" }).where(eq(users.id, acc.id));
    acc = { ...acc, role: "yonetici" };
    roleUpgraded = true;
  }
  return { account: acc, created, linked, roleUpgraded };
}

function identityFrom(cfg: LdapConfig, username: string, dn: string, attrs: Record<string, string[]>, groups: string[]): LdapIdentity {
  return {
    username: sanitizeUsername(username),
    fullName: (first(attrs[cfg.attrName.toLowerCase()]) || username).slice(0, 120),
    email: first(attrs[cfg.attrMail.toLowerCase()]),
    dn: dn.toLowerCase(),
    groups,
    role: inAdminGroup(groups, cfg.adminGroup) ? "yonetici" : cfg.defaultRole,
  };
}

/** Dizin sunucusunda parola doğrulaması + hesap eşleme. */
export async function ldapAuthenticate(rawUsername: string, password: string): Promise<LdapOutcome> {
  const cfg = ldapConfig();
  if (!cfg) return { ok: false, reason: "kapali" };
  const username = (rawUsername ?? "").trim();
  // Boş parola = anonim bind riski; ağa hiç çıkmadan reddet.
  if (!username || !password) return { ok: false, reason: "bicim" };

  const conn = new LdapConnection(cfg.url, cfg.timeoutMs);
  try {
    await conn.connect();
    let dn = "";
    let attrs: Record<string, string[]> = {};
    let groups: string[] = [];

    if (cfg.bindDn) {
      const svc = await conn.bind(cfg.bindDn, cfg.bindPassword);
      if (svc.code !== 0) return { ok: false, reason: "sunucu", detail: ldapErrorText(svc.code) };
      const found = await conn.search({
        base: cfg.baseDn,
        filter: buildFilter(cfg.userFilter, username),
        attributes: [cfg.attrName, cfg.attrMail, cfg.attrGroups],
      });
      if (found.code !== 0) return { ok: false, reason: "sunucu", detail: ldapErrorText(found.code) };
      if (!found.entries.length) return { ok: false, reason: "kimlik" };
      const entry = found.entries[0];
      dn = entry.dn;
      attrs = entry.attrs;
      groups = entry.attrs[cfg.attrGroups.toLowerCase()] ?? [];
      const userBind = await conn.bind(dn, password);
      if (userBind.code !== 0) return { ok: false, reason: "kimlik", detail: ldapErrorText(userBind.code) };
    } else {
      dn = fillTemplate(cfg.userDnTemplate, username);
      const userBind = await conn.bind(dn, password);
      if (userBind.code !== 0) return { ok: false, reason: "kimlik", detail: ldapErrorText(userBind.code) };
      // Grupları okumak için kullanıcı yetkisiyle kendi kaydını ara (başarısızsa
      // yönetici eşlemesi yapılmaz; giriş yine de çalışır).
      if (cfg.baseDn) {
        try {
          const found = await conn.search({
            base: cfg.baseDn,
            filter: `(&(objectClass=*)(|(sAMAccountName=${escapeFilterValue(username)})(uid=${escapeFilterValue(username)})(distinguishedName=${escapeFilterValue(dn)})))`,
            attributes: [cfg.attrName, cfg.attrMail, cfg.attrGroups],
          });
          if (found.entries.length) {
            attrs = found.entries[0].attrs;
            groups = found.entries[0].attrs[cfg.attrGroups.toLowerCase()] ?? [];
          }
        } catch {
          /* grup bilgisi alınamadı: giriş yine geçerli, rol varsayılan kalır */
        }
      }
    }

    const ident = identityFrom(cfg, username, dn, attrs, groups);
    const resolved = await resolveLdapAccount(ident, { autoProvision: cfg.autoProvision });
    return { ok: true, ...resolved, dn: ident.dn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "bilinmeyen hata";
    // "hesap" nedenli hatalar kullanıcıya hesap durumu olarak döner; ağ hataları sunucu.
    if (msg.includes("tanımlı hesap yok") || msg.includes("başka bir dizin") || msg.includes("Hesap pasif")) {
      return { ok: false, reason: "hesap", detail: msg };
    }
    return { ok: false, reason: "sunucu", detail: msg };
  } finally {
    conn.close();
  }
}

/**
 * LDAP / Active Directory bağlayıcısı — protokol çekirdeği (saf, ağ yok).
 *
 * Neden elle BER: LDAP için harici bağımlılık eklemek istemedik ve kullandığımız
 * alt küme küçük: BindRequest (simple), SearchRequest (equalityMatch/present),
 * BindResponse, SearchResultEntry/Done. Bu dosya DER/BER kodlama-çözme, ayar,
 * kaçış (RFC 4515/4514) ve sonuç yorumlamasını taşır; soket tarafı
 * `ldapClient.ts`, hesap eşleme `ldapAccounts.ts`.
 *
 * GÜVENLİK NOTU: boş parolayla "simple bind" LDAP'te **anonim** (unauthenticated)
 * bind olarak yorumlanabilir ve bazı sunucularda başarı döner. Bu yüzden boş
 * parola bu modülde hiç ağa çıkmadan reddedilir.
 *
 * Yapılandırma (ortam değişkenleri):
 *   LDAP_URL            zorunlu — ldap://host:389 | ldaps://host:636 (ldaps varsayılan doğrulamalı)
 *   LDAP_BASE_DN        arama tabanı (arama modunda zorunlu)
 *   LDAP_BIND_DN        servis hesabı (arama için); boşsa doğrudan kullanıcı bind'i
 *   LDAP_BIND_PASSWORD  servis hesabı parolası
 *   LDAP_USER_DN_TEMPLATE  ör. "uid={username},ou=people,dc=hastane,dc=local"
 *   LDAP_USER_FILTER    varsayılan "(|(sAMAccountName={username})(uid={username}))"
 *   LDAP_ATTR_NAME / LDAP_ATTR_MAIL / LDAP_ATTR_GROUPS   (cn / mail / memberOf)
 *   LDAP_ADMIN_GROUP    bu grubun DN'i (veya CN'i) yönetici yapar
 *   LDAP_DEFAULT_ROLE   varsayılan "radyolog"
 *   LDAP_AUTO_PROVISION "0" → yalnız önceden bağlanmış hesaplar
 *   LDAP_TIMEOUT_MS     varsayılan 5000
 */
import type { Role } from "@/lib/types";

const ROLES = new Set<Role>(["yonetici", "radyolog", "teknisyen"]);

export interface LdapConfig {
  url: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  userDnTemplate: string;
  userFilter: string;
  attrName: string;
  attrMail: string;
  attrGroups: string;
  adminGroup: string;
  defaultRole: Role;
  autoProvision: boolean;
  timeoutMs: number;
}

export function ldapConfig(env: NodeJS.ProcessEnv = process.env): LdapConfig | null {
  const url = (env.LDAP_URL ?? "").trim();
  if (!/^ldaps?:\/\//i.test(url)) return null;
  const baseDn = (env.LDAP_BASE_DN ?? "").trim();
  const template = (env.LDAP_USER_DN_TEMPLATE ?? "").trim();
  // Arama için taban DN ya da doğrudan bind için şablon gerekir.
  if (!baseDn && !template) return null;
  const role = (env.LDAP_DEFAULT_ROLE ?? "radyolog").trim() as Role;
  const timeout = Math.trunc(Number(env.LDAP_TIMEOUT_MS ?? 5000));
  return {
    url,
    baseDn,
    bindDn: (env.LDAP_BIND_DN ?? "").trim(),
    bindPassword: env.LDAP_BIND_PASSWORD ?? "",
    userDnTemplate: template,
    userFilter: (env.LDAP_USER_FILTER ?? "").trim() || "(|(sAMAccountName={username})(uid={username}))",
    attrName: (env.LDAP_ATTR_NAME ?? "").trim() || "cn",
    attrMail: (env.LDAP_ATTR_MAIL ?? "").trim() || "mail",
    attrGroups: (env.LDAP_ATTR_GROUPS ?? "").trim() || "memberOf",
    adminGroup: (env.LDAP_ADMIN_GROUP ?? "").trim(),
    defaultRole: ROLES.has(role) ? role : "radyolog",
    autoProvision: (env.LDAP_AUTO_PROVISION ?? "1") !== "0",
    timeoutMs: Number.isFinite(timeout) && timeout >= 500 ? Math.min(timeout, 30_000) : 5000,
  };
}

export function ldapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ldapConfig(env) !== null;
}

/* ── Kaçışlar ────────────────────────────────────────────────────────────── */

/** RFC 4515: filtre değerinde özel karakterleri kaçırır (enjeksiyonu kapatır). */
export function escapeFilterValue(v: string): string {
  return (v ?? "")
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

/** RFC 4514: DN bileşeninde özel karakterleri kaçırır. */
export function escapeDnValue(v: string): string {
  const s = (v ?? "").replace(/([,+"\\<>;=])/g, "\\$1");
  const leading = s.replace(/^[ #]/, (m) => `\\${m}`);
  return leading.replace(/(.) $/, "\\ ");
}

/** Şablondaki `{username}` (ve `{user}`) alanını kaçırılmış kullanıcı adıyla doldurur. */
export function fillTemplate(template: string, username: string): string {
  const v = escapeDnValue(username);
  return template.replace(/\{username\}|\{user\}/g, v);
}

/** Filtredeki kullanıcı adı alanını (kaçırılmış) doldurur. */
export function buildFilter(filter: string, username: string): string {
  return filter.replace(/\{username\}|\{user\}/g, escapeFilterValue(username));
}

/** DN karşılaştırması: boşluk/önek farklarını yok sayar, büyük/küçük harfe duyarsız. */
export function sameDn(a: string, b: string): boolean {
  const norm = (s: string) => (s ?? "").split(",").map((p) => p.trim().toLowerCase()).join(",");
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Grup listesinde yönetici grubu arar. `LDAP_ADMIN_GROUP` tam DN olabilir
 * (memberOf değerleriyle birebir) ya da yalnız CN adı (ör. "RAD-Yonetici") —
 * ikinci durumda DN'in ilk bileşenine bakılır.
 */
export function inAdminGroup(groups: string[], adminGroup: string): boolean {
  if (!adminGroup) return false;
  const want = adminGroup.trim();
  const wantIsDn = want.includes(",");
  return groups.some((g) => {
    if (sameDn(g, want)) return true;
    if (wantIsDn) return false;
    const first = g.split(",")[0]?.trim() ?? "";
    const value = first.includes("=") ? first.slice(first.indexOf("=") + 1).trim() : first;
    return value.toLowerCase() === want.toLowerCase();
  });
}

/* ── BER kodlama ─────────────────────────────────────────────────────────── */

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

/** İşaretli tamsayı (küçük değerler için yeterli, LDAP'ta kullanılan aralık). */
export function berInt(n: number): Buffer {
  const bytes: number[] = [];
  let v = Math.trunc(n);
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

export const berEnum = (n: number): Buffer => tlv(0x0a, berIntValue(n));
export const berBool = (b: boolean): Buffer => tlv(0x01, Buffer.from([b ? 0xff : 0]));
export const berStr = (s: string): Buffer => tlv(0x04, Buffer.from(s, "utf8"));
export const berSeq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));

function berIntValue(n: number): Buffer {
  const bytes: number[] = [];
  let v = Math.trunc(n);
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

/** LDAPMessage: SEQUENCE { messageID, protocolOp } */
export function ldapMessage(id: number, protocolOp: Buffer): Buffer {
  return berSeq(berInt(id), protocolOp);
}

/** BindRequest [APPLICATION 0]: version 3 + DN + simple parola. */
export function bindRequest(dn: string, password: string): Buffer {
  return tlv(0x60, Buffer.concat([berInt(3), berStr(dn), tlv(0x80, Buffer.from(password, "utf8"))]));
}

/** SearchRequest [APPLICATION 3]: wholeSubtree, tek istek sınırı yok. */
export function searchRequest(base: string, filter: Buffer, attributes: string[]): Buffer {
  return tlv(
    0x63,
    Buffer.concat([
      berStr(base),
      berEnum(2), // wholeSubtree
      berEnum(0), // neverDerefAliases
      berInt(0), // sizeLimit
      berInt(0), // timeLimit
      berBool(false),
      filter,
      berSeq(...attributes.map((a) => berStr(a))),
    ])
  );
}

/** equalityMatch [3] / present [7] filtreleri ve AND/OR [0]/[1]. */
export function equalityFilter(attr: string, value: string): Buffer {
  return tlv(0xa3, Buffer.concat([berStr(attr), berStr(value)]));
}
export function presentFilter(attr: string): Buffer {
  return tlv(0x87, Buffer.from(attr, "utf8"));
}
export function andFilter(...f: Buffer[]): Buffer {
  return tlv(0xa0, Buffer.concat(f));
}
export function orFilter(...f: Buffer[]): Buffer {
  return tlv(0xa1, Buffer.concat(f));
}

/**
 * Çok basit filtre ayrıştırıcısı: `(attr=value)`, `(&...)`, `(|...)` ve
 * `(attr=*)` (present). Üretimde kullandığımız varsayılan filtre ve yaygın
 * kurumsal filtreler bu alt kümede kalır; desteklenmeyen sözdizimi hata atar
 * (sessizce yanlış filtre göndermekten iyidir).
 */
export function parseFilter(src: string): Buffer {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`LDAP filtresi desteklenmiyor (${why}): ${src}`);
  };
  const group = (): Buffer => {
    if (src[i] !== "(") return fail("'(' bekleniyordu");
    i++;
    let f: Buffer;
    const op = src[i];
    if (op === "&" || op === "|") {
      i++;
      const parts: Buffer[] = [];
      while (src[i] === "(") parts.push(group());
      if (src[i] !== ")") return fail("')' bekleniyordu");
      i++;
      if (!parts.length) return fail("boş AND/OR");
      f = op === "&" ? andFilter(...parts) : orFilter(...parts);
      return f;
    }
    const eq = src.indexOf("=", i);
    const close = src.indexOf(")", i);
    if (eq < 0 || close < 0 || eq > close) return fail("attr=value bekleniyordu");
    const attr = src.slice(i, eq).trim();
    const raw = src.slice(eq + 1, close).trim();
    // Öznitelik adı katı doğrulanır: "(uid>=5)" gibi desteklenmeyen karşılaştırma
    // sessizce "uid>" özniteliğine dönüşmesin.
    if (!/^[A-Za-z][A-Za-z0-9.;-]*$/.test(attr)) return fail(`geçersiz öznitelik: ${attr}`);
    i = close + 1;
    f = raw === "*" ? presentFilter(attr) : equalityFilter(attr, raw);
    return f;
  };
  const f = group();
  if (i !== src.length) fail("artık karakter var");
  return f;
}

/* ── BER çözme ───────────────────────────────────────────────────────────── */

export interface Tlv {
  tag: number;
  value: Buffer;
  children: Tlv[];
}

/** Tek bir TLV'yi çözer; veri eksikse null (TCP parçası bekleniyor). */
export function readTlv(buf: Buffer, offset = 0): { node: Tlv; next: number } | null {
  if (buf.length < offset + 2) return null;
  const tag = buf[offset];
  let len = buf[offset + 1];
  let p = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) return null;
    if (buf.length < p + n) return null;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[p + k];
    p += n;
  }
  if (buf.length < p + len) return null;
  const value = buf.subarray(p, p + len);
  const constructed = (tag & 0x20) !== 0;
  const children: Tlv[] = [];
  if (constructed) {
    let q = 0;
    while (q < value.length) {
      const sub = readTlv(value, q);
      if (!sub) break;
      children.push(sub.node);
      q = sub.next;
    }
  }
  return { node: { tag, value, children }, next: p + len };
}

/** Sırayla tüm TLV'leri çözer (tamamlanmamış kuyruk `rest` olarak döner). */
export function readAll(buf: Buffer): { nodes: Tlv[]; rest: Buffer } {
  const nodes: Tlv[] = [];
  let offset = 0;
  for (;;) {
    const r = readTlv(buf, offset);
    if (!r) break;
    nodes.push(r.node);
    offset = r.next;
  }
  return { nodes, rest: buf.subarray(offset) };
}

export function decodeInt(node: Tlv): number {
  let v = 0;
  for (const b of node.value) v = v * 256 + b;
  return v;
}

export function decodeString(node: Tlv): string {
  return node.value.toString("utf8");
}

export interface LdapMessage {
  id: number;
  /** Protokol işleminin etiketi: 0x61 bindResponse, 0x64 entry, 0x65 done, 0x78 extended. */
  opTag: number;
  op: Tlv;
}

export function toMessage(node: Tlv): LdapMessage | null {
  if (node.tag !== 0x30 || node.children.length < 2) return null;
  return { id: decodeInt(node.children[0]), opTag: node.children[1].tag, op: node.children[1] };
}

/** Bind/Search sonuç kodu: 0 = başarı. */
export function resultCode(op: Tlv): number {
  const first = op.children[0];
  return first && first.tag === 0x0a ? decodeInt(first) : -1;
}

export function resultDiagnostic(op: Tlv): string {
  const d = op.children[2];
  return d && d.tag === 0x04 ? decodeString(d) : "";
}

export interface LdapEntry {
  dn: string;
  attrs: Record<string, string[]>;
}

export function toEntry(op: Tlv): LdapEntry | null {
  if (op.tag !== 0x64 || op.children.length < 2) return null;
  const dn = decodeString(op.children[0]);
  const attrs: Record<string, string[]> = {};
  const attrSeq = op.children[1];
  for (const a of attrSeq.children ?? []) {
    if (a.children.length < 2) continue;
    const name = decodeString(a.children[0]).toLowerCase();
    attrs[name] = a.children[1].children.map(decodeString);
  }
  return { dn, attrs };
}

/** Sunucunun döndürdüğü tanılama kodlarını kısa Türkçe metne çevirir. */
export function ldapErrorText(code: number): string {
  const map: Record<number, string> = {
    1: "LDAP işlemi hatalı",
    2: "LDAP protokol hatası",
    7: "LDAP kimlik doğrulaması reddedildi",
    8: "LDAP güçlü kimlik doğrulama gerekli",
    32: "Dizin kaydı bulunamadı",
    34: "Geçersiz DN",
    49: "Kullanıcı adı veya parola hatalı (dizin)",
    50: "Dizinde bu işlem için yetki yok",
    51: "Dizin meşgul",
    52: "Dizin erişilemiyor",
    53: "Dizin isteği reddetti (parola politikası olabilir)",
  };
  return map[code] ?? `LDAP hata kodu ${code}`;
}

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  attr,
  canonicalize,
  childNamed,
  childrenNamed,
  findFirst,
  localName,
  namespaceScope,
  parseXml,
  pathTo,
  textContent,
  XmlError,
  type XmlNode,
} from "./xmlC14n";
import { sanitizeUsername } from "./usernames";

/**
 * KURUMSAL KİMLİK — SAML 2.0 Service Provider (SP-initiated, HTTP-Redirect +
 * HTTP-POST binding).
 *
 * Modül bilinçli olarak SAF tutulur (DB/Next.js yok): yapılandırma, AuthnRequest,
 * imzalı durum çerezi, **XML imza doğrulaması** ve SAML yanıtının güvenlik
 * koşulları burada. Hesap eşleme `samlAccounts.ts`, uçlar `src/app/api/auth/saml`.
 *
 * Yapılandırma (ortam değişkenleri):
 *   SAML_IDP_SSO_URL      zorunlu — IdP SSO ucu (HTTP-Redirect binding)
 *   SAML_IDP_ENTITY_ID    zorunlu — Issuer olarak beklenen değer
 *   SAML_IDP_CERT         zorunlu — IdP imza sertifikası (PEM ya da base64 DER)
 *   SAML_ENTITY_ID        varsayılan "atikviewer-sp" (Audience olarak beklenir)
 *   SAML_ACS_URL          varsayılan: isteğin kökeninden /api/auth/saml/callback
 *   SAML_LABEL            giriş düğmesi etiketi
 *   SAML_ATTR_NAME/MAIL/GROUPS  talep adları (varsayılan displayName/mail/memberOf)
 *   SAML_NAME_ID_FORMAT   istenen NameID biçimi (varsayılan: e-posta adresi)
 *   SAML_ADMIN_GROUP / SAML_DEFAULT_ROLE / SAML_AUTO_PROVISION / SAML_LINK_BY_EMAIL
 *   SAML_SKIP_TOTP        "0" → SSO ile giren yönetici uygulama TOTP'si de ister
 *   SAML_CLOCK_SKEW_SEC   saat kayması toleransı (varsayılan 120, en çok 600)
 *   SAML_ALLOW_SHA1       "1" → SHA-1 imzalı yanıtlara izin (varsayılan: reddet)
 */
export type SamlRole = "radyolog" | "teknisyen" | "yonetici";

export interface SamlConfig {
  idpSsoUrl: string;
  idpEntityId: string;
  /** IdP imza sertifikası, PEM. */
  idpCertPem: string;
  entityId: string;
  acsUrl: string;
  label: string;
  attrName: string;
  attrMail: string;
  attrGroups: string;
  nameIdFormat: string;
  adminGroup: string;
  defaultRole: SamlRole;
  autoProvision: boolean;
  linkByEmail: boolean;
  skipTotp: boolean;
  clockSkewSec: number;
  allowSha1: boolean;
}

const ROLES = new Set<string>(["radyolog", "teknisyen", "yonetici"]);

/**
 * IdP imza anahtarını PEM'e normalize eder.
 *
 * IdP'ler genelde **yalın base64 DER sertifika** verir (metadata'dan kopyalanır);
 * bazı kurulumlarda doğrudan PEM sertifika ya da açık anahtar verilir. Üçü de
 * kabul edilir; geçersiz metin boş döner ve özellik kapalı sayılır.
 */
export function normalizeCertificate(raw: string): string {
  const text = (raw ?? "").replace(/\\n/g, "\n").trim();
  if (!text) return "";
  if (/-----BEGIN [A-Z ]+-----/.test(text)) return text;
  const b64 = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return "";
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function samlConfig(env: NodeJS.ProcessEnv = process.env): SamlConfig | null {
  const idpSsoUrl = (env.SAML_IDP_SSO_URL ?? "").trim();
  const idpEntityId = (env.SAML_IDP_ENTITY_ID ?? "").trim();
  const cert = normalizeCertificate(env.SAML_IDP_CERT ?? "");
  if (!idpSsoUrl || !idpEntityId || !cert) return null;
  if (!/^https?:\/\//i.test(idpSsoUrl) || !/^https?:\/\//i.test(idpEntityId)) return null;
  try {
    createPublicKey(cert);
  } catch {
    return null; // bozuk sertifika: özellik kapalı (yarı çalışır durumda bırakma)
  }
  const role = (env.SAML_DEFAULT_ROLE ?? "radyolog").trim();
  const skew = Number.parseInt(env.SAML_CLOCK_SKEW_SEC ?? "", 10);
  return {
    idpSsoUrl,
    idpEntityId,
    idpCertPem: cert,
    entityId: (env.SAML_ENTITY_ID ?? "atikviewer-sp").trim() || "atikviewer-sp",
    acsUrl: (env.SAML_ACS_URL ?? "").trim(),
    label: (env.SAML_LABEL ?? "").trim() || "Kurumsal kimlikle giriş (SAML)",
    attrName: (env.SAML_ATTR_NAME ?? "displayName").trim() || "displayName",
    attrMail: (env.SAML_ATTR_MAIL ?? "mail").trim() || "mail",
    attrGroups: (env.SAML_ATTR_GROUPS ?? "memberOf").trim() || "memberOf",
    nameIdFormat:
      (env.SAML_NAME_ID_FORMAT ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress").trim() ||
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    adminGroup: (env.SAML_ADMIN_GROUP ?? "").trim(),
    defaultRole: ROLES.has(role) ? (role as SamlRole) : "radyolog",
    autoProvision: (env.SAML_AUTO_PROVISION ?? "1") !== "0",
    linkByEmail: (env.SAML_LINK_BY_EMAIL ?? "0") === "1",
    skipTotp: (env.SAML_SKIP_TOTP ?? "1") !== "0",
    clockSkewSec: Number.isFinite(skew) ? Math.min(Math.max(skew, 0), 600) : 120,
    allowSha1: (env.SAML_ALLOW_SHA1 ?? "0") === "1",
  };
}

export function samlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return samlConfig(env) !== null;
}

/* ── AuthnRequest ────────────────────────────────────────────────────────── */

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface AuthnRequestInput {
  id: string;
  issueInstant: string;
  acsUrl: string;
  entityId: string;
  destination: string;
  nameIdFormat?: string;
}

/** `<samlp:AuthnRequest>` — HTTP-POST binding İSTEMEZ, yanıt POST ile döner. */
export function buildAuthnRequest(p: AuthnRequestInput): string {
  const fmt = p.nameIdFormat ? `<saml:NameIDPolicy Format="${xmlEscape(p.nameIdFormat)}" AllowCreate="true"/>` : "";
  return [
    '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
    ` ID="${xmlEscape(p.id)}" Version="2.0" IssueInstant="${xmlEscape(p.issueInstant)}"`,
    ` Destination="${xmlEscape(p.destination)}" AssertionConsumerServiceURL="${xmlEscape(p.acsUrl)}"`,
    ' ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">',
    `<saml:Issuer>${xmlEscape(p.entityId)}</saml:Issuer>`,
    fmt,
    "</samlp:AuthnRequest>",
  ].join("");
}

export interface RedirectBinding {
  url: string;
  requestXml: string;
}

/**
 * AuthnRequest'i HTTP-Redirect binding ile gönderir: DEFLATE + base64 + URL.
 * `relayState` imzalı durum çerezindeki değerle aynı olmalıdır (dönüşte kontrol).
 */
export function authnRequestRedirect(cfg: SamlConfig, params: { id: string; acsUrl: string; relayState: string; issueInstant?: string }): RedirectBinding {
  const xml = buildAuthnRequest({
    id: params.id,
    issueInstant: params.issueInstant ?? new Date().toISOString(),
    acsUrl: params.acsUrl,
    entityId: cfg.entityId,
    destination: cfg.idpSsoUrl,
    nameIdFormat: cfg.nameIdFormat,
  });
  const encoded = deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
  const u = new URL(cfg.idpSsoUrl);
  u.searchParams.set("SAMLRequest", encoded);
  u.searchParams.set("RelayState", params.relayState);
  return { url: u.toString(), requestXml: xml };
}

/** Test/teşhis için: redirect parametresindeki AuthnRequest'i çözer. */
export function decodeRedirectRequest(encoded: string): string {
  return inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
}

/* ── İmzalı durum çerezi ─────────────────────────────────────────────────── */

export const SAML_COOKIE = "av_saml";
export const SAML_STATE_TTL_MS = 10 * 60 * 1000;

export interface SamlState {
  /** AuthnRequest ID — yanıttaki InResponseTo ile eşleşmeli. */
  i: string;
  /** RelayState değeri (CSRF bağlacı). */
  r: string;
  /** Assertion Consumer Service adresi (istek anında sabitlenir). */
  a: string;
  /** Dönülecek yerel yol. */
  x: string;
  t: number;
}

function stateSecret(env: NodeJS.ProcessEnv): string {
  return env.SESSION_SECRET ?? env.DATA_ENCRYPTION_KEY ?? "";
}

export function signSamlState(p: Omit<SamlState, "t"> & { t?: number }, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = stateSecret(env);
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ ...p, t: p.t ?? Date.now() }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifySamlState(value: string | undefined | null, env: NodeJS.ProcessEnv = process.env, now = Date.now()): SamlState | null {
  const secret = stateSecret(env);
  if (!value || !secret) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SamlState;
    if (typeof o.i !== "string" || typeof o.r !== "string" || typeof o.a !== "string" || typeof o.t !== "number") return null;
    if (now - o.t > SAML_STATE_TTL_MS || o.t > now + 60_000) return null;
    return { ...o, x: typeof o.x === "string" && o.x.startsWith("/") && !o.x.startsWith("//") ? o.x : "/" };
  } catch {
    return null;
  }
}

export function newSamlId(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

/* ── İmza doğrulaması (XML DSig, enveloped) ──────────────────────────────── */

const DIGEST_ALGS: Record<string, string> = {
  "http://www.w3.org/2001/04/xmlenc#sha256": "sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512": "sha512",
  "http://www.w3.org/2000/09/xmldsig#sha1": "sha1",
};

const SIG_ALGS: Record<string, { hash: string; sha1: boolean }> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": { hash: "sha256", sha1: false },
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384": { hash: "sha384", sha1: false },
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": { hash: "sha512", sha1: false },
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": { hash: "sha1", sha1: true },
};

const C14N_EXCLUSIVE = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export type VerifyFail = { ok: false; reason: string };
export type VerifyOk = { ok: true; node: XmlNode; inclusive: boolean };
export type VerifyResult = VerifyOk | VerifyFail;

function isExclusiveC14n(alg: string | undefined): boolean {
  return !!alg && alg.startsWith(C14N_EXCLUSIVE);
}

/** İmza düğümünün altındaki `SignedInfo`/`SignatureValue` alanlarını toplar. */
function readSignature(sig: XmlNode) {
  const signedInfo = findFirst(sig, "SignedInfo");
  const sigValue = findFirst(sig, "SignatureValue");
  if (!signedInfo || !sigValue) return null;
  const c14nAlg = attr(findFirst(signedInfo, "CanonicalizationMethod"), "Algorithm");
  const sigMethod = attr(findFirst(signedInfo, "SignatureMethod"), "Algorithm");
  const refs = childrenNamed(signedInfo, "Reference").map((r) => {
    const transforms = childrenNamed(r, "Transforms")[0];
    const algs = transforms ? childrenNamed(transforms, "Transform").map((t) => attr(t, "Algorithm") ?? "") : [];
    return {
      uri: attr(r, "URI") ?? "",
      digestAlg: attr(findFirst(r, "DigestMethod"), "Algorithm") ?? "",
      transforms: algs,
      digestValue: textContent(findFirst(r, "DigestValue") ?? { name: "", attrs: [], children: [], text: "" }).replace(/\s+/g, ""),
    };
  });
  return { signedInfo, c14nAlg, sigMethod, refs, signature: Buffer.from(textContent(sigValue).replace(/\s+/g, ""), "base64") };
}

/** Belge içinde `ID`/`Id`/`id` özniteliği verilen değere eşit öğeyi bulur. */
export function findBySamlId(root: XmlNode, id: string): XmlNode | null {
  const queue: XmlNode[] = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    const v = attr(cur, "ID") ?? attr(cur, "Id") ?? attr(cur, "id");
    if (v === id) return cur;
    queue.push(...cur.children);
  }
  return null;
}

export interface VerifySignatureOptions {
  /** İmza sertifikası (PEM). */
  certPem: string;
  /** SHA-1 imzalara izin verilsin mi (varsayılan hayır). */
  allowSha1?: boolean;
  /** Belge kökü — ad alanı kapsamını kurmak için. */
  doc: XmlNode;
}

/**
 * `<ds:Signature>` düğümünü doğrular: SignedInfo imzası + her Reference'ın özeti.
 *
 * İmza, imzalanan öğenin (Response ya da Assertion) **içinde** (enveloped) olmalı
 * ve en az bir Reference bu öğeyi (`URI="#<ID>"`) kapsamalıdır. Aksi halde
 * "imza" reddedilir. Dönüşümlerden yalnız enveloped-signature ve c14n kabul edilir
 * (XSLT vb. reddedilir).
 */
export function verifySignature(sig: XmlNode, signedNode: XmlNode, opts: VerifySignatureOptions): VerifyFail | { ok: true; algorithm: string } {
  const parsed = readSignature(sig);
  if (!parsed) return { ok: false, reason: "imza yapısı" };
  const sigAlg = SIG_ALGS[parsed.sigMethod ?? ""];
  if (!sigAlg) return { ok: false, reason: "imza algoritması" };
  if (sigAlg.sha1 && !opts.allowSha1) return { ok: false, reason: "sha1" };

  let key;
  try {
    key = createPublicKey(opts.certPem);
  } catch {
    return { ok: false, reason: "sertifika" };
  }

  const ancestors = pathTo(opts.doc, parsed.signedInfo);
  if (!ancestors) return { ok: false, reason: "imza yapısı" };
  const scope = namespaceScope(parsed.signedInfo, ancestors.slice(0, -1));
  const signedInfoXml = canonicalize(parsed.signedInfo, { scope, exclusive: isExclusiveC14n(parsed.c14nAlg) });

  let imzaGecerli = false;
  try {
    imzaGecerli = cryptoVerify(sigAlg.hash, Buffer.from(signedInfoXml, "utf8"), key, parsed.signature);
  } catch {
    imzaGecerli = false;
  }
  if (!imzaGecerli) return { ok: false, reason: "imza değeri" };

  // Referanslar: en az biri imzalanan öğeyi kapsamalı, hepsi doğrulanmalı.
  if (!parsed.refs.length) return { ok: false, reason: "referans" };
  let kapsar = false;
  for (const ref of parsed.refs) {
    for (const t of ref.transforms) {
      if (t !== ENVELOPED && !t.startsWith(C14N_EXCLUSIVE) && !t.startsWith("http://www.w3.org/TR/2001/REC-xml-c14n")) {
        return { ok: false, reason: "dönüşüm" };
      }
    }
    const hash = DIGEST_ALGS[ref.digestAlg];
    if (!hash) return { ok: false, reason: "özet algoritması" };
    if (hash === "sha1" && !opts.allowSha1) return { ok: false, reason: "sha1" };

    const id = ref.uri.startsWith("#") ? ref.uri.slice(1) : "";
    let target: XmlNode | null = null;
    if (id) target = findBySamlId(opts.doc, id);
    else target = signedNode; // URI "" ya da "#": imzayı içeren öğe
    if (!target) return { ok: false, reason: "referans" };
    if (target !== signedNode) return { ok: false, reason: "referans" }; // yalnız imzalanan öğe kabul
    kapsar = true;

    const refAncestors = pathTo(opts.doc, target);
    if (!refAncestors) return { ok: false, reason: "referans" };
    const refScope = namespaceScope(target, refAncestors.slice(0, -1));
    const c14nOfTarget = canonicalize(target, { scope: refScope, exclusive: true, exclude: new Set([sig]) });
    const digest = createHash(hash).update(Buffer.from(c14nOfTarget, "utf8")).digest("base64");
    if (digest !== ref.digestValue) return { ok: false, reason: "özet" };
  }
  if (!kapsar) return { ok: false, reason: "referans" };
  return { ok: true, algorithm: parsed.sigMethod ?? "" };
}

/* ── Yanıt doğrulaması ───────────────────────────────────────────────────── */

export interface SamlIdentity {
  username: string;
  fullName: string;
  email: string;
  groups: string[];
  role: SamlRole;
  nameId: string;
  nameIdFormat: string;
  issuer: string;
  sessionIndex: string;
}

export type SamlCheck =
  | { ok: true; assertionId: string; identity: SamlIdentity; notOnOrAfter: number }
  | { ok: false; reason: string };

export interface VerifyResponseInput {
  /** base64 SAMLResponse (form alanı). */
  samlResponse: string;
  cfg: SamlConfig;
  /** Beklenen AuthnRequest ID (imzalı çerezden). */
  requestId: string;
  /** Beklenen ACS adresi (imzalı çerezden; yapılandırmadan bağımsız). */
  acsUrl: string;
  /** RelayState (formdan) — çerezdeki değerle eşleşmeli. */
  relayState: string;
  expectedRelayState: string;
  now?: number;
}

const bad = (reason: string): SamlCheck => ({ ok: false, reason });

/** Belgedeki metin değerini (tüm alt metinler) toplar. */
function textOf(node: XmlNode): string {
  return textContent(node).trim();
}

function parseInstant(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Talep listesini `{ad: [değerler]}` sözlüğüne çevirir. */
export function parseAttributeStatements(assertion: XmlNode): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const stmt of childrenNamed(assertion, "AttributeStatement")) {
    for (const a of childrenNamed(stmt, "Attribute")) {
      const name = attr(a, "Name") ?? "";
      if (!name) continue;
      const values = childrenNamed(a, "AttributeValue").map(textOf).filter((v) => v.length > 0);
      out[name] = [...(out[name] ?? []), ...values];
    }
  }
  return out;
}

/**
 * SAML yanıtını doğrular ve kimliği çıkarır.
 *
 * Sıra: base64/XML → kök öğe → Status → imza (Assertion yeğlenir, yoksa Response)
 * → Issuer → Destination → Conditions (süre + Audience) → SubjectConfirmationData
 * (Recipient + NotOnOrAfter + InResponseTo) → RelayState → talepler.
 *
 * Herhangi bir adım başarısızsa `{ok:false, reason}` döner; **hiçbir zaman**
 * doğrulanmamış kimlik döndürülmez.
 */
export function verifySamlResponse(input: VerifyResponseInput): SamlCheck {
  const now = input.now ?? Date.now();
  const skew = input.cfg.clockSkewSec * 1000;

  let xml: string;
  try {
    xml = Buffer.from(input.samlResponse, "base64").toString("utf8");
  } catch {
    return bad("bicim");
  }
  if (!xml.includes("Response")) return bad("bicim");

  let doc: XmlNode;
  try {
    doc = parseXml(xml);
  } catch (e) {
    return bad(e instanceof XmlError ? `xml` : "xml");
  }
  if (localName(doc.name) !== "Response") return bad("bicim");

  // Kabuk: Status
  const status = childNamed(doc, "Status");
  const statusCode = status ? attr(childNamed(status, "StatusCode"), "Value") ?? "" : "";
  if (!statusCode.endsWith(":Success")) return bad("durum");

  // Assertion (imzalı olan) ve imzalar
  const assertion = findFirst(doc, "Assertion");
  if (!assertion) return bad("bicim");

  const sigOf = (node: XmlNode): XmlNode | undefined => node.children.find((c) => localName(c.name) === "Signature");
  const assertSig = sigOf(assertion);
  const respSig = sigOf(doc);
  const opts = { certPem: input.cfg.idpCertPem, allowSha1: input.cfg.allowSha1, doc };
  if (assertSig) {
    const v = verifySignature(assertSig, assertion, opts);
    if (!v.ok) return bad(v.reason);
  } else if (respSig) {
    const v = verifySignature(respSig, doc, opts);
    if (!v.ok) return bad(v.reason);
  } else {
    return bad("imza");
  }

  // Issuer (Response ve/veya Assertion)
  const issuerNode = childNamed(assertion, "Issuer") ?? childNamed(doc, "Issuer");
  const issuer = issuerNode ? textOf(issuerNode) : "";
  if (!issuer || issuer !== input.cfg.idpEntityId) return bad("veren");

  // Destination (varsa) ACS ile eşleşmeli
  const dest = attr(doc, "Destination");
  if (dest && dest !== input.acsUrl) return bad("hedef");

  // Koşullar: süre + izleyici (audience) + tek kullanım
  const conditions = childNamed(assertion, "Conditions");
  if (!conditions) return bad("kosul");
  const notBefore = parseInstant(attr(conditions, "NotBefore") ?? undefined);
  const notOnOrAfter = parseInstant(attr(conditions, "NotOnOrAfter") ?? undefined);
  if (notBefore !== null && now + skew < notBefore) return bad("sure");
  if (notOnOrAfter !== null && now - skew >= notOnOrAfter) return bad("sure");

  const audiences = childrenNamed(conditions, "AudienceRestriction").flatMap((ar) => childrenNamed(ar, "Audience").map(textOf));
  if (!audiences.length || !audiences.includes(input.cfg.entityId)) return bad("izleyici");

  // Subject: NameID + SubjectConfirmationData
  const subject = childNamed(assertion, "Subject");
  const nameIdNode = subject ? childNamed(subject, "NameID") : undefined;
  const nameId = nameIdNode ? textOf(nameIdNode) : "";
  if (!nameId) return bad("ozne");
  const nameIdFormat = (nameIdNode ? attr(nameIdNode, "Format") : undefined) ?? "";

  const confirmations = subject ? childrenNamed(subject, "SubjectConfirmation") : [];
  const bearer = confirmations.find((c) => (attr(c, "Method") ?? "").endsWith(":bearer"));
  if (!bearer) return bad("onay");
  const scd = childNamed(bearer, "SubjectConfirmationData");
  if (!scd) return bad("onay");
  const recipient = attr(scd, "Recipient") ?? "";
  if (recipient && recipient !== input.acsUrl) return bad("alici");
  const scdNotAfter = parseInstant(attr(scd, "NotOnOrAfter") ?? undefined);
  if (scdNotAfter === null || now - skew >= scdNotAfter) return bad("sure");
  const inResponseTo = attr(scd, "InResponseTo") ?? attr(doc, "InResponseTo") ?? "";
  if (!inResponseTo || inResponseTo !== input.requestId) return bad("istek");

  // RelayState: CSRF bağlacı
  if (!input.relayState || input.relayState !== input.expectedRelayState) return bad("durum_baglaci");

  // Tek kullanım: Assertion ID zorunlu (yeniden oynatma DB'de engellenir)
  const assertionId = attr(assertion, "ID") ?? "";
  if (!assertionId) return bad("bicim");

  // Talepler
  const attrs = parseAttributeStatements(assertion);
  const pick = (name: string): string[] => attrs[name] ?? attrs[Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""] ?? [];
  const groups = pick(input.cfg.attrGroups);
  const displayName = pick(input.cfg.attrName)[0] ?? "";
  const email = pick(input.cfg.attrMail)[0] ?? "";

  // Kullanıcı adı: NameID/e-postanın **yerel kısmı** (OIDC/LDAP ile aynı çizgi:
  // "ayse.kaya@hastane.local" → "ayse.kaya"). E-posta ayrı alanda saklanır.
  const rawUser = email || nameId;
  const local = rawUser.includes("@") ? rawUser.slice(0, rawUser.indexOf("@")) : rawUser;
  const identity: SamlIdentity = {
    username: sanitizeUsername(local),
    fullName: (displayName || rawUser).slice(0, 120),
    email,
    groups,
    role: input.cfg.adminGroup && groups.some((g) => g === input.cfg.adminGroup || g === `cn=${input.cfg.adminGroup}`) ? "yonetici" : input.cfg.defaultRole,
    nameId,
    nameIdFormat,
    issuer,
    sessionIndex: attr(findFirst(assertion, "AuthnStatement"), "SessionIndex") ?? "",
  };
  return { ok: true, assertionId, identity, notOnOrAfter: notOnOrAfter ?? now + 5 * 60 * 1000 };
}

/* ── SP meta verisi ──────────────────────────────────────────────────────── */

/** SP metadata XML'i (IdP'ye yüklenir). İmza/şifreleme sertifikası yoktur. */
export function spMetadata(cfg: SamlConfig, acsUrl: string): string {
  return [
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
    ` entityID="${xmlEscape(cfg.entityId)}">`,
    '<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"',
    ' protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '<md:NameIDFormat>' + xmlEscape(cfg.nameIdFormat) + "</md:NameIDFormat>",
    `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEscape(acsUrl)}" index="0" isDefault="true"/>`,
    "</md:SPSSODescriptor></md:EntityDescriptor>",
  ].join("");
}

/** Kullanıcıya gösterilecek kısa hata metni (ayrıntı log'da kalır). */
export function samlErrorText(code: string): string {
  const map: Record<string, string> = {
    yapilandirma: "SAML yapılandırması eksik",
    durum: "Oturum doğrulanamadı (durum çerezi geçersiz)",
    durum_baglaci: "RelayState eşleşmedi",
    bicim: "SAML yanıtı okunamadı",
    xml: "SAML yanıtı geçersiz XML",
    durum_kodu: "Kimlik sağlayıcı girişi reddetti",
    imza: "SAML imzası yok ya da doğrulanamadı",
    "imza değeri": "SAML imza değeri doğrulanamadı",
    özet: "SAML içerik özeti eşleşmedi (yanıt değiştirilmiş olabilir)",
    sha1: "SHA-1 imzalı SAML yanıtı reddedildi",
    veren: "Yanıt beklenen kimlik sağlayıcıdan gelmiyor",
    hedef: "Yanıt başka bir adrese gönderilmiş",
    alici: "Yanıt bu uygulamaya gönderilmemiş",
    kosul: "Yanıtta koşullar (Conditions) yok",
    sure: "Yanıtın geçerlilik süresi dolmuş ya da henüz başlamamış",
    izleyici: "Yanıt bu uygulama için düzenlenmemiş (audience)",
    istek: "Yanıt bu giriş isteğine ait değil (InResponseTo)",
    ozne: "Yanıtta kullanıcı kimliği (NameID) yok",
    onay: "SubjectConfirmation eksik",
    yeniden: "Bu yanıt daha önce kullanılmış (replay)",
    hesap: "Bu kimlik için yetkili hesap yok",
    mfa_gerekli: "Bu hesap iki adımlı doğrulama istiyor; parola ile girin",
    oturum: "Oturum kurulamadı",
  };
  return map[code] ?? `SAML girişi başarısız (${code})`;
}

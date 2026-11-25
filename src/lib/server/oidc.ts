import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type JsonWebKeyInput } from "node:crypto";

/**
 * KURUMSAL KİMLİK — OpenID Connect (authorization code + PKCE).
 *
 * Bu modül bilinçli olarak SAF tutulur (DB yok, Next.js yok): yapılandırma,
 * PKCE, imzalı state çerezi, ID token (RS256) doğrulaması ve talep→hesap
 * eşlemesi burada; HTTP çağrıları ve hesap açma uçlarda (src/app/api/auth/oidc).
 * Böylece kurumsal dizin olmadan da test edilebiliyor.
 *
 * Yapılandırma (hepsi ortam değişkeni):
 *   OIDC_ISSUER          zorunlu — ör. https://idp.kurum.local/realms/rad
 *   OIDC_CLIENT_ID       zorunlu
 *   OIDC_CLIENT_SECRET   opsiyonel (public client + PKCE için boş bırakılabilir)
 *   OIDC_REDIRECT_URI    opsiyonel — verilmezse istek origin'inden üretilir
 *   OIDC_SCOPES          varsayılan "openid email profile"
 *   OIDC_LABEL           giriş düğmesi etiketi
 *   OIDC_ADMIN_GROUP     bu gruptaki kullanıcılar yönetici olur (groups/roles talebi)
 *   OIDC_DEFAULT_ROLE    varsayılan "radyolog"
 *   OIDC_AUTO_PROVISION  "0" → yalnız önceden bağlanmış hesaplar girebilir
 *   OIDC_LINK_BY_EMAIL   "0" → e-posta doğrulanmış olsa bile mevcut hesaba bağlanmaz
 *   OIDC_SKIP_TOTP       "0" → OIDC ile giren yönetici ayrıca uygulama TOTP'si ister
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  label: string;
  adminGroup: string;
  defaultRole: "radyolog" | "teknisyen" | "yonetici";
  autoProvision: boolean;
  linkByEmail: boolean;
  skipTotp: boolean;
}

const ROLE_OK = new Set(["radyolog", "teknisyen", "yonetici"]);

/** Ortamdan yapılandırma; zorunlu alanlar eksikse null (özellik kapalı). */
export function oidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = (env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, "");
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  if (!issuer || !clientId) return null;
  if (!/^https?:\/\//i.test(issuer)) return null;
  const role = (env.OIDC_DEFAULT_ROLE ?? "radyolog").trim() as OidcConfig["defaultRole"];
  return {
    issuer,
    clientId,
    clientSecret: (env.OIDC_CLIENT_SECRET ?? "").trim(),
    redirectUri: (env.OIDC_REDIRECT_URI ?? "").trim(),
    scopes: (env.OIDC_SCOPES ?? "openid email profile").trim() || "openid email profile",
    label: (env.OIDC_LABEL ?? "").trim() || "Kurumsal kimlikle giriş",
    adminGroup: (env.OIDC_ADMIN_GROUP ?? "").trim(),
    defaultRole: ROLE_OK.has(role) ? role : "radyolog",
    autoProvision: (env.OIDC_AUTO_PROVISION ?? "1") !== "0",
    linkByEmail: (env.OIDC_LINK_BY_EMAIL ?? "1") !== "0",
    skipTotp: (env.OIDC_SKIP_TOTP ?? "1") !== "0",
  };
}

export function oidcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return oidcConfig(env) !== null;
}

/* ── PKCE ────────────────────────────────────────────────────────────────── */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: s256(verifier) };
}

/* ── Yetkilendirme URL'i ─────────────────────────────────────────────────── */

export interface AuthorizeParams {
  state: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
}

/** authorization_endpoint bilinmiyorsa issuer'a göre yaygın yolu kullanır. */
export function authorizeUrl(cfg: OidcConfig, params: AuthorizeParams, endpoint?: string): string {
  const base = endpoint && /^https?:\/\//i.test(endpoint) ? endpoint : `${cfg.issuer}/authorize`;
  const u = new URL(base);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/* ── İmzalı state çerezi ─────────────────────────────────────────────────── */

export const OIDC_COOKIE = "av_oidc";
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

export interface OidcState {
  /** CSRF state değeri. */
  s: string;
  /** ID token nonce'u. */
  n: string;
  /** PKCE code_verifier (asla tarayıcıya açık gitmez; imzalı çerezde). */
  v: string;
  /** Giriş sonrası dönülecek yol (yalnız "/" ile başlayan yerel yollar). */
  x: string;
  /** Oluşturulma zamanı (epoch ms). */
  t: number;
}

function stateSecret(env: NodeJS.ProcessEnv): string {
  return env.SESSION_SECRET ?? env.DATA_ENCRYPTION_KEY ?? "";
}

/** State'i HMAC ile imzalar; imzalama anahtarı yoksa null. */
export function signOidcState(p: Omit<OidcState, "t"> & { t?: number }, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = stateSecret(env);
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ ...p, t: p.t ?? Date.now() }), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** State çerezini doğrular: imza, biçim ve 10 dakikalık ömür. */
export function verifyOidcState(value: string | undefined | null, env: NodeJS.ProcessEnv = process.env, now = Date.now()): OidcState | null {
  const secret = stateSecret(env);
  if (!value || !secret) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcState;
    if (typeof o.s !== "string" || typeof o.n !== "string" || typeof o.v !== "string" || typeof o.t !== "number") return null;
    if (now - o.t > OIDC_STATE_TTL_MS || o.t > now + 60_000) return null;
    return { ...o, x: typeof o.x === "string" && o.x.startsWith("/") && !o.x.startsWith("//") ? o.x : "/" };
  } catch {
    return null;
  }
}

/* ── ID token doğrulaması ────────────────────────────────────────────────── */

export interface JwtParts {
  header: { alg?: string; kid?: string; typ?: string };
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** JWT'yi imza doğrulaması YAPMADAN parçalar (imza ayrıca doğrulanır). */
export function parseJwt(token: string): JwtParts | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]) as JwtParts["header"];
    const claims = b64urlJson(parts[1]) as Record<string, unknown>;
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return null;
    return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
  } catch {
    return null;
  }
}

/** JWKS'ten anahtar seçer (kid eşleşmesi; tek anahtar varsa kid zorunlu değil). */
export function pickJwk(jwks: { keys?: unknown[] }, kid?: string): Record<string, unknown> | null {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const rsa = keys.filter((k): k is Record<string, unknown> => !!k && typeof k === "object" && (k as { kty?: string }).kty === "RSA");
  if (kid) {
    const hit = rsa.find((k) => k.kid === kid);
    return hit ?? null;
  }
  return rsa.length === 1 ? rsa[0] : null;
}

export interface IdTokenCheck {
  issuer: string;
  clientId: string;
  /** Beklenen nonce; boşsa kontrol atlanır. */
  nonce?: string;
  jwks: { keys?: unknown[] };
  now?: number;
  /** Saat sapması toleransı (ms). */
  skewMs?: number;
}

export type IdTokenResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * ID token'ı doğrular: RS256 imzası (JWKS), iss, aud, exp/iat ve nonce.
 *
 * `alg` yalnız RS256 kabul edilir — "none" ya da HS256'ya düşürme (algorithm
 * confusion) saldırıları böylece kapalıdır.
 */
export function verifyIdToken(token: string, opts: IdTokenCheck): IdTokenResult {
  const parts = parseJwt(token);
  if (!parts) return { ok: false, reason: "ID token biçimi geçersiz" };
  if (parts.header.alg !== "RS256") return { ok: false, reason: `desteklenmeyen imza algoritması: ${String(parts.header.alg)}` };
  const jwk = pickJwk(opts.jwks, parts.header.kid);
  if (!jwk) return { ok: false, reason: "imza anahtarı (kid) JWKS'te bulunamadı" };
  let key;
  try {
    // node:crypto, global (DOM) JsonWebKey'den farklı bir tip bekliyor; JWK zaten
    // JWKS'ten geldiği için biçim doğrulaması createPublicKey'de yapılıyor.
    key = createPublicKey({ key: jwk as unknown as JsonWebKeyInput["key"], format: "jwk" });
  } catch {
    return { ok: false, reason: "JWK açılamadı" };
  }
  const good = verifySignature("RSA-SHA256", Buffer.from(parts.signingInput), key, parts.signature);
  if (!good) return { ok: false, reason: "ID token imzası doğrulanamadı" };

  const c = parts.claims;
  const now = opts.now ?? Date.now();
  const skew = opts.skewMs ?? 60_000;
  if (c.iss !== opts.issuer) return { ok: false, reason: `iss uyuşmuyor (${String(c.iss)})` };
  const aud = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud ?? "")];
  if (!aud.includes(opts.clientId)) return { ok: false, reason: "aud bu istemciyi içermiyor" };
  const exp = typeof c.exp === "number" ? c.exp * 1000 : NaN;
  if (!Number.isFinite(exp) || exp + skew < now) return { ok: false, reason: "ID token süresi dolmuş" };
  const iat = typeof c.iat === "number" ? c.iat * 1000 : NaN;
  if (Number.isFinite(iat) && iat - skew > now) return { ok: false, reason: "ID token ileri tarihli (iat)" };
  if (opts.nonce && c.nonce !== opts.nonce) return { ok: false, reason: "nonce uyuşmuyor" };
  if (typeof c.sub !== "string" || !c.sub.trim()) return { ok: false, reason: "sub talebi yok" };
  return { ok: true, claims: c };
}

/* ── Talep → hesap eşlemesi ──────────────────────────────────────────────── */

export interface MappedIdentity {
  subject: string;
  /** Bağlama/eşleştirme için normalize kullanıcı adı adayı. */
  username: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  role: "radyolog" | "teknisyen" | "yonetici";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Kullanıcı adına çevirir: harf/rakam/._- dışını noktaya indirger, 3–40 karakter. */
export function sanitizeUsername(raw: string): string {
  const base = (raw ?? "")
    // Türkçe noktasız "ı" NFKD ile ayrışmadığı için açıkça eşlenir; İ→I sonra küçülür.
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Not: bilinçli olarak yerel ayardan bağımsız küçültme — Türkçe yerelde "I"→"ı"
    // olur ve grup adları (ör. RAD-YONETICI) eşleşmezdi.
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
  if (base.length >= 3) return base;
  return `oidc.${createHash("sha256").update(raw || "bos").digest("hex").slice(0, 8)}`;
}

/**
 * Kimlik taleplerini hesap alanlarına çevirir.
 *
 * Grup eşleşmesi `OIDC_ADMIN_GROUP` ile birebir (büyük/küçük harf duyarsız)
 * yapılır; `groups`/`roles`/`realm_access.roles` biçimleri desteklenir.
 */
export function mapClaims(claims: Record<string, unknown>, cfg: OidcConfig): MappedIdentity {
  const email = str(claims.email);
  const preferred = str(claims.preferred_username) || str(claims.upn);
  const name = str(claims.name) || [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" ");
  const groups = new Set<string>();
  const addGroups = (v: unknown) => {
    if (Array.isArray(v)) v.forEach((g) => typeof g === "string" && groups.add(g.toLowerCase()));
    else if (typeof v === "string") v.split(/[,\s]+/).filter(Boolean).forEach((g) => groups.add(g.toLowerCase()));
  };
  addGroups(claims.groups);
  addGroups(claims.roles);
  const realm = claims.realm_access as { roles?: unknown } | undefined;
  if (realm) addGroups(realm.roles);
  // Grup adları yerel ayardan bağımsız küçültülür (bkz. sanitizeUsername notu).
  const isAdmin = !!cfg.adminGroup && groups.has(cfg.adminGroup.toLowerCase());

  const candidate = preferred || (email.includes("@") ? email.split("@")[0] : email) || str(claims.sub);
  return {
    subject: str(claims.sub),
    username: sanitizeUsername(candidate),
    fullName: (name || preferred || email || "Kurumsal kullanıcı").slice(0, 120),
    email,
    emailVerified: claims.email_verified === true,
    role: isAdmin ? "yonetici" : cfg.defaultRole,
  };
}

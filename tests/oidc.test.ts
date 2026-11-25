import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createPublicKey } from "node:crypto";
import {
  authorizeUrl,
  mapClaims,
  oidcConfig,
  oidcEnabled,
  parseJwt,
  pickJwk,
  pkcePair,
  sanitizeUsername,
  signOidcState,
  s256,
  verifyIdToken,
  verifyOidcState,
  OIDC_STATE_TTL_MS,
} from "../src/lib/server/oidc";

/**
 * OIDC çekirdeği testleri — kurumsal dizin YOK, sahte anahtar çiftiyle çalışır.
 * Burada kanıtlanan: yapılandırma, PKCE (RFC 7636 vektörü), imzalı state çerezi,
 * RS256 ID token doğrulaması (iss/aud/exp/nonce + algoritma karışıklığı reddi)
 * ve talep→hesap eşlemesi. Uçların/DB'nin testi auth-login.integration.ts'te.
 */

const ENV_BASE = {
  OIDC_ISSUER: "https://idp.kurum.local/realms/rad/",
  OIDC_CLIENT_ID: "atikviewer",
} as unknown as NodeJS.ProcessEnv;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };
const JWKS = { keys: [JWK] };

function enc(o: unknown): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
}

function makeJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }, key = privateKey): string {
  const input = `${enc(header)}.${enc(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://idp.kurum.local/realms/rad", aud: "atikviewer", sub: "user-123", iat: now, exp: now + 300, nonce: "n-1", ...over };
}

const cfg = oidcConfig(ENV_BASE)!;
const check = (token: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(token, { issuer: cfg.issuer, clientId: cfg.clientId, nonce: "n-1", jwks: JWKS, ...over });

function main() {
  // ── Yapılandırma ─────────────────────────────────────────────────────────
  assert.equal(oidcConfig({} as NodeJS.ProcessEnv), null, "issuer/client_id yoksa kapalı");
  assert.equal(oidcEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(oidcConfig({ OIDC_ISSUER: "https://a", OIDC_CLIENT_ID: "" } as unknown as NodeJS.ProcessEnv), null, "client_id zorunlu");
  assert.equal(oidcConfig({ OIDC_ISSUER: "a-kurum", OIDC_CLIENT_ID: "x" } as unknown as NodeJS.ProcessEnv), null, "issuer http(s) olmalı");
  assert.equal(cfg.issuer, "https://idp.kurum.local/realms/rad", "sondaki / temizlenir");
  assert.equal(cfg.scopes, "openid email profile");
  assert.equal(cfg.autoProvision, true);
  assert.equal(cfg.skipTotp, true);
  assert.equal(cfg.label, "Kurumsal kimlikle giriş");
  const off = oidcConfig({
    OIDC_ISSUER: "https://a", OIDC_CLIENT_ID: "c", OIDC_AUTO_PROVISION: "0", OIDC_LINK_BY_EMAIL: "0", OIDC_SKIP_TOTP: "0",
    OIDC_DEFAULT_ROLE: "teknisyen", OIDC_ADMIN_GROUP: "rad-yonetici", OIDC_LABEL: "Hastane SSO",
  } as unknown as NodeJS.ProcessEnv)!;
  assert.equal(off.autoProvision, false);
  assert.equal(off.linkByEmail, false);
  assert.equal(off.skipTotp, false);
  assert.equal(off.defaultRole, "teknisyen");
  assert.equal(off.label, "Hastane SSO");
  const badRole = oidcConfig({ OIDC_ISSUER: "https://a", OIDC_CLIENT_ID: "c", OIDC_DEFAULT_ROLE: "root" } as unknown as NodeJS.ProcessEnv)!;
  assert.equal(badRole.defaultRole, "radyolog", "bilinmeyen rol güvenli varsayılana düşer");
  console.log("PASS OIDC yapılandırması: zorunlu alanlar, etiket/rol ve güvenli varsayılanlar.");

  // ── PKCE (RFC 7636 B.1 vektörü) ──────────────────────────────────────────
  assert.equal(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const pair = pkcePair();
  assert.ok(pair.verifier.length >= 43 && pair.challenge === s256(pair.verifier), "S256 challenge türetilir");
  assert.notEqual(pkcePair().verifier, pair.verifier, "her akışta yeni verifier");
  console.log("PASS PKCE: RFC 7636 vektörü ve her akışta yeni verifier/challenge.");

  // ── Yetkilendirme URL'i ──────────────────────────────────────────────────
  const url = new URL(authorizeUrl(cfg, { state: "st", nonce: "nc", challenge: "ch", redirectUri: "https://app.local/cb" }, "https://idp.kurum.local/realms/rad/protocol/openid-connect/auth"));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.local/cb");
  assert.match(authorizeUrl(cfg, { state: "s", nonce: "n", challenge: "c", redirectUri: "https://x/cb" }), /\/authorize\?/, "keşif yoksa /authorize varsayılır");
  console.log("PASS yetkilendirme URL'i: PKCE + state + nonce ve keşif yokken güvenli varsayılan.");

  // ── İmzalı state çerezi ──────────────────────────────────────────────────
  const env = { ...ENV_BASE, SESSION_SECRET: "test-state-anahtari" } as unknown as NodeJS.ProcessEnv;
  const st = signOidcState({ s: "state-1", n: "nonce-1", v: "verifier-1", x: "/yonetim" }, env)!;
  const back = verifyOidcState(st, env)!;
  assert.equal(back.s, "state-1");
  assert.equal(back.n, "nonce-1");
  assert.equal(back.v, "verifier-1");
  assert.equal(back.x, "/yonetim");
  assert.equal(verifyOidcState(st.slice(0, -2) + "xy", env), null, "bozulan imza reddedilir");
  assert.equal(verifyOidcState(st, { ...env, SESSION_SECRET: "baska" } as unknown as NodeJS.ProcessEnv), null, "başka anahtarla imzalanmış state reddedilir");
  assert.equal(verifyOidcState(null, env), null);
  const expired = signOidcState({ s: "a", n: "b", v: "c", x: "/", t: Date.now() - OIDC_STATE_TTL_MS - 1000 }, env)!;
  assert.equal(verifyOidcState(expired, env), null, "10 dakikadan eski state reddedilir");
  const future = signOidcState({ s: "a", n: "b", v: "c", x: "/", t: Date.now() + 10 * 60_000 }, env)!;
  assert.equal(verifyOidcState(future, env), null, "ileri tarihli state reddedilir");
  const openRedirect = verifyOidcState(signOidcState({ s: "a", n: "b", v: "c", x: "//evil.example" }, env)!, env)!;
  assert.equal(openRedirect.x, "/", "açık yönlendirme engellenir");
  assert.equal(signOidcState({ s: "a", n: "b", v: "c", x: "/" }, { ...env, SESSION_SECRET: "", DATA_ENCRYPTION_KEY: "" } as unknown as NodeJS.ProcessEnv), null, "anahtar yoksa state imzalanamaz");
  console.log("PASS state çerezi: imza, ömür, anahtar ayrımı ve açık yönlendirme koruması.");

  // ── ID token doğrulaması ─────────────────────────────────────────────────
  const good = check(makeJwt(claims()));
  assert.equal(good.ok, true, good.ok ? "" : good.reason);
  assert.equal((good as { claims: Record<string, unknown> }).claims.sub, "user-123");

  const noNonce = check(makeJwt(claims()));
  assert.equal(noNonce.ok, true, "doğru nonce kabul edilir");
  assert.equal(check(makeJwt(claims({ nonce: "baska" }))).ok, false, "yanlış nonce reddedilir");
  assert.equal(check(makeJwt(claims()), { nonce: undefined }).ok, true, "nonce istenmezse kontrol atlanır");
  assert.equal(check(makeJwt(claims({ aud: ["baska", "atikviewer"] }))).ok, true, "aud dizisi desteklenir");
  assert.equal(check(makeJwt(claims({ aud: "baska-istemci" }))).ok, false, "yabancı aud reddedilir");
  assert.equal(check(makeJwt(claims({ iss: "https://kotu-IdP" }))).ok, false, "yabancı issuer reddedilir");
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(check(makeJwt(claims({ exp: nowSec - 120, iat: nowSec - 400 }))).ok, false, "süresi dolmuş token reddedilir");
  assert.equal(check(makeJwt(claims({ iat: nowSec + 3600, exp: nowSec + 7200 }))).ok, false, "ileri tarihli token reddedilir");
  assert.equal(check(makeJwt(claims({ sub: "" }))).ok, false, "sub zorunlu");

  // Algoritma karışıklığı: HS256/none kabul edilmez, imzasız token kabul edilmez.
  const hsToken = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims())}.${Buffer.from("sahte").toString("base64url")}`;
  assert.equal(check(hsToken).ok, false, "HS256 reddedilir");
  const noneToken = `${enc({ alg: "none", typ: "JWT" })}.${enc(claims())}.`;
  assert.equal(check(noneToken).ok, false, "alg=none reddedilir");

  // Başka anahtarla imzalanan token (taklit IdP) reddedilir.
  const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(check(makeJwt(claims(), { alg: "RS256", kid: "k1" }, otherKey)).ok, false, "yabancı anahtarın imzası reddedilir");
  // Gövde değiştirilip imza korunursa reddedilir.
  const parts = makeJwt(claims()).split(".");
  const tampered = `${parts[0]}.${enc(claims({ sub: "saldirgan" }))}.${parts[2]}`;
  assert.equal(check(tampered).ok, false, "değiştirilmiş gövde reddedilir");
  // Bilinmeyen kid.
  assert.equal(check(makeJwt(claims(), { alg: "RS256", kid: "yok" })).ok, false, "bilinmeyen kid reddedilir");
  assert.equal(pickJwk(JWKS, "k1")?.kid, "k1");
  assert.equal(pickJwk(JWKS, "yok"), null);
  assert.equal(pickJwk({ keys: [JWK, { ...JWK, kid: "k2" }] }, undefined), null, "kid yoksa ve anahtar birden fazlaysa eşleşme uydurulmaz");
  assert.equal(parseJwt("a.b"), null);
  assert.equal(parseJwt("a.b.c.d"), null);
  assert.equal(parseJwt("x.y.z"), null, "JSON olmayan parçalar reddedilir");
  assert.ok(createPublicKey({ key: JWK as unknown as { kty: string; n: string; e: string }, format: "jwk" }), "test JWKS'i geçerli bir açık anahtar taşır");
  console.log("PASS ID token: RS256 imzası, iss/aud/exp/iat/nonce, algoritma karışıklığı ve taklit anahtar reddi.");

  // ── Talep → hesap eşlemesi ───────────────────────────────────────────────
  const adminCfg = { ...cfg, adminGroup: "rad-yonetici" };
  const m1 = mapClaims({ sub: "s1", name: "Ayşe Kaya", email: "Ayse.Kaya@Hastane.local", email_verified: true, groups: ["RAD-YONETICI", "doktorlar"] }, adminCfg);
  assert.equal(m1.role, "yonetici", "yönetici grubu büyük/küçük harf duyarsız eşleşir");
  assert.equal(m1.username, "ayse.kaya", "e-posta yerel kısmı normalize edilir");
  assert.equal(m1.fullName, "Ayşe Kaya");
  assert.equal(m1.emailVerified, true);
  const m2 = mapClaims({ sub: "s2", preferred_username: "dr.ömer", roles: "radyolog, izleyici" }, adminCfg);
  assert.equal(m2.role, "radyolog", "grup dışı varsayılan role düşer");
  assert.equal(m2.username, "dr.omer", "Türkçe karakterler sadeleşir");
  const m3 = mapClaims({ sub: "s3", realm_access: { roles: ["rad-yonetici"] } }, adminCfg);
  assert.equal(m3.role, "yonetici", "realm_access.roles da okunur");
  const m4 = mapClaims({ sub: "s4" }, adminCfg);
  assert.equal(m4.fullName, "Kurumsal kullanıcı");
  assert.match(m4.username, /^oidc\.[a-f0-9]{8}$/, "kimlik bilgisi yoksa çakışmasız ad üretilir");
  assert.equal(sanitizeUsername("ömer  yılmaz!"), "omer.yilmaz");
  assert.equal(sanitizeUsername("--a--"), "oidc.".concat(sanitizeUsername("--a--").slice(5)), "kısa ad üretilene düşer");
  assert.ok(sanitizeUsername("x").length >= 3);
  assert.ok(sanitizeUsername("ç".repeat(80)).length <= 40);
  console.log("PASS talep eşlemesi: rol (groups/roles/realm_access), ad, e-posta ve güvenli kullanıcı adı.");

  console.log("Tüm OIDC çekirdek testleri geçti.");
}

main();

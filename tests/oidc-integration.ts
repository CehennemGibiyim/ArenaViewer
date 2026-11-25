/**
 * Kurumsal giriş (OIDC) uçtan uca testi — sahte IdP + gerçek PostgreSQL.
 *
 * Yalnız ayrılmış test veritabanıyla çalıştırın:
 *   DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
 *     npx tsx tests/oidc-integration.ts
 *
 * Sahte IdP (127.0.0.1, rastgele port) keşif belgesi, JWKS ve token ucu sunar;
 * ID token'ı gerçek RSA anahtarıyla imzalar. Test, PKCE verifier'ını imzalı
 * state çerezinden okuyup sahte IdP'ye "beklenen challenge" olarak verir —
 * böylece kod değişimi gerçekten S256 doğrulamasından geçer.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

interface IdpExpect {
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
  /** Token ucunun döneceği hata (varsa). */
  tokenError?: string;
}

async function main() {
  if (process.env.AUTH_INTEGRATION_TEST !== "1" || !process.env.DATABASE_URL) {
    throw new Error("Yalnız ayrılmış test veritabanı için AUTH_INTEGRATION_TEST=1 ve DATABASE_URL gerekli.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { privateKey: fakeKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };

  let expect: IdpExpect | null = null;
  let signWith = privateKey;
  const seen: { tokenCalls: number; lastBody: string } = { tokenCalls: 0, lastBody: "" };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.tokenCalls++;
        seen.lastBody = raw;
        const body = new URLSearchParams(raw);
        if (!expect) return json(400, { error: "unexpected_token_call" });
        if (expect.tokenError) return json(400, { error: expect.tokenError });
        // PKCE: gönderilen verifier, başlangıçta beklenen challenge'ı üretmeli.
        const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== expect.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE uyuşmuyor" });
        if (body.get("code") !== "kod-1" || body.get("grant_type") !== "authorization_code") return json(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: base, aud: "atikviewer", iat: now, exp: now + 300, nonce: expect.nonce, ...expect.claims };
        const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
        const idToken = `${input}.${sign("RSA-SHA256", Buffer.from(input), signWith).toString("base64url")}`;
        return json(200, { id_token: idToken, token_type: "Bearer", expires_in: 300 });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  // ── Ortam: kurumsal giriş açık, hesap modu ────────────────────────────────
  process.env.AUTH_MODE = "hesap";
  process.env.SESSION_SECRET = "ci-only-signing-secret-not-for-production";
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.ACCESS_TOKEN;
  process.env.OIDC_ISSUER = base;
  process.env.OIDC_CLIENT_ID = "atikviewer";
  process.env.OIDC_ADMIN_GROUP = "rad-yonetici";
  process.env.OIDC_AUTO_PROVISION = "1";
  process.env.OIDC_LINK_BY_EMAIL = "1";
  process.env.OIDC_SKIP_TOTP = "1";
  delete process.env.OIDC_REDIRECT_URI;

  const { db, pool } = await import("../src/db/index");
  const { users, sessions, auditLogs } = await import("../src/db/schema");
  const { OIDC_COOKIE, verifyOidcState } = await import("../src/lib/server/oidc");
  const { SESSION_COOKIE, verifySessionRef } = await import("../src/lib/server/session");
  const start = await import("../src/app/api/auth/oidc/start/route");
  const callback = await import("../src/app/api/auth/oidc/callback/route");

  const createdUsernames: string[] = [];

  /** Başlat → state çerezini çöz. */
  async function begin(next = "/yonetim") {
    const res = await start.GET(new NextRequest(`http://localhost/api/auth/oidc/start?next=${encodeURIComponent(next)}`));
    const location = res.headers.get("location") ?? "";
    const cookie = res.cookies.get(OIDC_COOKIE)?.value ?? "";
    const state = verifyOidcState(cookie);
    return { res, location, cookie, state };
  }

  async function login(claims: Record<string, unknown>, over: { next?: string; tokenError?: string; key?: typeof privateKey; stateOverride?: string; cookieOverride?: string; nonceOverride?: string } = {}) {
    const b = await begin(over.next ?? "/yonetim");
    assert.equal(b.res.status, 307, "başlatma yönlendirmesi");
    assert.ok(b.state, "state çerezi imzalı ve çözülebilir");
    const u = new URL(b.location);
    expect = {
      challenge: u.searchParams.get("code_challenge") ?? "",
      nonce: over.nonceOverride ?? b.state!.n,
      claims,
      tokenError: over.tokenError,
    };
    signWith = over.key ?? privateKey;
    const stateParam = over.stateOverride ?? b.state!.s;
    const cookie = over.cookieOverride ?? `av_oidc=${b.cookie}`;
    return callback.GET(
      new NextRequest(`http://localhost/api/auth/oidc/callback?code=kod-1&state=${encodeURIComponent(stateParam)}`, { headers: { cookie } })
    );
  }

  const dest = (r: Response) => new URL(r.headers.get("location") ?? "http://localhost/").pathname;
  const errCode = (r: Response) => new URL(r.headers.get("location") ?? "http://localhost/").searchParams.get("oidc_error") ?? "";

  try {
    // ── 1) İlk giriş: hesap açılır, oturum kurulur ──────────────────────────
    const b1 = await begin("/yonetim");
    assert.equal(b1.res.status, 307);
    const loc1 = new URL(b1.location);
    assert.equal(loc1.origin, base, "keşifteki authorization_endpoint kullanılır");
    assert.equal(loc1.pathname, "/authorize");
    assert.equal(loc1.searchParams.get("response_type"), "code");
    assert.equal(loc1.searchParams.get("code_challenge_method"), "S256");
    assert.equal(loc1.searchParams.get("redirect_uri"), "http://localhost/api/auth/oidc/callback");
    assert.ok(loc1.searchParams.get("state") && loc1.searchParams.get("nonce"), "state ve nonce üretilir");
    assert.ok(b1.cookie, "imzalı state çerezi httpOnly olarak verilir");

    const sub1 = `sub-${randomUUID()}`;
    const user1 = `ayse.${randomUUID().slice(0, 6)}`;
    const res1 = await login({ sub: sub1, email: `${user1}@hastane.local`, email_verified: true, name: "Ayşe Kaya" });
    assert.equal(res1.status, 307);
    assert.equal(dest(res1), "/yonetim", "giriş sonrası istenen yola dönülür");
    const cookie1 = res1.cookies.get(SESSION_COOKIE)?.value ?? "";
    assert.ok(cookie1, "oturum çerezi kurulur");
    const ref1 = verifySessionRef(cookie1);
    assert.ok(ref1 && /^[a-f0-9]{32}$/.test(ref1.sid), "oturum sunucu kaydına bağlı");
    const sess1 = (await db.select().from(sessions).where(eq(sessions.id, ref1!.sid)))[0];
    assert.ok(sess1, "sessions satırı yazıldı");
    const u1 = (await db.select().from(users).where(eq(users.id, ref1!.uid)))[0];
    assert.equal(u1.username, user1, "e-posta yerel kısmı kullanıcı adı olur");
    assert.equal(u1.fullName, "Ayşe Kaya");
    assert.equal(u1.oidcIssuer, base);
    assert.equal(u1.oidcSubject, sub1);
    assert.equal(u1.role, "radyolog", "grup yoksa varsayılan rol");
    assert.equal(u1.passwordHash, "-", "SSO hesabı parolasızdır");
    const loginAudit = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login.oidc"));
    assert.ok(loginAudit.length >= 1, "denetim: auth.login.oidc yazıldı");
    assert.match(loginAudit[loginAudit.length - 1].details, /"created":true/);
    createdUsernames.push(u1.username);
    console.log("PASS OIDC ilk giriş: keşif → PKCE → ID token → hesap açma → sunucu oturumu + denetim.");

    // ── 2) Aynı kimlik: yeni hesap açılmaz, oturum yenilenir ────────────────
    const res2 = await login({ sub: sub1, email: `${user1}@hastane.local`, email_verified: true, name: "Ayşe Kaya" });
    assert.equal(res2.status, 307);
    const ref2 = verifySessionRef(res2.cookies.get(SESSION_COOKIE)?.value);
    assert.equal(ref2?.uid, ref1!.uid, "aynı kullanıcıya bağlanır");
    const count1 = (await db.select({ id: users.id }).from(users).where(eq(users.oidcSubject, sub1)));
    assert.equal(count1.length, 1, "tekrarlanan giriş yeni hesap açmaz");
    assert.notEqual(ref2?.sid, ref1!.sid, "her giriş ayrı oturum kaydı açar");
    console.log("PASS OIDC tekrar giriş: kimlik (issuer+sub) ile eşleşiyor, mükerrer hesap açılmıyor.");

    // ── 3) Yönetici grubu: rol yükseltilir, sonra düşürülmez ────────────────
    const sub3 = `sub-${randomUUID()}`;
    const res3 = await login({ sub: sub3, preferred_username: `admin.${randomUUID().slice(0, 6)}`, groups: ["RAD-YONETICI"] });
    assert.equal(res3.status, 307);
    const ref3 = verifySessionRef(res3.cookies.get(SESSION_COOKIE)?.value);
    const u3a = (await db.select().from(users).where(eq(users.id, ref3!.uid)))[0];
    assert.equal(u3a.role, "yonetici", "OIDC_ADMIN_GROUP üyeliği yönetici yapar");
    const res3b = await login({ sub: sub3, preferred_username: u3a.username, groups: ["doktorlar"] });
    assert.equal(res3b.status, 307);
    const u3b = (await db.select().from(users).where(eq(users.id, ref3!.uid)))[0];
    assert.equal(u3b.role, "yonetici", "grup kaybolsa da rol otomatik düşürülmez");
    createdUsernames.push(u3a.username);
    console.log("PASS OIDC rol: yönetici grubu yükseltir; sonraki girişlerde otomatik düşürme yok.");

    // ── 4) Mevcut parolalı hesaba bağlama (e-posta doğrulanmışsa) ────────────
    const linkName = `link.${randomUUID().slice(0, 6)}`;
    const { hashPassword } = await import("../src/lib/server/passwords");
    const existingId = (await db.insert(users).values({ username: linkName, passwordHash: hashPassword("Eski-parola-2026"), fullName: "Eski Hesap", role: "teknisyen" }).returning({ id: users.id }))[0].id;
    createdUsernames.push(linkName);
    const sub4 = `sub-${randomUUID()}`;
    const res4 = await login({ sub: sub4, email: `${linkName}@hastane.local`, email_verified: true });
    assert.equal(res4.status, 307);
    const ref4 = verifySessionRef(res4.cookies.get(SESSION_COOKIE)?.value);
    assert.equal(ref4?.uid, existingId, "doğrulanmış e-posta mevcut hesaba bağlanır");
    const u4 = (await db.select().from(users).where(eq(users.id, existingId)))[0];
    assert.equal(u4.oidcSubject, sub4);
    assert.equal(u4.passwordHash.startsWith("scrypt$"), true, "bağlama parolayı silmez (geri dönüş yolu)");
    const linkAudit = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login.oidc"));
    assert.match(linkAudit[linkAudit.length - 1].details, /"linked":true/);
    console.log("PASS OIDC bağlama: doğrulanmış e-posta mevcut hesabı devralır, parola korunur.");

    // E-posta doğrulanmamışsa bağlanmaz: yeni hesap açılır.
    const unverifiedName = `noverify.${randomUUID().slice(0, 6)}`;
    const unverifiedId = (await db.insert(users).values({ username: unverifiedName, passwordHash: hashPassword("Eski-parola-2026"), fullName: "Doğrulanmamış", role: "radyolog" }).returning({ id: users.id }))[0].id;
    createdUsernames.push(unverifiedName);
    const sub5 = `sub-${randomUUID()}`;
    const res5 = await login({ sub: sub5, email: `${unverifiedName}@hastane.local`, email_verified: false });
    assert.equal(res5.status, 307);
    const ref5 = verifySessionRef(res5.cookies.get(SESSION_COOKIE)?.value);
    assert.notEqual(ref5!.uid, unverifiedId, "doğrulanmamış e-posta hesap devralmaz");
    const u5 = (await db.select().from(users).where(eq(users.id, ref5!.uid)))[0];
    createdUsernames.push(u5.username);
    console.log("PASS OIDC güvenliği: e-posta doğrulanmamışsa mevcut hesap devralınmaz (yeni hesap açılır).");

    // ── 5) Hata yolları ─────────────────────────────────────────────────────
    const subN = `sub-${randomUUID()}`;
    const badState = await login({ sub: subN }, { stateOverride: "yanlis-state" });
    assert.equal(dest(badState), "/giris");
    assert.equal(errCode(badState), "durum", "state uyuşmazlığı reddedilir");

    const noCookie = await callback.GET(new NextRequest("http://localhost/api/auth/oidc/callback?code=kod-1&state=x"));
    assert.equal(errCode(noCookie), "durum", "state çerezi yoksa reddedilir");

    const badNonce = await login({ sub: subN }, { nonceOverride: "baska-nonce" });
    assert.equal(errCode(badNonce), "jeton_dogrulama", "nonce uyuşmazlığı reddedilir");

    const badSig = await login({ sub: subN }, { key: fakeKey });
    assert.equal(errCode(badSig), "jeton_dogrulama", "yabancı anahtarın imzası reddedilir");

    const tokenErr = await login({ sub: subN }, { tokenError: "invalid_grant" });
    assert.equal(errCode(tokenErr), "jeton", "token ucu hatası girişi durdurur");

    const claimsErr = await login({ sub: "" });
    assert.equal(errCode(claimsErr), "jeton_dogrulama", "sub'suz token reddedilir");
    assert.equal((await db.select({ id: users.id }).from(users).where(eq(users.oidcSubject, subN))).length, 0, "hiçbir hata yolunda hesap açılmadı");
    console.log("PASS OIDC hata yolları: state, nonce, imza, token hatası ve eksik sub reddediliyor; hesap açılmıyor.");

    // ── 6) Otomatik açma kapalı / MFA / ACCESS_TOKEN çakışması ──────────────
    process.env.OIDC_AUTO_PROVISION = "0";
    const noProvision = await login({ sub: `sub-${randomUUID()}`, preferred_username: `yeni.${randomUUID().slice(0, 6)}` });
    assert.equal(errCode(noProvision), "hesap", "OIDC_AUTO_PROVISION=0 iken tanımsız kimlik reddedilir");
    process.env.OIDC_AUTO_PROVISION = "1";

    process.env.OIDC_SKIP_TOTP = "0";
    const mfaName = `mfa.${randomUUID().slice(0, 6)}`;
    await db.insert(users).values({ username: mfaName, passwordHash: hashPassword("Mfa-parola-2026"), fullName: "MFA Hesabı", role: "yonetici", twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    createdUsernames.push(mfaName);
    const mfaRes = await login({ sub: `sub-${randomUUID()}`, email: `${mfaName}@hastane.local`, email_verified: true });
    assert.equal(errCode(mfaRes), "mfa_gerekli", "OIDC_SKIP_TOTP=0 ve MFA açıksa SSO ile girilmez (sessizce atlanmaz)");
    process.env.OIDC_SKIP_TOTP = "1";

    // Not: ACCESS_TOKEN modül yüklenirken okunur (access.ts); bu süreçte değiştirilemez.
    // Çakışma denetimi (409) bu yüzden burada değil, uç kodunda ve README'de belgelenmiştir.
    console.log("PASS OIDC politikası: otomatik açma kapalı ve MFA zorunluluğu doğru davranıyor.");

    // ── 7) Yapılandırma yoksa uçlar kapalı ──────────────────────────────────
    const issuer = process.env.OIDC_ISSUER;
    delete process.env.OIDC_ISSUER;
    assert.equal((await start.GET(new NextRequest("http://localhost/api/auth/oidc/start"))).status, 503, "yapılandırma yoksa başlatma 503");
    process.env.OIDC_ISSUER = issuer;

    const { oidcEnabled } = await import("../src/lib/server/oidc");
    assert.equal(oidcEnabled(), true);
    console.log("PASS OIDC yapılandırması: kapatıldığında uçlar 503 veriyor, açıldığında etkin.");
  } finally {
    for (const name of createdUsernames) {
      const row = (await db.select({ id: users.id }).from(users).where(eq(users.username, name)))[0];
      if (!row) continue;
      await db.delete(sessions).where(eq(sessions.userId, row.id));
      await db.delete(users).where(eq(users.id, row.id));
    }
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

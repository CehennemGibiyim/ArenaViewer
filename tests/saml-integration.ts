/**
 * SAML 2.0 girişi uçtan uca testi — SAHTE IdP + gerçek PostgreSQL.
 *
 *   DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
 *     npx tsx tests/saml-integration.ts
 *
 * Sahte IdP gerçek bir HTTP sunucusudur: SP'nin `/api/auth/saml/start` yönlendirmesini
 * alır, AuthnRequest'i (DEFLATE+base64) çözer, alanlarını doğrular ve **RSA ile
 * imzalanmış** SAMLResponse üretir. Test, dönüş ucunu gerçek `POST` isteğiyle çağırır.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { canonicalize, findFirst, namespaceScope, parseXml, pathTo, textContent } from "../src/lib/server/xmlC14n";
import { decodeRedirectRequest } from "../src/lib/server/saml";

const IDP_ENTITY = "https://idp.hastane.local/saml";
const SP_ENTITY = "atikviewer-sp";
const ADMIN_GROUP = "RAD-Yonetici";
const BASE = "http://localhost";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT = publicKey.export({ type: "spki", format: "pem" }).toString();

interface IdpUser {
  nameId: string;
  displayName: string;
  groups: string[];
}

const USERS: Record<string, IdpUser> = {
  "ayse.kaya@hastane.local": { nameId: "ayse.kaya@hastane.local", displayName: "Ayşe Kaya", groups: ["RAD-Doktorlar"] },
  "admin.ldap@hastane.local": { nameId: "admin.ldap@hastane.local", displayName: "Dizin Yönetici", groups: [ADMIN_GROUP] },
  "yeni.kisi@hastane.local": { nameId: "yeni.kisi@hastane.local", displayName: "Yeni Kişi", groups: [] },
};

/** Akış parametreleri (test her senaryoda bunları ayarlar). */
let scenario: {
  user: IdpUser;
  acs: string;
  audience: string;
  notAfterOffsetMs: number;
  tamperEmail?: string;
  inResponseTo?: string;
  omitSignature?: boolean;
} | null = null;

/** IdP gibi imzalar (SAML çekirdeğindeki c14n ile aynı kurallar). */
function buildSignedResponse(p: {
  requestId: string;
  acs: string;
  audience: string;
  user: IdpUser;
  notAfterOffsetMs?: number;
  tamperEmail?: string;
  omitSignature?: boolean;
}): string {
  const now = Date.now();
  const id = `_a${randomBytes(8).toString("hex")}`;
  const notAfter = new Date(now + (p.notAfterOffsetMs ?? 5 * 60_000)).toISOString();
  const notBefore = new Date(now - 60_000).toISOString();
  const email = p.user.nameId;

  const base = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="R${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${p.acs}" InResponseTo="${p.requestId}">
  <saml:Issuer>${IDP_ENTITY}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
    <saml:Issuer>${IDP_ENTITY}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notAfter}" Recipient="${p.acs}" InResponseTo="${p.requestId}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notAfter}">
      <saml:AudienceRestriction><saml:Audience>${p.audience}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="S-${id}">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="displayName"><saml:AttributeValue>${p.user.displayName}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="mail"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
      ${p.user.groups.map((g) => `<saml:Attribute Name="memberOf"><saml:AttributeValue>${g}</saml:AttributeValue></saml:Attribute>`).join("\n      ")}
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;

  const doc = parseXml(base);
  const assertion = findFirst(doc, "Assertion")!;
  const anc = pathTo(doc, assertion)!;
  const digest = createHash("sha256")
    .update(Buffer.from(canonicalize(assertion, { scope: namespaceScope(assertion, anc.slice(0, -1)), exclusive: true }), "utf8"))
    .digest("base64");
  const signedInfo = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#${id}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const c14nSignedInfo = canonicalize(parseXml(`<w xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}</w>`).children[0]);
  const sig = cryptoSign("RSA-SHA256", Buffer.from(c14nSignedInfo, "utf8"), privateKey).toString("base64");
  const sigXml = p.omitSignature
    ? ""
    : `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sig}</ds:SignatureValue></ds:Signature>`;
  const signed = base.replace("</saml:Assertion>", `${sigXml}</saml:Assertion>`);
  // Kurcalama senaryosu: değer İMZADAN SONRA değiştirilir (özet uyuşmazlığı beklenir).
  return p.tamperEmail
    ? signed.replaceAll(`<saml:AttributeValue>${p.user.nameId}</saml:AttributeValue>`, `<saml:AttributeValue>${p.tamperEmail}</saml:AttributeValue>`)
    : signed;
}

async function main() {
  if (process.env.AUTH_INTEGRATION_TEST !== "1" || !process.env.DATABASE_URL) {
    throw new Error("Yalnız ayrılmış test veritabanı için AUTH_INTEGRATION_TEST=1 ve DATABASE_URL gerekli.");
  }

  // ── Sahte IdP ────────────────────────────────────────────────────────────
  type ReqInfo = { id: string; acs: string; issuer: string; destination: string; relay: string };
  let lastRequest: ReqInfo | null = null;
  /** Kapanış içindeki atama yüzünden TS daralması olmasın diye erişimci. */
  const reqInfo = (): ReqInfo | null => lastRequest;
  const idp = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://idp.local");
    if (u.pathname !== "/sso") {
      res.writeHead(404).end("yok");
      return;
    }
    const encoded = u.searchParams.get("SAMLRequest") ?? "";
    let xml = "";
    try {
      xml = decodeRedirectRequest(encoded);
    } catch {
      res.writeHead(400).end("SAMLRequest çözülemedi");
      return;
    }
    const node = parseXml(xml);
    const issuer = textContent(findFirst(node, "Issuer") ?? node).trim();
    const id = node.attrs.find((a) => a.name === "ID")?.value ?? "";
    const acs = node.attrs.find((a) => a.name === "AssertionConsumerServiceURL")?.value ?? "";
    const destination = node.attrs.find((a) => a.name === "Destination")?.value ?? "";
    const relay = u.searchParams.get("RelayState") ?? "";
    lastRequest = { id, acs, issuer, destination, relay };

    // IdP, AuthnRequest'i doğrular (gerçek IdP'lerin asgari kontrolü)
    if (issuer !== SP_ENTITY || !id || !acs) {
      res.writeHead(400).end("SP isteği geçersiz");
      return;
    }
    const sc = scenario;
    if (!sc) {
      res.writeHead(500).end("senaryo yok");
      return;
    }
    const responseXml = buildSignedResponse({
      requestId: sc.inResponseTo ?? id,
      acs,
      audience: sc.audience,
      user: sc.user,
      notAfterOffsetMs: sc.notAfterOffsetMs,
      tamperEmail: sc.tamperEmail,
      omitSignature: sc.omitSignature,
    });
    const b64 = Buffer.from(responseXml, "utf8").toString("base64");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body><form id="f" method="post" action="${acs}">
        <input type="hidden" name="SAMLResponse" value="${b64}"/>
        <input type="hidden" name="RelayState" value="${relay}"/>
      </form></body></html>`
    );
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
  const idpPort = (idp.address() as { port: number }).port;

  // ── Ortam ────────────────────────────────────────────────────────────────
  process.env.AUTH_MODE = "hesap";
  process.env.SESSION_SECRET = "ci-only-saml-secret-0123456789";
  process.env.REQUIRE_TOTP_FOR_ROLES = "";
  delete process.env.ACCESS_TOKEN;
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.OIDC_ISSUER;
  delete process.env.LDAP_URL;
  process.env.SAML_IDP_SSO_URL = `http://127.0.0.1:${idpPort}/sso`;
  process.env.SAML_IDP_ENTITY_ID = IDP_ENTITY;
  process.env.SAML_IDP_CERT = CERT;
  process.env.SAML_ENTITY_ID = SP_ENTITY;
  process.env.SAML_ADMIN_GROUP = ADMIN_GROUP;
  process.env.SAML_AUTO_PROVISION = "1";
  process.env.SAML_SKIP_TOTP = "1";

  const { db, pool } = await import("../src/db/index");
  const { users, sessions, auditLogs, samlReplay } = await import("../src/db/schema");
  const { GET: startRoute } = await import("../src/app/api/auth/saml/start/route");
  const { POST: callbackRoute } = await import("../src/app/api/auth/saml/callback/route");
  const { GET: metadataRoute } = await import("../src/app/api/auth/saml/metadata/route");
  const { SESSION_COOKIE, verifySessionRef } = await import("../src/lib/server/session");
  const { SAML_COOKIE } = await import("../src/lib/server/saml");

  const created: number[] = [];

  const start = async (next = "/") => {
    const res = await startRoute(new NextRequest(`${BASE}/api/auth/saml/start?next=${encodeURIComponent(next)}`));
    const location = res.headers.get("location") ?? "";
    const cookie = res.cookies.get(SAML_COOKIE)?.value ?? "";
    return { status: res.status, location, cookie, request: reqInfo() };
  };

  /** IdP'yi "tarayıcı gibi" çağırır ve dönen form alanlarını toplar. */
  const idpPost = async (ssoUrl: string) => {
    const r = await fetch(ssoUrl, { redirect: "manual" });
    const html = await r.text();
    const get = (name: string) => {
      const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
      return m ? m[1] : "";
    };
    return { SAMLResponse: get("SAMLResponse"), RelayState: get("RelayState") };
  };

  const callback = async (cookie: string, form: { SAMLResponse: string; RelayState: string }) => {
    const body = new FormData();
    body.set("SAMLResponse", form.SAMLResponse);
    body.set("RelayState", form.RelayState);
    const req = new NextRequest(`${BASE}/api/auth/saml/callback`, {
      method: "POST",
      body,
      headers: cookie ? { cookie: `${SAML_COOKIE}=${cookie}` } : {},
    });
    const res = await callbackRoute(req);
    return {
      status: res.status,
      location: res.headers.get("location") ?? "",
      session: res.cookies.get(SESSION_COOKIE)?.value ?? "",
    };
  };

  const login = async (userKey: string, opts: Partial<NonNullable<typeof scenario>> = {}) => {
    const s = await start();
    // Senaryo, IdP'ye gidilmeden ÖNCE kurulur: yanıt orada imzalanır.
    scenario = { user: USERS[userKey], acs: s.request?.acs ?? "", audience: SP_ENTITY, notAfterOffsetMs: 5 * 60_000, ...opts };
    const form = await idpPost(s.location);
    const cb = await callback(s.cookie, form);
    return { start: s, form, cb };
  };

  const cleanup = async () => {
    for (const id of created) {
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  };

  // Test hermeticliği
  const staleNames = ["ayse.kaya", "admin.ldap", "yeni.kisi"];
  const stale = await db.select({ id: users.id }).from(users).where(inArray(users.username, staleNames));
  for (const row of stale) {
    await db.delete(sessions).where(eq(sessions.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }
  await db.delete(samlReplay);

  try {
    // ── 1) Start: AuthnRequest doğru üretiliyor mu ─────────────────────────
    const s1 = await start();
    assert.equal(s1.status, 303, "IdP'ye yönlendirme");
    assert.ok(s1.location.startsWith(process.env.SAML_IDP_SSO_URL!), `SSO ucuna gider (${s1.location})`);
    assert.ok(s1.cookie, "imzalı durum çerezi yazılır");

    // ── 2) Başarılı dönüş: hesap + oturum + denetim ────────────────────────
    scenario = { user: USERS["ayse.kaya@hastane.local"], acs: "", audience: SP_ENTITY, notAfterOffsetMs: 5 * 60_000 };
    const form1 = await idpPost(s1.location);
    assert.ok(form1.SAMLResponse.length > 100, "IdP imzalı yanıt üretti");
    const req = reqInfo();
    assert.ok(req, "IdP AuthnRequest'i aldı");
    assert.equal(req!.issuer, SP_ENTITY, "Issuer = SP entityID");
    assert.equal(req!.destination, process.env.SAML_IDP_SSO_URL, "Destination = SSO ucu");
    assert.ok(req!.acs.endsWith("/api/auth/saml/callback"), "ACS adresi bildirilir");
    assert.ok(req!.id.startsWith("_"), "AuthnRequest ID biçimi");
    console.log("PASS SAML start: AuthnRequest alanları, SSO yönlendirmesi, imzalı durum çerezi.");
    const cb1 = await callback(s1.cookie, form1);
    assert.equal(cb1.status, 303, "başarılı dönüş yönlendirir");
    assert.ok(!cb1.location.includes("saml_error"), `hata yok (${cb1.location})`);
    const ref = verifySessionRef(cb1.session);
    assert.ok(ref && /^[a-f0-9]{32}$/.test(ref.sid), "sunucu oturumu kuruldu");
    created.push(ref!.uid);
    const u = (await db.select().from(users).where(eq(users.id, ref!.uid)))[0];
    assert.equal(u.username, "ayse.kaya", "kullanıcı adı NameID'nin yerel kısmı");
    assert.equal(u.fullName, "Ayşe Kaya");
    assert.equal(u.samlIssuer, IDP_ENTITY, "IdP entityID hesaba yazılır");
    assert.equal(u.samlNameId, "ayse.kaya@hastane.local", "NameID hesaba yazılır");
    assert.equal(u.passwordHash, "-", "parola uygulamada tutulmaz");
    assert.equal(u.role, "radyolog");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login.saml"));
    assert.ok(audits.length > 0, "denetim kaydı yazıldı");
    assert.match(audits[audits.length - 1].details, /"created":true/);
    console.log("PASS SAML dönüşü: imza doğrulandı, hesap açıldı, oturum + denetim yazıldı.");

    // ── 3) Replay: aynı Assertion ikinci kez reddedilir ────────────────────
    const replay = await callback(s1.cookie, form1);
    assert.equal(replay.status, 303);
    assert.match(decodeURIComponent(replay.location), /saml_error=yeniden/, "aynı yanıt yeniden kullanılamaz");
    assert.ok(!replay.session, "replay'de oturum kurulmaz");
    console.log("PASS SAML replay koruması: aynı Assertion ID ikinci kez kabul edilmiyor.");

    // ── 4) Tekrar giriş: mükerrer hesap yok ───────────────────────────────
    const second = await login("ayse.kaya@hastane.local");
    assert.equal(second.cb.status, 303);
    assert.ok(!second.cb.location.includes("saml_error"));
    const ref2 = verifySessionRef(second.cb.session);
    assert.equal(ref2?.uid, ref!.uid, "aynı hesaba bağlanır");
    assert.equal((await db.select({ id: users.id }).from(users).where(eq(users.samlNameId, "ayse.kaya@hastane.local"))).length, 1, "mükerrer hesap yok");
    console.log("PASS SAML tekrar giriş: (issuer, NameID) eşleşmesiyle aynı hesap.");

    // ── 5) Yönetici grubu → yönetici rolü ─────────────────────────────────
    const adm = await login("admin.ldap@hastane.local");
    assert.ok(!adm.cb.location.includes("saml_error"), `yönetici girişi (${adm.cb.location})`);
    const refA = verifySessionRef(adm.cb.session);
    created.push(refA!.uid);
    const ua = (await db.select().from(users).where(eq(users.id, refA!.uid)))[0];
    assert.equal(ua.role, "yonetici", "SAML_ADMIN_GROUP üyeliği yönetici yapar");
    console.log("PASS SAML rolü: yönetici grubu yönetici rolüyle hesap açar.");

    // ── 6) Otomatik açma kapalı ────────────────────────────────────────────
    process.env.SAML_AUTO_PROVISION = "0";
    const noProv = await login("yeni.kisi@hastane.local");
    assert.match(decodeURIComponent(noProv.cb.location), /saml_error=hesap/, "tanımsız kimlik reddedilir");
    assert.equal((await db.select({ id: users.id }).from(users).where(eq(users.username, "yeni.kisi"))).length, 0, "hesap açılmadı");
    process.env.SAML_AUTO_PROVISION = "1";
    console.log("PASS SAML politikası: SAML_AUTO_PROVISION=0 iken hesap açılmaz.");

    // ── 7) MFA politikası ──────────────────────────────────────────────────
    process.env.SAML_SKIP_TOTP = "0";
    process.env.REQUIRE_TOTP_FOR_ROLES = "yonetici";
    const mfa = await login("admin.ldap@hastane.local");
    assert.match(decodeURIComponent(mfa.cb.location), /saml_error=mfa_gerekli/, "yönetici SSO ile MFA'yı atlayamaz");
    process.env.SAML_SKIP_TOTP = "1";
    process.env.REQUIRE_TOTP_FOR_ROLES = "";
    console.log("PASS SAML MFA: SKIP_TOTP kapalıyken yönetici SSO'da reddedilir.");

    // ── 8) Kurcalanmış / imzasız / süresi geçmiş yanıtlar ─────────────────
    const tampered = await login("ayse.kaya@hastane.local", { tamperEmail: "saldirgan@hastane.local" });
    assert.match(decodeURIComponent(tampered.cb.location), /saml_error=özet/, "içerik kurcalaması yakalanır");
    const unsigned = await login("ayse.kaya@hastane.local", { omitSignature: true });
    assert.match(decodeURIComponent(unsigned.cb.location), /saml_error=imza/, "imzasız yanıt reddedilir");
    const expired = await login("ayse.kaya@hastane.local", { notAfterOffsetMs: -10 * 60_000 });
    assert.match(decodeURIComponent(expired.cb.location), /saml_error=sure/, "süresi geçmiş yanıt reddedilir");
    const wrongAudience = await login("ayse.kaya@hastane.local", { audience: "baska-sp" });
    assert.match(decodeURIComponent(wrongAudience.cb.location), /saml_error=izleyici/, "başka SP için yanıt reddedilir");
    const wrongReq = await login("ayse.kaya@hastane.local", { inResponseTo: "_sahte-istek" });
    assert.match(decodeURIComponent(wrongReq.cb.location), /saml_error=istek/, "başka isteğe ait yanıt reddedilir");
    console.log("PASS SAML saldırı yolları: kurcalama, imzasız, süre, audience ve InResponseTo reddedildi.");

    // ── 9) Durum çerezi yok / bozuk ────────────────────────────────────────
    const noCookie = await callback("", form1);
    assert.match(decodeURIComponent(noCookie.location), /saml_error=durum/, "çerezsiz dönüş reddedilir");
    const badCookie = await callback("bozuk.deger", form1);
    assert.match(decodeURIComponent(badCookie.location), /saml_error=durum/, "imzasız çerez reddedilir");
    console.log("PASS SAML CSRF/durum: çerezsiz ve bozuk çerezle dönüş kabul edilmiyor.");

    // ── 10) SP metadata ucu ───────────────────────────────────────────────
    const meta = await metadataRoute(new NextRequest(`${BASE}/api/auth/saml/metadata`));
    const metaXml = await meta.text();
    assert.equal(meta.status, 200);
    assert.match(meta.headers.get("content-type") ?? "", /samlmetadata\+xml/);
    assert.match(metaXml, /entityID="atikviewer-sp"/);
    assert.match(metaXml, /AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http:\/\/localhost\/api\/auth\/saml\/callback"/);
    console.log("PASS SAML metadata: entityID ve ACS adresi yayınlanıyor.");
  } finally {
    await cleanup();
    await new Promise<void>((r) => idp.close(() => r()));
    await db.delete(samlReplay).catch(() => undefined);
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

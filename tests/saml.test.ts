import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  authnRequestRedirect,
  buildAuthnRequest,
  decodeRedirectRequest,
  newSamlId,
  normalizeCertificate,
  samlConfig,
  samlErrorText,
  signSamlState,
  spMetadata,
  verifySamlResponse,
  verifySamlState,
  type SamlConfig,
} from "../src/lib/server/saml";
import { canonicalize, childNamed, findFirst, parseXml, pathTo, namespaceScope, textContent } from "../src/lib/server/xmlC14n";

/**
 * SAML 2.0 SP çekirdek testleri — AĞ ve VERİTABANI YOK.
 *
 * Kanıtlanan: XML ayrıştırma güvenliği (DTD/XXE reddi), c14n bilinen-yanıt
 * örnekleri, AuthnRequest/redirect binding, imzalı durum çerezi, XML DSig
 * doğrulaması (imza + özet), koşullar (süre/audience/recipient/InResponseTo),
 * SHA-1 reddi ve talep→kimlik eşlemesi.
 *
 * İmzalı yanıtlar test içinde gerçek RSA anahtarıyla üretilir: "IdP" tarafı
 * belgeyi kanonikleştirip imzalar, SP tarafı bağımsız olarak yeniden doğrular.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT = publicKey.export({ type: "spki", format: "pem" }).toString();

const IDP = "https://idp.hastane.local/saml";
const SP = "atikviewer-sp";
const ACS = "https://rad.hastane.local/api/auth/saml/callback";
const REQ = "_req1234567890";

const cfg: SamlConfig = {
  idpSsoUrl: "https://idp.hastane.local/sso",
  idpEntityId: IDP,
  idpCertPem: CERT,
  entityId: SP,
  acsUrl: ACS,
  label: "Kurumsal",
  attrName: "displayName",
  attrMail: "mail",
  attrGroups: "memberOf",
  nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  adminGroup: "RAD-Yonetici",
  defaultRole: "radyolog",
  autoProvision: true,
  linkByEmail: false,
  skipTotp: true,
  clockSkewSec: 120,
  allowSha1: false,
};

interface SignedInput {
  audience?: string;
  recipient?: string;
  inResponseTo?: string;
  issuer?: string;
  status?: string;
  assertionNotAfterMs?: number;
  conditionsNotBeforeMs?: number;
  signWith?: "rsa-sha256" | "rsa-sha1";
  omitSignature?: boolean;
  email?: string;
  groups?: string[];
  displayName?: string;
  id?: string;
}

/** IdP gibi davranır: assertion üretir, kanonikleştirir, imzalar, zarfı kurar. */
function signedResponse(o: SignedInput = {}): { xml: string; b64: string } {
  const now = Date.now();
  const id = o.id ?? "A1";
  const notAfter = new Date(o.assertionNotAfterMs ?? now + 5 * 60_000).toISOString();
  const notBefore = new Date(o.conditionsNotBeforeMs ?? now - 60_000).toISOString();
  const groups = o.groups ?? ["RAD-Doktorlar"];
  const sigAlg = o.signWith === "rsa-sha1" ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const digestAlg = o.signWith === "rsa-sha1" ? "http://www.w3.org/2000/09/xmldsig#sha1" : "http://www.w3.org/2001/04/xmlenc#sha256";

  const docWithoutSig = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="R-${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${ACS}" InResponseTo="${o.inResponseTo ?? REQ}">
  <saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="${o.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>
  <saml:Assertion xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
    <saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email ?? "ayse.kaya@hastane.local"}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notAfter}" Recipient="${o.recipient ?? ACS}" InResponseTo="${o.inResponseTo ?? REQ}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notAfter}">
      <saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="S-1">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="displayName"><saml:AttributeValue>${o.displayName ?? "Ayşe Kaya"}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="mail"><saml:AttributeValue>${o.email ?? "ayse.kaya@hastane.local"}</saml:AttributeValue></saml:Attribute>
      ${groups.map((g) => `<saml:Attribute Name="memberOf"><saml:AttributeValue>${g}</saml:AttributeValue></saml:Attribute>`).join("\n      ")}
    </saml:AttributeStatement>
    </saml:Assertion>
</samlp:Response>`;

  // 1) Assertion'ı (imza hariç) kanonikleştir → DigestValue
  const doc0 = parseXml(docWithoutSig);
  const assertion0 = findFirst(doc0, "Assertion")!;
  const ancestors0 = pathTo(doc0, assertion0)!;
  const scope0 = namespaceScope(assertion0, ancestors0.slice(0, -1));
  const digest = createHash(o.signWith === "rsa-sha1" ? "sha1" : "sha256")
    .update(Buffer.from(canonicalize(assertion0, { scope: scope0, exclusive: true }), "utf8"))
    .digest("base64");

  // 2) SignedInfo kur (ds ad alanı Signature üzerinde bildirilir → konumdan bağımsız)
  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="${sigAlg}"/><ds:Reference URI="#${id}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="${digestAlg}"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const signedInfoC14n = canonicalize(parseXml(`<w xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfoXml}</w>`).children[0]);
  const signature = cryptoSign(o.signWith === "rsa-sha1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(signedInfoC14n, "utf8"), privateKey).toString("base64");

  const sigXml = o.omitSignature
    ? ""
    : `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfoXml}<ds:SignatureValue>${signature}</ds:SignatureValue></ds:Signature>`;

  const xml = docWithoutSig.replace("</saml:Assertion>", `${sigXml}</saml:Assertion>`);
  return { xml, b64: Buffer.from(xml, "utf8").toString("base64") };
}

function main() {
  /* ── 1) Yapılandırma ─────────────────────────────────────────────────── */
  assert.equal(samlConfig({} as NodeJS.ProcessEnv), null, "zorunlu alanlar yoksa kapalı");
  assert.equal(
    samlConfig({ SAML_IDP_SSO_URL: "https://x/sso", SAML_IDP_ENTITY_ID: "https://x", SAML_IDP_CERT: "bozuk" } as unknown as NodeJS.ProcessEnv),
    null,
    "bozuk sertifika özelliği kapatır"
  );
  const conf = samlConfig({
    SAML_IDP_SSO_URL: "https://x/sso",
    SAML_IDP_ENTITY_ID: "https://x",
    SAML_IDP_CERT: CERT,
  } as unknown as NodeJS.ProcessEnv)!;
  assert.ok(conf, "geçerli yapılandırma");
  assert.equal(conf.entityId, "atikviewer-sp");
  assert.equal(conf.linkByEmail, false, "SAML'de e-posta ile bağlama varsayılan KAPALI");
  assert.equal(conf.clockSkewSec, 120);
  assert.equal(conf.allowSha1, false);
  assert.equal(normalizeCertificate(CERT), CERT.trim(), "PEM sertifika/açık anahtar olduğu gibi kabul edilir");
  const wrapped = normalizeCertificate(CERT.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  assert.match(wrapped, /^-----BEGIN CERTIFICATE-----/, "yalın base64 DER sertifikaya sarılır");
  assert.equal(normalizeCertificate("bu bir sertifika değil ✗"), "", "geçersiz metin boş döner");
  console.log("PASS SAML yapılandırması: zorunlu alanlar, sertifika normalizasyonu, güvenli varsayılanlar.");

  /* ── 2) XML güvenliği ────────────────────────────────────────────────── */
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY e "y">]><a/>'), /DTD/, "DTD/ENTITY reddedilir (XXE)");
  assert.throws(() => parseXml("<a><b></a>"), /eşleşmeyen/, "eşleşmeyen etiket");
  assert.throws(() => parseXml("<a>&bilinmeyen;</a>"), /bilinmeyen varlık/, "tanımsız varlık");
  assert.throws(() => parseXml("<a/><b/>"), /tek kök/);
  const ent = parseXml('<a t="&quot;x&quot;">1 &lt; 2 &#65; &#x42;<![CDATA[<raw>]]></a>');
  assert.equal(ent.attrs[0].value, '"x"');
  assert.equal(textContent(ent), '1 < 2 A B<raw>');
  const withComment = parseXml("<a><!-- yorum --><b/></a>");
  assert.equal(withComment.children.length, 1, "yorumlar ağaca girmez");
  console.log("PASS XML güvenliği: DTD/ENTITY yok, varlık çözümü, CDATA/yorum, hatalı belge reddi.");

  /* ── 3) Kanonikleştirme (bilinen yanıt) ──────────────────────────────── */
  assert.equal(
    canonicalize(parseXml('<b xmlns="urn:x" z="1" a="2"><c/>metin</b>')),
    '<b xmlns="urn:x" a="2" z="1"><c></c>metin</b>',
    "öznitelikler sıralanır, boş öğe açık kapanır"
  );
  assert.equal(
    canonicalize(parseXml('<e xmlns:a="urn:a" xmlns:b="urn:b"><a:n/></e>')),
    '<e xmlns:a="urn:a"><a:n></a:n></e>',
    "exclusive c14n kullanılmayan `b` bildirimini atar"
  );
  const { privateKey: _k, publicKey: _p } = { privateKey: null, publicKey: null };
  void _k;
  void _p;
  const escaped = canonicalize(parseXml('<a v="&lt;&amp;&quot;&#x9;">&lt;&amp;&gt;</a>'));
  assert.equal(escaped, '<a v="&lt;&amp;&quot;&#x9;">&lt;&amp;&gt;</a>', "metin/öznitelik kaçışı");
  console.log("PASS c14n: sıralama, exclusive ad alanı elemesi, kaçış kuralları (bilinen yanıt).");

  /* ── 4) AuthnRequest / redirect binding ──────────────────────────────── */
  const xml = buildAuthnRequest({
    id: "_abc",
    issueInstant: "2026-01-01T00:00:00.000Z",
    acsUrl: ACS,
    entityId: SP,
    destination: cfg.idpSsoUrl,
    nameIdFormat: cfg.nameIdFormat,
  });
  assert.match(xml, /ID="_abc"/);
  assert.match(xml, /AssertionConsumerServiceURL="https:\/\/rad\.hastane\.local\/api\/auth\/saml\/callback"/);
  assert.match(xml, /<saml:Issuer>atikviewer-sp<\/saml:Issuer>/);
  assert.match(xml, /ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"/);
  const red = authnRequestRedirect(cfg, { id: "_abc", acsUrl: ACS, relayState: "relay-1" });
  const u = new URL(red.url);
  assert.equal(u.origin + u.pathname, cfg.idpSsoUrl, "IdP SSO ucuna yönlendirir");
  assert.equal(u.searchParams.get("RelayState"), "relay-1");
  const decoded = decodeRedirectRequest(u.searchParams.get("SAMLRequest")!);
  assert.match(decoded, /ID="_abc"/, "DEFLATE + base64 gidiş-dönüş");
  assert.match(spMetadata(cfg, ACS), /entityID="atikviewer-sp"/);
  assert.match(spMetadata(cfg, ACS), /AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="[^"]+"/);
  console.log("PASS AuthnRequest: alanlar, DEFLATE+base64 redirect, SP metadata.");

  /* ── 5) İmzalı durum çerezi ──────────────────────────────────────────── */
  const env = { SESSION_SECRET: "test-secret-0123456789abcdef" } as unknown as NodeJS.ProcessEnv;
  const st = signSamlState({ i: REQ, r: "relay-1", a: ACS, x: "/rapor/1" }, env)!;
  assert.ok(verifySamlState(st, env), "geçerli durum");
  assert.equal(verifySamlState(st, env)!.x, "/rapor/1", "dönüş yolu korunur");
  assert.equal(verifySamlState(st.replace(/.$/, st.endsWith("A") ? "B" : "A"), env), null, "imza kurcalaması reddedilir");
  assert.equal(verifySamlState(signSamlState({ i: REQ, r: "r", a: ACS, x: "//kotu", t: Date.now() }, env)!, env)!.x, "/", "dış adres engellenir");
  assert.equal(verifySamlState(st, env, Date.now() + 11 * 60_000), null, "10 dakikada süresi dolar");
  assert.equal(signSamlState({ i: REQ, r: "r", a: ACS, x: "/" }, {} as NodeJS.ProcessEnv), null, "anahtar yoksa imzalanmaz");
  console.log("PASS durum çerezi: imza, süre, yerel yol kısıtı.");

  /* ── 6) Geçerli yanıt → kimlik ───────────────────────────────────────── */
  const good = signedResponse({ groups: ["RAD-Doktorlar", "RAD-Yonetici"] });
  const ok = verifySamlResponse({
    samlResponse: good.b64,
    cfg,
    requestId: REQ,
    acsUrl: ACS,
    relayState: "relay-1",
    expectedRelayState: "relay-1",
  });
  assert.ok(ok.ok, `geçerli yanıt kabul edilmeli (${!ok.ok ? ok.reason : ""})`);
  if (ok.ok) {
    assert.equal(ok.identity.username, "ayse.kaya", "kullanıcı adı e-postadan");
    assert.equal(ok.identity.fullName, "Ayşe Kaya");
    assert.equal(ok.identity.email, "ayse.kaya@hastane.local");
    assert.equal(ok.identity.role, "yonetici", "yönetici grubu rolü yükseltir");
    assert.equal(ok.identity.nameId, "ayse.kaya@hastane.local");
    assert.equal(ok.assertionId, "A1");
    assert.equal(ok.identity.sessionIndex, "S-1");
  }
  console.log("PASS SAML yanıtı: imza + koşullar doğrulandı, talepler kimliğe eşlendi.");

  /* ── 7) Kanonikleştirme gerçekten normalize ediyor mu ────────────────── */
  // İmzadan SONRA yalnız c14n'in normalize ettiği biçim değişiklikleri yapılır:
  // öznitelik sırası, öznitelikler arası fazla boşluk, `<x/>` ↔ `<x></x>`.
  // (Öğe içindeki boşluk metin içeriğidir; onu değiştirmek imzayı haklı olarak bozar.)
  const reformatted = good.xml
    .replace('ID="A1" Version="2.0"', 'Version="2.0"    ID="A1"')
    .replace("<saml:SubjectConfirmationData ", "<saml:SubjectConfirmationData   ")
    .replace(
      /<saml:SubjectConfirmationData([^>]*)\/>/,
      "<saml:SubjectConfirmationData$1></saml:SubjectConfirmationData>"
    );
  const reOk = verifySamlResponse({
    samlResponse: Buffer.from(reformatted, "utf8").toString("base64"),
    cfg,
    requestId: REQ,
    acsUrl: ACS,
    relayState: "r",
    expectedRelayState: "r",
  });
  assert.ok(reOk.ok, `biçim değişikliği imzayı bozmamalı (${!reOk.ok ? reOk.reason : ""})`);

  // Öğe içindeki metin değişirse özet değişir (boşluk duyarlılığı bilinçli).
  const spaceTampered = good.xml.replace("</saml:Conditions>", "</saml:Conditions>   ");
  const spaceRes = verifySamlResponse({
    samlResponse: Buffer.from(spaceTampered, "utf8").toString("base64"),
    cfg,
    requestId: REQ,
    acsUrl: ACS,
    relayState: "r",
    expectedRelayState: "r",
  });
  assert.equal(spaceRes.ok, false, "öğe içi metin değişikliği imzayı bozar");
  if (!spaceRes.ok) assert.equal(spaceRes.reason, "özet");
  console.log("PASS c14n normalizasyonu: öznitelik sırası/boşluk ve boş öğe biçimi tolere edilir, metin değişikliği edilmez.");

  /* ── 8) Saldırı/hata yolları ─────────────────────────────────────────── */
  const cases: [string, SignedInput, string][] = [
    ["imzasız yanıt", { omitSignature: true }, "imza"],
    ["yanlış audience", { audience: "baska-sp" }, "izleyici"],
    ["süresi geçmiş", { assertionNotAfterMs: Date.now() - 10 * 60_000 }, "sure"],
    ["henüz geçerli değil", { conditionsNotBeforeMs: Date.now() + 10 * 60_000 }, "sure"],
    ["yanlış recipient", { recipient: "https://saldirgan.example/acs" }, "alici"],
    ["başka isteğe ait", { inResponseTo: "_baska" }, "istek"],
    ["yanlış veren", { issuer: "https://sahte-idp.example" }, "veren"],
    ["başarısız durum", { status: "urn:oasis:names:tc:SAML:2.0:status:Requester" }, "durum"],
    ["SHA-1 imza", { signWith: "rsa-sha1" }, "sha1"],
  ];
  for (const [ad, input, reason] of cases) {
    const r = verifySamlResponse({
      samlResponse: signedResponse(input).b64,
      cfg,
      requestId: REQ,
      acsUrl: ACS,
      relayState: "r",
      expectedRelayState: "r",
    });
    assert.equal(r.ok, false, `${ad} reddedilmeli`);
    if (!r.ok) assert.equal(r.reason, reason, `${ad}: beklenen neden ${reason}, gelen ${r.reason}`);
  }
  console.log(`PASS saldırı yolları: ${cases.length} olumsuz senaryo doğru nedenle reddedildi.`);

  // İçerik kurcalama: imzadan sonra e-posta değiştirilir → özet uyuşmaz.
  const tamperedXml = good.xml.replace("ayse.kaya@hastane.local", "baskasi@hastane.local");
  const tampered = verifySamlResponse({
    samlResponse: Buffer.from(tamperedXml, "utf8").toString("base64"),
    cfg,
    requestId: REQ,
    acsUrl: ACS,
    relayState: "r",
    expectedRelayState: "r",
  });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.reason, "özet", `kurcalama özet uyuşmazlığı vermeli (${tampered.reason})`);

  // SHA-1 politikası açılırsa SHA-1 imza kabul edilir (bilinçli, belgelenmiş sapma).
  const sha1ok = verifySamlResponse({
    samlResponse: signedResponse({ signWith: "rsa-sha1" }).b64,
    cfg: { ...cfg, allowSha1: true },
    requestId: REQ,
    acsUrl: ACS,
    relayState: "r",
    expectedRelayState: "r",
  });
  assert.ok(sha1ok.ok, "SAML_ALLOW_SHA1=1 ile SHA-1 kabul edilir");

  // RelayState uyuşmazlığı (CSRF bağlacı)
  const relayBad = verifySamlResponse({
    samlResponse: good.b64,
    cfg,
    requestId: REQ,
    acsUrl: ACS,
    relayState: "saldirgan",
    expectedRelayState: "relay-1",
  });
  assert.equal(relayBad.ok, false);
  if (!relayBad.ok) assert.equal(relayBad.reason, "durum_baglaci");
  console.log("PASS içerik kurcalama (özet), SHA-1 politikası ve RelayState bağlacı.");

  /* ── 9) Hata metinleri ───────────────────────────────────────────────── */
  assert.match(samlErrorText("özet"), /değiştirilmiş/);
  assert.match(samlErrorText("yeniden"), /kullanılmış/);
  assert.match(samlErrorText("bilinmeyen_kod"), /bilinmeyen_kod/);
  assert.match(samlErrorText("izleyici"), /audience|uygulama/);
  const id = newSamlId();
  assert.match(id, /^_[a-f0-9]{32}$/, "AuthnRequest ID biçimi");
  console.log("PASS hata metinleri ve ID üretimi.");

  // Kullanılmayan yardımcılar (tip denetimi için)
  void childNamed;
  console.log("Tüm SAML çekirdek testleri geçti.");
}

main();

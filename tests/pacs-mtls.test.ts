/**
 * A0.2 — kurumsal PACS TLS/mTLS yapılandırması — sözleşme testleri.
 *
 * Gerçek TLS el sıkışması: openssl ile geçici CA + sunucu + istemci sertifikaları
 * üretilir; mutual TLS isteyen bir https mock PACS ayağa kalkar ve uygulamanın
 * DICOMweb istemcisi ona bağlanır. Özel anahtarlar yalnız geçici dizinde yaşar,
 * depoya yazılmaz. Ek olarak: sır saklama (AES-256-GCM) roundtrip ve yönetim
 * görünümü (publicPacsConfig) denetlenir.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

process.env.DATA_ENCRYPTION_KEYS = randomBytes(32).toString("base64");

import { encryptText, isEncrypted } from "../src/lib/server/crypto";
import { coercePacsConfig, publicPacsConfig, qidoStudies, unsealPacsConfig } from "../src/lib/server/pacs";
import { DEFAULT_PACS, EMPTY_TLS, type PacsConfig } from "../src/lib/pacsPresets";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-mtls-"));
const f = (name: string) => path.join(tmp, name);
const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });

// ── geçici test PKI: CA → sunucu (SAN: localhost/127.0.0.1) + istemci ──
openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("ca.key")]);
openssl(["req", "-x509", "-new", "-key", f("ca.key"), "-days", "1", "-subj", "/CN=ArenaViewer Test CA", "-out", f("ca.crt")]);
openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("server.key")]);
openssl(["req", "-new", "-key", f("server.key"), "-subj", "/CN=localhost", "-out", f("server.csr")]);
fs.writeFileSync(f("san.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
openssl(["x509", "-req", "-in", f("server.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "1", "-extfile", f("san.ext"), "-out", f("server.crt")]);
openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("client.key")]);
openssl(["req", "-new", "-key", f("client.key"), "-subj", "/CN=arena-test-client", "-out", f("client.csr")]);
openssl(["x509", "-req", "-in", f("client.csr"), "-CA", f("ca.crt"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "1", "-out", f("client.crt")]);
const pem = (name: string) => fs.readFileSync(f(name), "utf8");
const caPem = pem("ca.crt"), serverCert = pem("server.crt"), serverKey = pem("server.key");
const clientCertPem = pem("client.crt"), clientKeyPem = pem("client.key");

const baseCfg = (over: Partial<PacsConfig> = {}): PacsConfig => ({
  ...DEFAULT_PACS,
  name: "mTLS test PACS",
  qidoRoot: "", // sonra doldurulur
  auth: { ...DEFAULT_PACS.auth, type: "none" },
  tls: { ...EMPTY_TLS },
  ...over,
});

// mutual TLS isteyen mock PACS: QIDO studies boş liste döner
const server = https.createServer(
  { key: serverKey, cert: serverCert, ca: caPem, requestCert: true, rejectUnauthorized: true },
  (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/dicom+json" });
    res.end("[]");
  },
);

async function main(): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const root = `https://127.0.0.1:${port}/dicom-web`;

  try {
    // 1) doğru CA + istemci sertifikası ile bağlantı kurulur
    const cfgOk = baseCfg({ qidoRoot: root, tls: { caPem, clientCertPem, clientKeyPem } });
    const studies = await qidoStudies(cfgOk, "");
    assert.deepEqual(studies, []);
    console.log("PASS mTLS: doğru CA + istemci sertifikasıyla bağlantı");

    // 2) istemci sertifikası olmadan el sıkışma reddedilir
    const cfgNoClient = baseCfg({ qidoRoot: root, tls: { caPem, clientCertPem: "", clientKeyPem: "" } });
    await assert.rejects(qidoStudies(cfgNoClient, ""), /TLS|PACS|sertif/i);
    console.log("PASS mTLS: istemci sertifikası yoksa bağlantı reddedilir");

    // 3) yalnız server uygulaması sertifikası — CA anahtarı olmadan imzalanmış içerik reddedilir
    const rogue = baseCfg({ qidoRoot: root, tls: { caPem: clientCertPem, clientCertPem, clientKeyPem } });
    await assert.rejects(qidoStudies(rogue, ""));
    console.log("PASS mTLS: yanlış CA ile doğrulama başarısız");

    // 4) publicPacsConfig: özel anahtar sızdırılmaz; varlığı bayrakla bildirilir
    const pub = publicPacsConfig({ ...cfgOk, tls: { ...cfgOk.tls, clientKeyPem: encryptText(clientKeyPem) } });
    assert.equal(pub.tls.clientKeyPem, "", "özel anahtar yönetim görünümüne sızmaz");
    assert.equal(pub.hasClientKey, true, "anahtar varlığı bayrakla bildirilir");
    assert.equal(pub.tls.caPem, caPem, "CA gizli değildir; korunur");
    console.log("PASS publicPacsConfig: anahtar gizli, CA görünür, hasClientKey doğru");

    // 5) şifreli roundtrip: DB'de AES-256-GCM, çalışma zamanında çözülmüş
    const sealed = { ...cfgOk, tls: { ...cfgOk.tls, clientKeyPem: encryptText(clientKeyPem) } };
    assert.ok(isEncrypted(sealed.tls.clientKeyPem), "test kurulumu: anahtar şifreli saklanıyor");
    const unsealed = unsealPacsConfig(sealed);
    assert.equal(unsealed.tls.clientKeyPem, clientKeyPem, "roundtrip anahtarı geri yükler");
    console.log("PASS AES-256-GCM: clientKeyPem şifreli saklanır, çalışma zamanında çözülür");

    // 6) eski kayıt (tls alanı yok) geriye uyumlu yüklenir
    const { tls: _dropped, ...legacy } = BASE_DEFAULT();
    const coerced = coercePacsConfig({ ...legacy, qidoRoot: "https://pacs.kurum.local/dicom-web" });
    assert.ok(coerced, "tls alanı olmayan eski kayıt yüklenir");
    assert.deepEqual(coerced.tls, EMPTY_TLS, "eksik tls alanı güvenli varsayılanla doldurulur");
    console.log("PASS geriye uyumluluk: tls alanı olmayan eski PACS kaydı");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("Tüm pacs-mtls testleri geçti.");
}

/** DEFAULT_PACS'ın tls alanı çıkarılmış kopyası (eski kayıt simülasyonu). */
function BASE_DEFAULT(): PacsConfig {
  return { ...DEFAULT_PACS };
}

main().catch((e) => { const msg = e instanceof Error ? e.message : String(e); console.error("pacs-mtls testi başarısız:", msg.replace(/[\r\n]+/g, " ")); process.exitCode = 1; });

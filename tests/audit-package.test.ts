/**
 * w-audit: imzalı denetim paketi ve üretim modu kapısı testleri.
 *
 * Paketin kurcalamaya karşı davranışı sınanır: satır değişikliği, satır silme
 * (zincir kopması), manifest alanı oynama, imza yokluğu/yanlış sır ve boş paket.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  authModeGate,
  buildManifest,
  chainHash,
  eventsDigest,
  signPackage,
  signaturePayload,
  verifyPackage,
  verifyReport,
  verifySignature,
  type AuditEventLike,
  type AuditPackage,
} from "../src/lib/auditExport";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sunucudaki audit() ile aynı biçimde zincir üretir. */
function makeChain(n: number): AuditEventLike[] {
  const out: AuditEventLike[] = [];
  let prev = "GENESIS";
  for (let i = 1; i <= n; i++) {
    const ts = new Date(Date.UTC(2026, 0, i, 10, 0, 0));
    const details = JSON.stringify({ i });
    const hash = chainHash(prev, ts, 1, "dr.ayse", `test.action${i}`, "study", `1.2.${i}`, details, sha256);
    out.push({ id: i, ts: ts.toISOString(), userId: 1, username: "dr.ayse", action: `test.action${i}`, entityType: "study", entityId: `1.2.${i}`, details, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

function pack(source: AuditEventLike[], secret: string, exportedBy = "yonetici"): AuditPackage {
  // Satırlar kopyalanır: kurcalama testleri paylaşılan diziyi bozmasın.
  const events = source.map((r) => ({ ...r }));
  const manifest = buildManifest(events, { exportedBy, prevAnchor: events[0]?.prevHash ?? "GENESIS", signed: !!secret }, sha256);
  return { manifest, events, signature: signPackage(manifest, events, secret) };
}

function main() {
  const SECRET = "paket-sirri-123";
  const rows = makeChain(5);

  // ── 1) Zincir üretimi ve manifest ───────────────────────────────────
  assert.equal(rows.length, 5, "beş olay");
  assert.equal(rows[0].prevHash, "GENESIS", "ilk satır GENESIS'e bağlı");
  assert.equal(rows[1].prevHash, rows[0].hash, "zincir sıralı");
  const m = buildManifest(rows, { exportedBy: "yonetici", prevAnchor: rows[0].prevHash, signed: true }, sha256);
  assert.equal(m.version, 1, "biçim sürümü");
  assert.equal(m.count, 5, "sayı");
  assert.equal(m.firstId, 1, "ilk kimlik");
  assert.equal(m.lastId, 5, "son kimlik");
  assert.equal(m.lastHash, rows[4].hash, "son hash");
  assert.equal(m.prevAnchor, "GENESIS", "süreklilik çapası");
  assert.match(m.from, /^2026-01-01/, "başlangıç zamanı");
  assert.equal(m.digest, eventsDigest(rows, sha256), "digest satır hash'lerinden");
  assert.equal(m.signed, true, "imzalı işareti");
  const bosManifest = buildManifest([], { exportedBy: "x", prevAnchor: "abc", signed: false }, sha256);
  assert.equal(bosManifest.count, 0, "boş paket sayısı 0");
  assert.equal(bosManifest.from, "", "boş pakette uydurma tarih yok");
  assert.equal(bosManifest.firstId, null, "boş pakette kimlik yok");
  assert.equal(bosManifest.lastHash, "abc", "boş pakette son hash = çapa");
  console.log("PASS manifest (sayı/hash/zaman aralığı)");

  // ── 2) İmza ─────────────────────────────────────────────────────────
  const pkg = pack(rows, SECRET);
  assert.equal(pkg.signature.length, 64, "HMAC-SHA256 hex");
  assert.equal(verifySignature(pkg.manifest, rows, pkg.signature, SECRET), true, "imza doğru");
  assert.equal(verifySignature(pkg.manifest, rows, pkg.signature, "baska-sir"), false, "yanlış sır reddedilir");
  assert.equal(verifySignature(pkg.manifest, rows, "", SECRET), false, "boş imza reddedilir");
  assert.equal(signPackage(pkg.manifest, rows, ""), "", "sır yoksa imza üretilmez");
  assert.equal(verifySignature(pkg.manifest, rows, "kisa", SECRET), false, "uzunluk farkı güvenli reddedilir");
  // İmza metni alan sırasına duyarlı ama deterministik
  assert.equal(signaturePayload(pkg.manifest, rows), signaturePayload(pkg.manifest, rows), "imza metni deterministik");
  assert.ok(signaturePayload(pkg.manifest, rows).startsWith("v1|"), "biçim sürümü payload'da");
  console.log("PASS HMAC imza (yanlış sır/boş imza reddedilir)");

  // ── 3) Doğrulama: sağlam paket ──────────────────────────────────────
  const okRes = verifyPackage(pkg, { secret: SECRET, sha256 });
  assert.equal(okRes.ok, true, "sağlam paket doğrulanır");
  assert.equal(okRes.count, 5, "olay sayısı");
  assert.match(verifyReport(okRes), /Paket doğrulandı: 5 olay, zincir sürekli ve imza geçerli\./, "okunur rapor");

  const imzasiz = verifyPackage(pack(rows, ""), { secret: SECRET, sha256 });
  assert.equal(imzasiz.ok, false, "imzasız paket kabul edilmez");
  assert.match(imzasiz.reason, /imzasız/, "neden: imza yok");
  assert.match(verifyReport(imzasiz), /REDDEDİLDİ/, "rapor reddi söyler");

  const sirsizSunucu = verifyPackage(pkg, { sha256 });
  assert.equal(sirsizSunucu.ok, false, "sunucuda sır yoksa doğrulanamaz");
  assert.match(sirsizSunucu.reason, /AUDIT_EXPORT_SECRET/, "eksik sır açıkça yazılır");
  console.log("PASS doğrulama (sağlam paket + imza zorunluluğu)");

  // ── 4) Kurcalama senaryoları ────────────────────────────────────────
  const degistirilmis = pack(rows, SECRET);
  degistirilmis.events[2] = { ...degistirilmis.events[2], action: "sahte.action" };
  const d1 = verifyPackage(degistirilmis, { secret: SECRET, sha256 });
  assert.equal(d1.ok, false, "satır içeriği değiştirilirse reddedilir");
  assert.match(d1.reason, /Satır 3 içeriği hash ile uyuşmuyor/, "hangi satır olduğu yazılır");

  const silinmis = pack(rows, SECRET);
  silinmis.events = silinmis.events.filter((r) => r.id !== 3);
  silinmis.manifest = { ...silinmis.manifest, count: 4, lastId: 5, lastHash: rows[4].hash, digest: eventsDigest(silinmis.events, sha256) };
  silinmis.signature = signPackage(silinmis.manifest, silinmis.events, SECRET);
  const d2 = verifyPackage(silinmis, { secret: SECRET, sha256 });
  assert.equal(d2.ok, false, "aradan satır silinirse zincir kopar");
  assert.match(d2.reason, /Zincir kopuk \(satır 4\)/, "kopma noktası bildirilir");

  const sayi = pack(rows, SECRET);
  sayi.manifest = { ...sayi.manifest, count: 99 };
  assert.match(verifyPackage(sayi, { secret: SECRET, sha256 }).reason, /Satır sayısı uyuşmuyor/, "manifest sayısı oynanamaz");

  const sonHash = pack(rows, SECRET);
  sonHash.manifest = { ...sonHash.manifest, lastHash: sha256("uydurma") };
  assert.equal(verifyPackage(sonHash, { secret: SECRET, sha256 }).ok, false, "son hash oynanamaz");
  assert.match(verifyPackage(sonHash, { secret: SECRET, sha256 }).reason, /İmza geçersiz|Son hash/, "manifest oynaması yakalanır");

  const imzaKopya = pack(rows, SECRET);
  imzaKopya.signature = pack(makeChain(5), "baska").signature;
  assert.equal(verifyPackage(imzaKopya, { secret: SECRET, sha256 }).ok, false, "başka paketin imzası kabul edilmez");

  const bicim = { ...pkg, manifest: { ...pkg.manifest, version: 2 } } as unknown as AuditPackage;
  assert.match(verifyPackage(bicim, { secret: SECRET, sha256 }).reason, /Bilinmeyen paket biçimi/, "bilinmeyen sürüm");
  console.log("PASS kurcalama (satır silme/değiştirme, manifest oynama, imza kopyalama)");

  // ── 5) Boş paket ────────────────────────────────────────────────────
  const bosImzali = pack([], SECRET);
  assert.equal(verifyPackage(bosImzali, { secret: SECRET, sha256 }).ok, true, "imzalı boş paket tutarlı");
  const bosImzasiz = pack([], "");
  const bosRes = verifyPackage(bosImzasiz, { secret: SECRET, sha256 });
  assert.equal(bosRes.ok, true, "imzasız boş paket tutarlı kabul edilir (kanıt iddiası yok)");
  assert.equal(bosRes.signed, false, "imzasız olarak işaretlenir");
  assert.match(bosRes.reason, /^$|^$/, "boş paket nedensiz");
  console.log("PASS boş paket davranışı");

  // ── 6) Üretim modu kapısı ───────────────────────────────────────────
  assert.deepEqual(authModeGate({ NODE_ENV: "development", AUTH_MODE: "demo" }), { ok: true, mode: "demo", warning: null }, "geliştirmede kapı açık");
  assert.equal(authModeGate({ NODE_ENV: "production", AUTH_MODE: "hesap" }).ok, true, "üretimde hesap modu geçer");
  const prodDemo = authModeGate({ NODE_ENV: "production", AUTH_MODE: "demo" });
  assert.equal(prodDemo.ok, false, "üretimde demo modu reddedilir");
  assert.match(prodDemo.warning ?? "", /AUTH_MODE=hesap zorunlu/, "kural yazılır");
  const istisna = authModeGate({ NODE_ENV: "production", AUTH_MODE_REQUIRED: "0" });
  assert.equal(istisna.ok, true, "bilinçli istisna");
  assert.match(istisna.warning ?? "", /tek operatöre atfeder/, "istisnanın riski yazılır");
  assert.equal(authModeGate({ APP_ENV: "production", AUTH_MODE: "account" }).ok, true, "account eşanlamlı");
  assert.deepEqual(authModeGate({}), { ok: true, mode: "demo", warning: null }, "boş ortam geliştirme sayılır");
  console.log("PASS üretim modu kapısı");

  // ── 7) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/audit/export/route.ts");
  assert.ok(route.includes('format') && route.includes("package"), "paket biçimi eklendi");
  assert.ok(route.includes("signPackage") && route.includes("verifyPackage"), "imzalama + doğrulama uçta");
  assert.ok(route.includes("AUDIT_EXPORT_SECRET"), "sır ortamdan");
  assert.ok(route.includes("audit.export_package") && route.includes("audit.verify_package"), "denetim kayıtları");
  assert.ok(route.includes("authModeGate"), "kapı ucu bağlı");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("İmzalı paket indir"), "panelde indirme");
  assert.ok(admin.includes("Paket doğrula"), "panelde doğrulama");
  assert.ok(admin.includes("AUTH_MODE"), "kapı panelde gösterilir");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "w-audit"[\s\S]{0,3000}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkgJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkgJson.scripts["test:auditchain"]?.includes("audit-package"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm w-audit (imzalı denetim paketi) testleri geçti.");
}

main();

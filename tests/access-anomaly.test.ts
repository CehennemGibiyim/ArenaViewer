/**
 * Erişim anomalisi tespiti (KVKK) testleri — saf çekirdek + kaynak kablolama.
 *
 * Sınır: bu testler kural motorunun doğruluğunu sınar; gerçek suistimali
 * tespit ettiğini KANITLAMAZ (etiketli olay kümesi yok — klinik/kurumsal
 * doğrulama kurumun denetim ekibiyle yapılır).
 *
 * Çalıştırma: npx tsx tests/access-anomaly.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  analyzeAuditRows,
  analyzeLoginAttempts,
  mergeAnomalies,
  sortAnomalies,
  BULK_READ_MIN,
  SINGLE_PATIENT_MIN,
  OFF_HOURS_MIN,
  EXPORT_MIN,
  EXPORT_HIGH,
  LOGIN_FAIL_USER_MIN,
  LOGIN_FAIL_IP_MIN,
  type AuditRowLite,
  type LoginAttemptLite,
} from "../src/lib/accessAnomaly";

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok ${name}`); };

// Yerel saat tabanı (test ortamının saat dilimi ne olursa olsun tutarlı)
const base = new Date(2026, 10, 25, 10, 0, 0); // Çarşamba 10:00, mesai içi
const offBase = new Date(2026, 10, 25, 23, 30, 0); // 23:30, mesai dışı
const at = (min: number, from: Date = base) => new Date(from.getTime() + min * 60_000);
const auditRow = (user: string, action: string, entityType: string, entityId: string, ts: Date): AuditRowLite =>
  ({ userId: 1, username: user, action, entityType, entityId, ts });
const src = () => readFileSync(join(process.cwd(), "src/lib/accessAnomaly.ts"), "utf8");

console.log("· toplu-okuma");
ok(`${BULK_READ_MIN} farklı çalışma 10 dk içinde → yüksek anomali`, () => {
  const rows = Array.from({ length: BULK_READ_MIN }, (_, i) => auditRow("u1", "study.open", "study", `S${i}`, at(i * 0.25))); // 15 sn arayla, 6 dk span
  const a = analyzeAuditRows(rows);
  const hit = a.find((x) => x.kind === "toplu-okuma" && x.actor === "u1");
  assert.ok(hit, "anomali bulunmalı");
  assert.equal(hit!.severity, "yuksek");
  assert.equal(hit!.count, BULK_READ_MIN);
});
ok("24 farklı çalışma → anomali YOK", () => {
  const rows = Array.from({ length: BULK_READ_MIN - 1 }, (_, i) => auditRow("u1", "study.open", "study", `S${i}`, at(i * 0.25)));
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "toplu-okuma").length, 0);
});
ok("30 olay ama 20 farklı çalışma → YOK (farklı sayılır)", () => {
  const rows: AuditRowLite[] = [];
  for (let i = 0; i < 30; i++) rows.push(auditRow("u1", "study.open", "study", `S${i % 20}`, at(i)));
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "toplu-okuma").length, 0);
});
ok("aynı 25 çalışma 9 dk içinde SIRA DIŞI dağınık zamanda bile yakalanır", () => {
  const rows: AuditRowLite[] = [];
  for (let i = 0; i < BULK_READ_MIN; i++) rows.push(auditRow("u1", "study.open", "study", `S${i}`, at((BULK_READ_MIN - 1 - i) * 0.3))); // ters sıra, 7,5 dk span
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "toplu-okuma");
  assert.ok(hit);
});
ok("farklı kullanıcılar ayrı kovalar", () => {
  const rows: AuditRowLite[] = [];
  for (let i = 0; i < BULK_READ_MIN; i++) rows.push(auditRow(`u${i % 3}`, "study.open", "study", `S${i}`, at(i))); // 9'ar farklı → eşik altı
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "toplu-okuma").length, 0);
});
ok("bozuk ts satırı atlanır, süreç çökmez", () => {
  const rows = [auditRow("u1", "study.open", "study", "S1", new Date("gecersiz"))];
  assert.doesNotThrow(() => analyzeAuditRows(rows));
});

console.log("· tek-hasta-yogun");
ok(`${SINGLE_PATIENT_MIN} kez aynı çalışma 60 dk içinde → orta anomali`, () => {
  const rows = Array.from({ length: SINGLE_PATIENT_MIN }, (_, i) => auditRow("u1", "study.open", "study", "S7", at(i * 4)));
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "tek-hasta-yogun");
  assert.ok(hit);
  assert.equal(hit!.severity, "orta");
  assert.equal(hit!.entityId, "S7");
});
ok("11 kez → YOK", () => {
  const rows = Array.from({ length: SINGLE_PATIENT_MIN - 1 }, (_, i) => auditRow("u1", "study.open", "study", "S7", at(i)));
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "tek-hasta-yogun").length, 0);
});
ok("farklı çalışmalara bölünen açımlar tetiklemez", () => {
  const rows = Array.from({ length: SINGLE_PATIENT_MIN }, (_, i) => auditRow("u1", "study.open", "study", `S${i}`, at(i)));
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "tek-hasta-yogun").length, 0);
});

console.log("· mesai-disi");
ok(`${OFF_HOURS_MIN} mesai dışı görüntüleme → izle`, () => {
  const rows = Array.from({ length: OFF_HOURS_MIN }, (_, i) => auditRow("u1", "study.open", "study", `S${i}`, at(i, offBase)));
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "mesai-disi");
  assert.ok(hit);
  assert.equal(hit!.severity, "izle");
});
ok("mesai içi görüntülemeler sayılmaz", () => {
  const rows = Array.from({ length: OFF_HOURS_MIN + 5 }, (_, i) => auditRow("u1", "study.open", "study", `S${i}`, at(i)));
  assert.equal(analyzeAuditRows(rows).filter((x) => x.kind === "mesai-disi").length, 0);
});

console.log("· toplu-disari");
ok(`${EXPORT_MIN} PACS gönderimi → orta`, () => {
  const rows = Array.from({ length: EXPORT_MIN }, (_, i) => auditRow("u1", "pacs.send_sr", "study", `S${i}`, at(i)));
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "toplu-disari");
  assert.ok(hit);
  assert.equal(hit!.severity, "orta");
});
ok(`${EXPORT_HIGH} dışa aktarım → yüksek`, () => {
  const rows = Array.from({ length: EXPORT_HIGH }, (_, i) => auditRow("u1", "report.export_fhir", "report", `R${i}`, at(i)));
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "toplu-disari");
  assert.ok(hit);
  assert.equal(hit!.severity, "yuksek");
});
ok("share.access anonim erişimler bağlantı bazında kovalanır", () => {
  const rows = Array.from({ length: EXPORT_MIN }, () => auditRow("", "share.access", "share", "tok12345", at(1)));
  const hit = analyzeAuditRows(rows).find((x) => x.kind === "toplu-disari");
  assert.ok(hit);
  assert.match(hit!.key, /bağlantı tok12345/);
});

console.log("· giris-denemesi");
const attempt = (username: string, ip: string, okFlag: boolean, min: number): LoginAttemptLite =>
  ({ username, ip, ok: okFlag, at: at(min), reason: "parola" });
ok(`${LOGIN_FAIL_USER_MIN} başarısız giriş / aynı kullanıcı / 15 dk → yüksek`, () => {
  const rows = Array.from({ length: LOGIN_FAIL_USER_MIN }, (_, i) => attempt("victim", `10.0.0.${i}`, false, i));
  const hit = analyzeLoginAttempts(rows).find((x) => x.key === "giris-denemesi|user:victim");
  assert.ok(hit);
  assert.equal(hit!.severity, "yuksek");
});
ok("başarısız girişler 15 dk penceresi dışına dağılırsa YOK", () => {
  const rows = Array.from({ length: LOGIN_FAIL_USER_MIN }, (_, i) => attempt("victim", `10.0.0.${i}`, false, i * 5)); // 0..35 dk
  assert.equal(analyzeLoginAttempts(rows).filter((x) => x.key === "giris-denemesi|user:victim").length, 0);
});
ok(`${LOGIN_FAIL_IP_MIN} başarısız giriş / aynı IP / 15 dk → yüksek (farklı kullanıcılar)`, () => {
  const rows = Array.from({ length: LOGIN_FAIL_IP_MIN }, (_, i) => attempt(`user${i}`, "203.0.113.66", false, i % 10));
  const hit = analyzeLoginAttempts(rows).find((x) => x.key === "giris-denemesi|ip:203.0.113.66");
  assert.ok(hit);
});
ok("başarılı girişler sayılmaz", () => {
  const rows = Array.from({ length: LOGIN_FAIL_USER_MIN }, (_, i) => attempt("victim", "10.0.0.9", true, i));
  assert.equal(analyzeLoginAttempts(rows).length, 0);
});

console.log("· birleştirme ve sıralama");
ok("sortAnomalies yuksek → orta → izle sırası", () => {
  const rows = [
    auditRow("s", "study.open", "study", "1", at(0, offBase)),
    ...Array.from({ length: OFF_HOURS_MIN }, (_, i) => auditRow("s", "study.open", "study", `OFF${i}`, at(i, offBase))),
    ...Array.from({ length: SINGLE_PATIENT_MIN }, (_, i) => auditRow("m", "study.open", "study", "S9", at(i * 3))),
    ...Array.from({ length: BULK_READ_MIN }, (_, i) => auditRow("y", "study.open", "study", `Y${i}`, at(i))),
  ];
  const a = analyzeAuditRows(rows);
  const merged = mergeAnomalies(a, []);
  const order = merged.map((x) => x.severity);
  assert.deepEqual(order, [...order].sort((x, y) => ({ yuksek: 0, orta: 1, izle: 2 }[x] - { yuksek: 0, orta: 1, izle: 2 }[y])));
});

console.log("· kaynak kablolama");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
ok("saf çekirdek DIMSE gibi yanlış iddia taşımaz, sınırları yazar", () => {
  const s = src();
  assert.match(s, /Heuristik/);
  assert.match(s, /disiplin kanıtı/);
});
ok("sunucu: idempotency ayarı + denetim eylemi + 7 gün pencere", () => {
  const s = read("src/lib/server/accessAnomaly.ts");
  assert.match(s, /accessAnomalyAlerted/);
  assert.match(s, /security\.access_anomaly/);
  assert.match(s, /WINDOW_DAYS = 7/);
  assert.match(s, /loginAttempts/);
});
ok("rota: yönetici rolü + raporu ister", () => {
  const s = read("src/app/api/security/access-anomaly/route.ts");
  assert.match(s, /authorize\(req, \["yonetici"\]\)/);
  assert.match(s, /buildAccessAnomalyReport/);
});
ok("bildirim kanalları security_anomaly tanıdı", () => {
  const s = read("src/lib/notifyChannels.ts");
  assert.match(s, /security_anomaly/);
});
ok("AdminPanel test-id'leri bağlandı", () => {
  const s = read("src/components/AdminPanel.tsx");
  assert.match(s, /access-anomaly-panel/);
  assert.match(s, /\/api\/security\/access-anomaly/);
});
ok("statik demo örneği (örnek) etiketli ve uç kayıtlı", () => {
  const s = read("src/components/StaticAdminShim.tsx");
  assert.match(s, /access-anomaly/);
  assert.match(s, /\(örnek\)/);
});
ok("package.json test:access-anomaly zincirde", () => {
  const pkg = read("package.json");
  assert.match(pkg, /"test:access-anomaly"/);
  assert.match(pkg, /test:access-anomaly &&/);
});

console.log(`\nTÜM OK — ${passed} denetim geçti`);

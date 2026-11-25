/**
 * e-hl7-mwl: ADT (A08 demografi güncellemesi, A40 hasta birleştirme).
 *
 * İddialar: boş alan mevcut değeri **silmez**, hedef kayıt yoksa birleştirme
 * yapılmaz, MRG-1 eksikse A40 reddedilir, işlenmeyen olay sessizce başarı
 * sayılmaz (gerekçe döner).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { adtAck, adtFromHl7, hl7Date, parseAdt, planAdt } from "../src/lib/hl7Adt";
import { buildAck, parseHl7 } from "../src/lib/hl7";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const msh = (type: string, id = "M1") => `MSH|^~\\&|HIS|DevletHastanesi|AtikViewer|Radyoloji|20260304120000||${type}|${id}|P|2.5`;

const A08 = [
  msh("ADT^A08", "A08-1"),
  "PID|1||123456^^^HIS^MR||YILMAZ^AYSE^^^||19800101|F|||",
  "PV1|1|O",
].join("\r");

const A40 = [
  msh("ADT^A40", "A40-1"),
  "PID|1||HEDEF-2^^^HIS^MR||KAYA^MEHMET^^^||19700101|M",
  "MRG|ESKI-1^^^HIS^MR",
].join("\r");

function main() {
  // ── 1) A08 ayrıştırma ───────────────────────────────────────────────
  const a08 = parseAdt(A08);
  assert.ok(a08, "A08 ayrıştırıldı");
  assert.equal(a08!.event, "A08", "olay");
  assert.equal(a08!.patient.patientId, "123456", "PID-3 kimlik");
  assert.equal(a08!.patient.patientName, "AYSE YILMAZ", "ad soyad (verilen + soyad)");
  assert.equal(a08!.patient.birthDate, "1980-01-01", "doğum tarihi ISO");
  assert.equal(a08!.patient.sex, "F", "cinsiyet");
  assert.equal(a08!.controlId, "A08-1", "MSH-10 ACK eşleştirmesi");
  assert.deepEqual(a08!.warnings, [], "temiz mesaj");
  assert.equal(hl7Date("19800101"), "1980-01-01", "DA biçimi");
  assert.equal(hl7Date("19801301"), undefined, "geçersiz ay → undefined (uydurma yok)");
  assert.equal(hl7Date(""), undefined, "boş");
  assert.equal(parseAdt("saçma"), null, "HL7 olmayan girdi");
  assert.ok(parseAdt(`${msh("ADT^A08")}\rPV1|1|O`) === null, "PID yoksa null");
  const noId = parseAdt(`${msh("ADT^A08")}\rPID|1|||YILMAZ^AYSE`);
  assert.equal(noId, null, "PID-3 yoksa null (işlem yapılmaz)");
  console.log("PASS A08 ayrıştırma");

  // ── 2) A40 birleştirme ayrıştırma ───────────────────────────────────
  const a40 = parseAdt(A40);
  assert.ok(a40, "A40 ayrıştırıldı");
  assert.equal(a40!.event, "A40", "olay");
  assert.equal(a40!.patient.patientId, "HEDEF-2", "hedef kimlik PID-3");
  assert.equal(a40!.mergedPatientId, "ESKI-1", "birleşen kimlik MRG-1");
  const a40NoMrg = parseAdt([msh("ADT^A40"), "PID|1||HEDEF-2^^^HIS^MR||KAYA^MEHMET"].join("\r"));
  assert.equal(a40NoMrg!.mergedPatientId, undefined, "MRG yoksa birleşen kimlik yok");
  assert.match(a40NoMrg!.warnings[0], /MRG-1 \(birleşen kimlik\) boş/, "uyarı");
  const selfMerge = parseAdt([msh("ADT^A40"), "PID|1||A-1^^^HIS", "MRG|A-1^^^HIS"].join("\r"));
  assert.equal(selfMerge!.mergedPatientId, undefined, "kendisiyle birleştirme yok sayıldı");
  assert.ok(selfMerge!.warnings.some((w) => /aynı/.test(w)), "kendisiyle birleştirme gerekçesi");
  assert.ok(selfMerge!.warnings.some((w) => /PID-5/.test(w)), "adsız PID uyarısı");
  console.log("PASS A40 birleştirme ayrıştırma");

  // ── 3) Uygulama planı ───────────────────────────────────────────────
  const upd = planAdt(a08, { patientName: "AYSE YILMAZ" });
  assert.equal(upd.ok, true, "A08 planı geçerli");
  assert.equal(upd.action, "guncelle", "güncelleme");
  assert.deepEqual(upd.changes, { birthDate: "1980-01-01", sex: "F" }, "yalnız değişen alanlar yazılır");
  assert.match(upd.reason, /2 alan güncellenecek/, "gerekçe");

  const same = planAdt(a08, { patientName: "AYSE YILMAZ" });
  assert.equal(same.changes.patientName, undefined, "aynı ad yazılmaz");

  const rename = planAdt(a08, { patientName: "AYSE YILMAZ (EVLİLİK)" });
  assert.equal(rename.changes.patientName, "AYSE YILMAZ", "ad değişikliği yakalanır");

  const noop = planAdt(parseAdt([msh("ADT^A08"), "PID|1||9^^^H||YILMAZ^AYSE"].join("\r")), { patientName: "AYSE YILMAZ" });
  assert.equal(noop.action, "yok-say", "değişen alan yok → yazma yok");
  assert.match(noop.reason, /Değişen alan yok/, "gerekçe");

  const merge = planAdt(a40, { patientName: "MEHMET KAYA" });
  assert.equal(merge.ok, true, "A40 planı geçerli");
  assert.equal(merge.action, "birlestir", "birleştirme");
  assert.equal(merge.patientId, "HEDEF-2", "hedef");
  assert.equal(merge.fromPatientId, "ESKI-1", "kaynaktan taşınacak");

  const mergeNoTarget = planAdt(a40, null);
  assert.equal(mergeNoTarget.ok, false, "hedef kayıt yoksa birleştirme yapılmaz");
  assert.match(mergeNoTarget.reason, /Hedef hasta kaydı bulunamadı \(HEDEF-2\)/, "gerekçe");

  const unknown = planAdt(parseAdt([msh("ADT^A17"), "PID|1||9^^^H||A^B"].join("\r")));
  assert.equal(unknown.ok, true, "işlenmeyen olay hata değil");
  assert.equal(unknown.action, "yok-say", "yok sayılır");
  assert.match(unknown.reason, /A17.*işlenmiyor/, "dürüst gerekçe");

  assert.equal(planAdt(null).ok, false, "null mesaj reddedilir");
  console.log("PASS uygulama planı");

  // ── 4) ACK ──────────────────────────────────────────────────────────
  const parsedMsg = parseHl7(A08)!;
  const ackAa = adtAck(parsedMsg, upd, buildAck);
  assert.equal(ackAa.charCodeAt(0), 0x0b, "MLLP çerçevesi");
  assert.match(ackAa, /MSA\|AA\|A08-1/, "AA ACK ve kontrol kimliği");
  const ackAe = adtAck(parsedMsg, mergeNoTarget, buildAck);
  assert.match(ackAe, /MSA\|AE\|A08-1/, "başarısız planda AE ACK");
  console.log("PASS ACK kodları");

  // ── 5) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/his/mwl/route.ts");
  assert.ok(route.includes('action === "adt"') && route.includes("applyAdt"), "ADT ucu");
  assert.ok(route.includes("his.adt_merge") && route.includes("his.adt_update") && route.includes("his.adt_ignored"), "denetim kayıtları");
  assert.ok(route.includes("decryptText") && route.includes("plan.fromPatientId"), "birleştirme şifreli kimlikle çalışır");
  const modal = read("src/components/WorklistModal.tsx");
  assert.ok(modal.includes("ADT ilet") && modal.includes('action: "adt"'), "arayüzde ADT girişi");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "e-hl7-mwl"[\s\S]{0,3600}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:adt"]?.includes("hl7-adt"), "test betiği");
  console.log("PASS uç/arayüz sözleşmesi");

  console.log("Tüm e-hl7-mwl (ADT) testleri geçti.");
}

main();

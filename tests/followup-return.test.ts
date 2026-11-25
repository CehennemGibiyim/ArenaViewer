/**
 * d-followup: HBYS/RIS iadesinin (HL7 ORU^R01 / FHIR DiagnosticReport)
 * ayrıştırılması, eşleştirilmesi ve görev kapatma kararı.
 *
 * Kural: belirsiz eşleşme **otomatik kapatılmaz**; eksik alan uydurulmaz.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyReturnedResult, hl7Timestamp, parseFhirDiagnosticReport, parseOru, parseReturnedPayload } from "../src/lib/followupReturn";
import type { FollowupTask } from "../src/lib/followupQueue";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const ORU = [
  "MSH|^~\\&|HIS|DevletHastanesi|AtikViewer|Radyoloji|20260304120000||ORU^R01|MSG00042|P|2.5",
  "PID|1||123456^^^HIS^MR||YILMAZ^AYSE||19800101|F",
  "OBR|1||9001|71260^TORAKS BT^LN|||20260303090000|||||||||Dr. B. Kaya|||1.2.840.113619.2.55.3",
  "OBX|1|TX|FIND||Kontrastlanan nodül 18 mm'den 12 mm'ye geriledi.|||N|||F",
  "OBX|2|TX|IMPR||Kısmi yanıt; 6 ay sonra kontrol önerilir.|||N|||F",
].join("\r");

const FHIR = {
  resourceType: "DiagnosticReport",
  identifier: [{ value: "9001" }],
  subject: { identifier: { value: "123456" } },
  imagingStudy: [{ identifier: { value: "urn:oid:1.2.840.113619.2.55.3" } }],
  code: { text: "Toraks BT", coding: [{ display: "CT Chest" }] },
  effectiveDateTime: "2026-03-03T09:00:00Z",
  conclusion: "Nodül stabil; yeni lezyon yok.",
};

const task = (over: Partial<FollowupTask> = {}): FollowupTask => ({
  id: 11, status: "acik", dueDate: "2026-03-10", severity: "yuksek", message: "6 ay sonra toraks BT kontrolü",
  modality: "CT", bodyRegion: "Toraks", studyUid: "1.2.840.113619.2.55.3", reportId: 9001,
  ...over,
});

function main() {
  // ── 1) HL7 ORU ayrıştırma ───────────────────────────────────────────
  const oru = parseOru(ORU);
  assert.equal(oru.ok, true, "ORU ayrıştırıldı");
  assert.equal(oru.format, "hl7-oru", "biçim");
  assert.ok(oru.result, "sonuç var");
  const r = oru.result!;
  assert.equal(r.reportId, 9001, "sayısal erişim numarası rapor kimliği");
  assert.equal(r.studyUid, "1.2.840.113619.2.55.3", "noktalı UID alanlardan bulundu (tahmin değil, desen)");
  assert.equal(r.modality, "CT", "modalite OBR açıklamasından");
  assert.match(r.text, /Kısmi yanıt/, "OBX-5 metni birleşti");
  assert.match(r.text, /geriledi/, "ikinci OBX de girdi");
  assert.equal(r.at, "2026-03-03T09:00:00", "OBR-7 tarihi");
  assert.deepEqual(oru.warnings, [], "temiz mesajda uyarı yok");

  // OBX yok → OBR açıklamasına düşer, uydurma yok
  const noObx = parseOru(["MSH|^~\\&|H|F|A|R|20260304120000||ORU^R01|1|P|2.5", "PID|1||9^^^H^MR", "OBR|1|1|2|71020^AKCIGER BT^LN"].join("\r"));
  assert.equal(noObx.ok, true, "OBR açıklaması metin sayılır");
  assert.match(noObx.result!.text, /AKCIGER BT/, "OBR-4 bileşeni");
  assert.ok(noObx.warnings.some((w) => /Rapor metni bulunamadı|OBR-4/.test(w)) === false, "metin varken metin uyarısı yok");

  const bos = parseOru(["MSH|^~\\&|H|F|A|R|20260304120000||ORU^R01|1|P|2.5", "PID|1||9^^^H^MR"].join("\r"));
  assert.equal(bos.ok, false, "metinsiz iade kabul edilmez");
  assert.equal(bos.result, null, "boş sonuç nesnesi üretilmez");
  assert.ok(bos.warnings.some((w) => w.includes("Rapor metni bulunamadı")), "gerekçe");
  assert.equal(parseOru("saçma metin").ok, false, "HL7 olmayan girdi reddedilir");
  console.log("PASS HL7 ORU ayrıştırma");

  // ── 2) Zaman damgası ────────────────────────────────────────────────
  assert.equal(hl7Timestamp("20260303090000"), "2026-03-03T09:00:00", "saniyeli");
  assert.equal(hl7Timestamp("202603030900"), "2026-03-03T09:00:00", "dakikalı");
  assert.equal(hl7Timestamp("20261303"), undefined, "geçersiz ay → undefined (uydurma yok)");
  assert.equal(hl7Timestamp(""), undefined, "boş");
  console.log("PASS HL7 zaman damgası");

  // ── 3) FHIR DiagnosticReport ────────────────────────────────────────
  const fhir = parseFhirDiagnosticReport(FHIR);
  assert.equal(fhir.ok, true, "FHIR ayrıştırıldı");
  assert.equal(fhir.format, "fhir-diagnosticreport", "biçim");
  assert.equal(fhir.result!.text, "Nodül stabil; yeni lezyon yok.", "conclusion metni");
  assert.equal(fhir.result!.studyUid, "1.2.840.113619.2.55.3", "urn:oid: öneki temizlendi");
  assert.equal(fhir.result!.modality, "CT", "coding display'den modalite");
  assert.equal(fhir.result!.reportId, 9001, "sayısal identifier");
  assert.equal(fhir.result!.at, "2026-03-03T09:00:00Z", "effectiveDateTime");

  const narrative = parseFhirDiagnosticReport({ resourceType: "DiagnosticReport", text: { div: "<div><p>Kontrol: <b>stabil</b></p></div>" } });
  assert.equal(narrative.ok, true, "narrative metne çevrilir");
  assert.equal(narrative.result!.text, "Kontrol: stabil", "etiketler ayıklandı");
  assert.equal(narrative.result!.studyUid, undefined, "UID yoksa undefined");
  const b64 = parseFhirDiagnosticReport({ resourceType: "DiagnosticReport", presentedForm: [{ data: Buffer.from("PDF rapor metni", "utf8").toString("base64") }] });
  assert.equal(b64.result!.text, "PDF rapor metni", "presentedForm base64 çözüldü");
  assert.equal(parseFhirDiagnosticReport({ resourceType: "Patient" }).ok, false, "yanlış kaynak reddedilir");
  const fhirNoText = parseFhirDiagnosticReport({ resourceType: "DiagnosticReport", identifier: [{ value: "1" }] });
  assert.equal(fhirNoText.ok, false, "metinsiz FHIR kabul edilmez");
  assert.ok(fhirNoText.warnings[0].includes("Rapor metni yok"), "gerekçe");
  console.log("PASS FHIR DiagnosticReport");

  // ── 4) Otomatik biçim algılama ──────────────────────────────────────
  assert.equal(parseReturnedPayload(JSON.stringify(FHIR)).format, "fhir-diagnosticreport", "JSON → FHIR");
  assert.equal(parseReturnedPayload(ORU).format, "hl7-oru", "MSH → HL7");
  assert.equal(parseReturnedPayload("{bozuk").ok, false, "bozuk JSON reddedilir");
  assert.equal(parseReturnedPayload("   ").ok, false, "boş reddedilir");
  console.log("PASS biçim algılama");

  // ── 5) Eşleştirme ve kapatma ────────────────────────────────────────
  const t1 = task({ reportId: 9001 });
  const t2 = task({ id: 12, reportId: 7777, studyUid: "9.9.9" });
  const applied = applyReturnedResult(ORU, [t1, t2], Date.parse("2026-03-04T12:30:00Z"));
  assert.equal(applied.closed, true, "rapor kimliğiyle eşleşti");
  assert.equal(applied.task!.id, 11, "doğru görev");
  assert.equal(applied.task!.status, "tamamlandi", "görev kapandı");
  assert.match(applied.task!.outcome ?? "", /Kısmi yanıt/, "sonuç metni görevde");
  assert.equal(applied.task!.completedAt, "2026-03-03T09:00:00", "iade zamanı kullanıldı");
  assert.match(applied.message, /Görev #11 sonuçla kapatıldı \(Rapor kimliği eşleşti\)/, "satır");

  // Belirsiz: iki açık görev aynı modalite/bölge → kapatılmaz
  const belirsiz = applyReturnedResult(
    ["MSH|^~\\&|H|F|A|R|20260304120000||ORU^R01|2|P|2.5", "PID|1||1^^^H", "OBR|1|X|Y|71260^TORAKS BT^LN|||20260303090000", "OBX|1|TX|I||Stabil."].join("\r"),
    [task({ reportId: null, studyUid: undefined }), task({ id: 13, reportId: null, studyUid: undefined })],
  );
  assert.equal(belirsiz.closed, false, "belirsiz eşleşme kapatmaz");
  assert.equal(belirsiz.ambiguousCandidates, 2, "iki aday bildirilir");
  assert.match(belirsiz.message, /hekim seçmeli/, "kullanıcıya yönlendirme");

  const yok = applyReturnedResult(ORU, [task({ reportId: 5, studyUid: "1.1", modality: "MR", bodyRegion: "Beyin" })]);
  assert.equal(yok.closed, false, "eşleşme yoksa kapatmaz");
  assert.match(yok.message, /Açık görev eşleşmedi/, "gerekçe");

  const bozuk = applyReturnedResult("MSH|bozuk", [t1]);
  assert.equal(bozuk.closed, false, "ayrıştırılamayan iade kapatmaz");
  assert.match(bozuk.message, /İade okunamadı/, "gerekçe");
  console.log("PASS eşleştirme + kapatma kararı");

  // ── 6) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/notifications/route.ts");
  assert.ok(route.includes("rawPayload"), "uç ham iadeyi kabul eder");
  assert.ok(route.includes("parseReturnedPayload") && route.includes("applyReturnedResult"), "ayrıştırma + eşleştirme");
  assert.ok(route.includes("notify.followup_return_unmatched"), "eşleşmeyen iade denetlenir");
  const bell = read("src/components/NotificationsBell.tsx");
  assert.ok(bell.includes("HL7 ORU^R01") && bell.includes("rawPayload"), "arayüzde ham iade girişi");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "d-followup"[\s\S]{0,4000}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:followupreturn"]?.includes("followup-return"), "test betiği");
  console.log("PASS uç/arayüz sözleşmesi");

  console.log("Tüm d-followup (iade alımı) testleri geçti.");
}

main();

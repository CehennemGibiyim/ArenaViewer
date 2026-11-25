/**
 * c-sr-tid1500: DICOM SR TID 1500 yapılandırılmış ölçüm testleri.
 * Üretilen belge dicom-parser ile okunur (gerçek DICOM uyumu) ve sayısal
 * ölçüm ağacı, kodlama ve izleme kimlikleri denetlenir.
 */
import { parseDicom } from "dicom-parser";
import { annotationsToMeasurements, exportCoverage, siteCode } from "../src/lib/measurementExport";
import { buildMeasurementReportSr, codeSummary, CODES, dsValue, QUANTITY, SITES, SOP_COMPREHENSIVE_SR, atikCode, unitCode, validateMeasurements } from "../src/lib/sr1500";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const u8 = (b: Uint8Array) => new Uint8Array(b);
const latin = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

const ms = [
  {
    trackingId: "NOD-1", value: 8.4, unit: "mm", quantity: QUANTITY.length,
    finding: atikCode("NODULE", "Nodül"), site: SITES.akciger,
    image: { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUid: "1.2.3.4.1.9" },
  },
  { trackingId: "NOD-1#vol", value: 210.5, unit: "mm3", quantity: QUANTITY.volume, finding: atikCode("NODULE", "Nodül") },
  { trackingId: "HU-1", value: -45.25, unit: "hu", quantity: QUANTITY.mean, finding: atikCode("DENSITY", "Dansite") },
];

const bytes = buildMeasurementReportSr({
  patientName: "Yılmaz^Ayşe", patientId: "TR-123", patientSex: "K",
  studyUid: "1.2.840.113619.2.9.9", studyDate: "2026-11-20", institution: "TEST KLİNİĞİ",
  title: "Toraks BT ölçümleri", measurements: ms,
  approvedBy: "Ayşe Yılmaz", doctorTitle: "Uzm. Dr.", approvedAt: "2026-11-20T10:15:00.000Z",
});

// ── DICOM uyumu ──
const ds = parseDicom(u8(bytes));
ok(!!ds, "TID 1500 belgesi dicom-parser ile okunabiliyor");
const el = (tag: string) => ds.elements[tag];
const text = (tag: string) => {
  const e = el(tag);
  if (!e) return "";
  return new TextDecoder().decode(u8(bytes).slice(e.dataOffset, e.dataOffset + e.length)).replace(/\0+$/, "").trim();
};
ok(text("x00080016") === SOP_COMPREHENSIVE_SR, "SOP Class UID: Comprehensive SR (…88.33)");
ok(text("x00080060") === "SR", "Modality SR");
ok(text("x0020000d") === "1.2.840.113619.2.9.9", "Study Instance UID korunuyor");
ok(text("x0040a493") === "VERIFIED", "onaylı raporda Verification Flag = VERIFIED");
ok(text("x0040a040") === "CONTAINER", "kök içerik CONTAINER");

// ── içerik ağacı: kodlar ve izleme kimlikleri metin düzeyinde doğrulanır ──
const all = latin(u8(bytes));
for (const [name, c] of Object.entries(CODES)) ok(all.includes(c.value), `kod yazıldı: ${name} (${c.scheme}/${c.value})`);
for (const m of ms) ok(all.includes(m.trackingId), `izleme kimliği yazıldı: ${m.trackingId}`);
ok(all.includes("99ATIKVIEWER"), "özel kod şeması 99ATIKVIEWER kullanılıyor");
ok(!all.includes("RID"), "uydurma RadLex kodu YAZILMIYOR (RID görünmüyor)");
ok(all.includes("363698007"), "bulgu yeri kodu (SCT 363698007) yazıldı");
ok(all.includes("39607008"), "akciğer bölge kodu yazıldı");

// ── sayısal ölçümler ──
ok(all.includes("8.4") && all.includes("210.5") && all.includes("-45.25"), "DS değerleri belgede");
ok(all.includes("mm3") && all.includes("[hnsf'U]"), "UCUM birimleri yazıldı");
ok(all.includes("1.2.3.4.1.9"), "referans görüntü SOP UID'si yazıldı");

// ── biçimlendirme ──
ok(dsValue(8.4) === "8.4", "DS: tam sayı kuyruğu atılır");
ok(dsValue(-45.255) === "-45.255", "DS: üç ondalık");
ok(dsValue(1 / 3).length <= 16, "DS ≤ 16 karakter");
ok(dsValue(Number.NaN) === "0", "sayısal olmayan değer 0 (güvenli)");
ok(unitCode("hu").scheme === "UCUM" && unitCode("kg").value === "kg", "bilinmeyen birim UCUM kodu olarak geçer");

// ── doğrulama ──
const v = validateMeasurements([
  { trackingId: "A", value: 1, unit: "mm", quantity: QUANTITY.length, finding: atikCode("X", "x") },
  { trackingId: "", value: 1, unit: "mm", quantity: QUANTITY.length, finding: atikCode("X", "x") },
  { trackingId: "B", value: Number.NaN, unit: "mm", quantity: QUANTITY.length, finding: atikCode("X", "x") },
  { trackingId: "C", value: 2, unit: "", quantity: QUANTITY.length, finding: atikCode("X", "x") },
  { trackingId: "D", value: 3, unit: "mm", quantity: QUANTITY.length, finding: { value: "", scheme: "", meaning: "" } },
]);
ok(v.ok.length === 1 && v.rejected.length === 4, "geçersiz ölçümler nedeniyle ayrılır");
ok(v.rejected.map((r) => r.reason).join("|").includes("İzleme kimliği boş"), "red gerekçeleri anlaşılır");

// ── kod özeti (raporda/denetimde gösterilir) ──
const sum = codeSummary(ms);
ok(sum.length === 3 && sum[0].includes("99ATIKVIEWER/NODULE") && sum[0].includes("8.4 mm"), "kod özeti satırı doğru");

// ── onaysız raporda VERIFIED yazılmaz ──
const draft = buildMeasurementReportSr({
  patientName: "A^B", patientId: "P2", patientSex: "", studyUid: "1.2.3", studyDate: "2026-11-20",
  institution: "", measurements: [ms[0]],
});
const dds = parseDicom(u8(draft));
const de = dds.elements["x0040a493"];
ok(de && new TextDecoder().decode(u8(draft).slice(de.dataOffset, de.dataOffset + de.length)).trim() === "UNVERIFIED", "onaysız belge UNVERIFIED");

// ── ekran ölçümleri → TID 1500 köprüsü ──
const anns = [
  { id: "a1", kind: "length" as const, slice: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
  { id: "a2", kind: "ellipsoid" as const, slice: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 20 }], text: "30" },
  { id: "a3", kind: "ellipse" as const, slice: 2, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], stats: { mean: -42.6, std: 12, min: -70, max: -10, pixelCount: 300 } },
  { id: "a4", kind: "angle" as const, slice: 3, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] },
  { id: "a5", kind: "arrow" as const, slice: 4, points: [{ x: 0, y: 0 }], text: "nodül" },
];
const conv = annotationsToMeasurements(anns, {
  pxMm: 0.5, site: siteCode("toraks"),
  series: { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1.1", "1.2.3.4.1.2"] },
});
ok(conv.length === 4, "uzunluk(1) + elipsoid(2) + elips ROI(1) = 4 ölçüm; açı/ok atlandı");
ok(conv[0].value === 5 && conv[0].unit === "mm", "uzunluk mm'ye çevrildi (10 px × 0,5)");
const vol = conv.find((m) => m.unit === "mm3");
ok(!!vol && Math.abs(vol.value - (Math.PI / 6) * 5 * 10 * 30) < 0.01, "elipsoid hacmi mm³ (π/6·d1·d2·d3)");
ok(conv.some((m) => m.quantity.value === QUANTITY.mean.value && m.unit === "hu" && m.value === -42.6), "ROI ortalama HU yazıldı");
ok(conv[0].site?.value === "39607008", "bölge kodu SNOMED CT akciğer'e eşlendi");
const cov = exportCoverage(anns);
ok(cov.used === 3 && cov.skipped.includes("açı") && cov.skipped.includes("ok"), "kapsam özeti: yazılan/atlanan türler");

if (failed) { console.error(`${failed} TID 1500 testi başarısız`); process.exit(1); }
console.log("Tüm c-sr-tid1500 (yapılandırılmış ölçüm SR) testleri geçti.");

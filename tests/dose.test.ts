/**
 * RDSR (radyasyon dozu) testleri.
 *
 * Üç katman:
 *  1. Saf SR ağacı üzerinde çıkarma kuralları (olaylar, eksik değer, düz belge).
 *  2. Gerçek DICOM baytları: sentetik RDSR yazılır, dicom-parser + SR ayrıştırıcı
 *     ile geri okunur (üretim yolunun aynısı).
 *  3. Özet, etkin doz, DRL karşılaştırması ve metin çıktısı.
 */
import { parseDicom } from "dicom-parser";
import { concat, el, enc, newUid, str, uidEl } from "../src/lib/dicomWrite";
import { DOSE_CODES, EFFECTIVE_DOSE_REGIONS, ORNEK_DRL, SOP_RADIATION_DOSE_SR, compareToDrl, doseSummaryText, effectiveDoseMsv, extractDoseReport, summarizeDose } from "../src/lib/dose";
import { parseStructuredReport } from "../src/lib/dicomSpecial";
import { applyCharset } from "../src/lib/dicomCharset";
import type { DicomSRDocument, SRNode } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const code = (value: string, meaning: string, scheme = "DCM") => ({ code: value, scheme, meaning });
let n = 0;
const node = (partial: Partial<SRNode>): SRNode => ({ id: `n${++n}`, valueType: "TEXT", ...partial });
const num = (meaning: string, value: number, unit: string, codeValue?: string): SRNode =>
  node({ valueType: "NUM", conceptName: code(codeValue ?? "99TEST", meaning), numValue: { value, unit } });

const doc = (children: SRNode[], extra: Partial<DicomSRDocument> = {}): DicomSRDocument => ({
  id: "doc-1", title: "CT Doz Raporu", sopInstanceUid: "1.2.3.4.5", templateId: "10001",
  root: node({ valueType: "CONTAINER", children }),
  ...extra,
});

// ── 1. Ağaçtan çıkarma ──
const event = (protocol: string, ctdi: number, dlp: number) => node({
  valueType: "CONTAINER",
  conceptName: code(DOSE_CODES.irradiationEvent.value, DOSE_CODES.irradiationEvent.meaning),
  children: [
    node({ valueType: "TEXT", conceptName: code("113764", "Acquisition Protocol"), textValue: protocol }),
    num("CTDIvol", ctdi, "mGy", DOSE_CODES.ctdiVol.value),
    num("DLP", dlp, "mGy.cm", DOSE_CODES.dlp.value),
    num("Exposure Time", 1.2, "s", "113736"),
  ],
});

const full = doc([
  node({ valueType: "TEXT", conceptName: code(DOSE_CODES.procedureReported.value, "Procedure reported"), textValue: "Toraks BT, kontrastsız" }),
  event("Toraks rutin", 12.5, 480),
  event("Toraks takip", 9, 220),
]);
const report = extractDoseReport(full, { label: "doz.dcm" });
ok(!!report, "RDSR ağacından rapor çıkarıldı");
ok(report?.events.length === 2, "iki ışınlama olayı bulundu");
ok(report?.procedure === "Toraks BT, kontrastsız", "procedure reported (121058) okunur");
ok(report?.events[0].ctdiVol === 12.5 && report?.events[0].dlp === 480, "CTDIvol ve DLP sayısal okunur");
ok(report?.events[0].protocol === "Toraks rutin", "acquisition protocol metni alınır");
ok(report?.events[0].extras.some((e) => e.name === "Exposure Time") === true, "bilinmeyen sayısal değerler extras'a düşer");

const sumFull = report ? summarizeDose(report) : null;
ok(sumFull?.eventCount === 2, "özet olay sayısı");
ok(sumFull?.totalDlp === 700, "toplam DLP 700 mGy·cm");
ok(Math.abs((sumFull?.meanCtdiVol ?? 0) - 10.75) < 1e-9, "ortalama CTDIvol 10,75 mGy");
ok(sumFull?.maxCtdiVol === 12.5, "en yüksek CTDIvol 12,5 mGy");
ok(sumFull?.missingDlp === 0 && sumFull?.missingCtdiVol === 0, "eksik metrik yok");

const partial = extractDoseReport(doc([event("Eksik", 8, 100), node({
  valueType: "CONTAINER",
  conceptName: code(DOSE_CODES.irradiationEvent.value, "Irradiation Event X-Ray Data"),
  children: [num("CTDIvol", 5, "mGy")],
})]));
const sumPartial = partial ? summarizeDose(partial) : null;
ok(sumPartial?.totalDlp === 100, "DLP'si olmayan olay toplama katılmaz");
ok(sumPartial?.missingDlp === 1, "eksik DLP sayısı raporlanır");
ok((sumPartial?.notes ?? []).some((x) => x.includes("DLP yok")), "eksik DLP not olarak yazılır");

// Olay yok, yalnızca accumulated
const acc = extractDoseReport(doc([node({
  valueType: "CONTAINER",
  conceptName: code("113702", "Accumulated X-Ray Dose Data"),
  children: [num("Mean CTDIvol", 14, "mGy", DOSE_CODES.meanCtdiVol.value), num("DLP", 660, "mGy.cm")],
})]));
const sumAcc = acc ? summarizeDose(acc) : null;
ok(acc?.events.length === 0, "accumulated belgede olay yok");
ok(sumAcc?.totalDlp === 660 && sumAcc?.meanCtdiVol === 14, "accumulated DLP/CTDIvol özete geçer");
ok((acc?.warnings ?? []).some((w) => w.includes("Işınlama olayı")), "olay yokluğu uyarı olarak yazılır");

// Düz belge (konteyner yok)
const flat = extractDoseReport(doc([num("CTDIvol", 11, "mGy"), num("DLP", 300, "mGy.cm")]));
ok(flat ? summarizeDose(flat).totalDlp === 300 : false, "düz belgede kökteki DLP okunur");

// Doz değeri olmayan belge
ok(extractDoseReport(doc([node({ valueType: "TEXT", conceptName: code("121058", "Procedure reported"), textValue: "MR" })])) === null, "doz değeri yoksa null döner");

// ── 2. Gerçek DICOM baytları ──
const tag = (g: number, e: number) => ((g << 16) | e) >>> 0;
interface E { t: number; b: Uint8Array }
const S = (g: number, e: number, vr: string, v: string): E => ({ t: tag(g, e), b: vr === "UI" ? uidEl(g, e, v) : str(g, e, vr, v) });
const SQ = (g: number, e: number, items: Uint8Array[][]): E => {
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const body = concat(it);
    const h = new Uint8Array(8);
    const dv = new DataView(h.buffer);
    dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true); dv.setUint32(4, body.length, true);
    parts.push(h, body);
  }
  return { t: tag(g, e), b: el(g, e, "SQ", concat(parts)) };
};
const item = (...els: E[]): Uint8Array[] => els.slice().sort((a, b) => a.t - b.t).map((x) => x.b);
const concept = (c: { value: string; scheme: string; meaning: string }): E =>
  SQ(0x0040, 0xa043, [item(S(0x0008, 0x0100, "SH", c.value), S(0x0008, 0x0102, "SH", c.scheme), S(0x0008, 0x0104, "LO", c.meaning))]);
const numItem = (meaning: string, value: number, unit: string, c = "99TEST"): Uint8Array[] =>
  item(
    S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "NUM"),
    SQ(0x0040, 0xa300, [item(S(0x0040, 0xa30a, "DS", String(value)), SQ(0x0040, 0x08ea, [item(S(0x0008, 0x0100, "SH", unit), S(0x0008, 0x0102, "SH", "UCUM"), S(0x0008, 0x0104, "LO", unit))]))]),
    concept({ value: c, scheme: "DCM", meaning }),
  );
const textItem = (meaning: string, text: string, c = "99TEST"): Uint8Array[] =>
  item(S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "TEXT"), S(0x0040, 0xa160, "UT", text), concept({ value: c, scheme: "DCM", meaning }));
const eventItem = (protocol: string, ctdi: number, dlp: number): Uint8Array[] =>
  item(
    S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "CONTAINER"),
    concept({ value: DOSE_CODES.irradiationEvent.value, scheme: "DCM", meaning: DOSE_CODES.irradiationEvent.meaning }),
    S(0x0040, 0xa491, "CS", "COMPLETE"),
    SQ(0x0040, 0xa730, [textItem("Acquisition Protocol", protocol, "113764"), numItem("CTDIvol", ctdi, "mGy", DOSE_CODES.ctdiVol.value), numItem("DLP", dlp, "mGy.cm", DOSE_CODES.dlp.value)]),
  );

const body = concat([
  S(0x0008, 0x0005, "CS", "ISO_IR 192"),
  S(0x0008, 0x0016, "UI", SOP_RADIATION_DOSE_SR), S(0x0008, 0x0018, "UI", newUid()),
  S(0x0008, 0x0020, "DA", "20261120"), S(0x0008, 0x0023, "DA", "20261120"),
  S(0x0008, 0x0030, "TM", "101500"), S(0x0008, 0x0033, "TM", "101500"),
  S(0x0008, 0x0060, "CS", "SR"), S(0x0008, 0x0070, "LO", "TEST"),
  S(0x0008, 0x0080, "LO", "TEST KLINIK"),
  S(0x0008, 0x1030, "LO", "CT Doz"), S(0x0008, 0x103e, "LO", "RDSR"),
  S(0x0020, 0x000d, "UI", "1.2.840.113619.2.55.1"), S(0x0020, 0x000e, "UI", "1.2.840.113619.2.55.2"),
  S(0x0020, 0x0010, "SH", "S1"), S(0x0020, 0x0011, "IS", "1"), S(0x0020, 0x0013, "IS", "1"),
  S(0x0040, 0xa040, "CS", "CONTAINER"),
  concept({ value: "126000", scheme: "DCM", meaning: "Imaging Measurement Report" }),
  S(0x0040, 0xa491, "CS", "COMPLETE"), S(0x0040, 0xa493, "CS", "VERIFIED"),
  S(0x0040, 0xdb00, "SH", "10001"),
  SQ(0x0040, 0xa730, [
    item(S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "TEXT"), S(0x0040, 0xa160, "UT", "Batın BT"), concept({ value: DOSE_CODES.procedureReported.value, scheme: "DCM", meaning: DOSE_CODES.procedureReported.meaning })),
    eventItem("Batın portal venöz", 18.4, 910),
  ]),
].sort((a, b) => a.t - b.t).map((x) => x.b));

const meta = concat([
  el(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
  uidEl(0x0002, 0x0002, SOP_RADIATION_DOSE_SR), uidEl(0x0002, 0x0003, newUid()),
  uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"), uidEl(0x0002, 0x0012, newUid()), str(0x0002, 0x0013, "SH", "ATIKVIEWER"),
]);
const glen = new Uint8Array(4);
new DataView(glen.buffer).setUint32(0, meta.length, true);
const bytes = concat([new Uint8Array(128), enc.encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body]);

const ds = parseDicom(new Uint8Array(bytes));
ok(!!ds, "sentetik RDSR dicom-parser ile okunuyor");
ok(ds.string("x00080016") === SOP_RADIATION_DOSE_SR, "SOP Class UID RDSR (…88.67)");
const parsedDoc = ds ? parseStructuredReport(applyCharset(ds)) : null;
ok(parsedDoc?.templateId === "10001", "şablon kimliği (TID 10001) korunuyor");
const fromBytes = parsedDoc ? extractDoseReport(parsedDoc, { label: "rdsr.dcm" }) : null;
ok(!!fromBytes, "gerçek baytlardan doz raporu çıkarıldı");
ok(fromBytes?.procedure === "Batın BT", "procedure baytlardan okundu (UTF-8 karakter kümesi çözüldü)");
ok(fromBytes?.events.length === 1, "baytlardan bir olay okundu");
ok(fromBytes?.events[0].ctdiVol === 18.4 && fromBytes?.events[0].dlp === 910, "baytlardaki CTDIvol/DLP doğru");
ok(fromBytes?.events[0].protocol === "Batın portal venöz", "protokol adı baytlardan okundu");

// ── 3. Etkin doz + DRL + metin ──
ok(effectiveDoseMsv(700, "chest") === 700 * 0.014, "etkin doz = DLP × bölge katsayısı");
ok(effectiveDoseMsv(undefined, "chest") === undefined, "DLP yoksa etkin doz hesaplanmaz");
ok(effectiveDoseMsv(-1, "chest") === undefined, "negatif DLP reddedilir");
ok(EFFECTIVE_DOSE_REGIONS.every((r) => r.k > 0 && r.k < 0.05), "bölge katsayıları makul aralıkta (yaklaşık)");

const cmp = sumFull ? compareToDrl(sumFull, { ctdiVol: 10, dlp: 700 }) : [];
ok(cmp.length === 2, "iki metrik karşılaştırılır");
ok(cmp.some((c) => c.metric === "dlp" && c.level === "yakinda" && c.ratio === 1), "DLP tam DRL'de 'yakında'");
const over = sumFull ? compareToDrl(sumFull, { dlp: 500 }) : [];
ok(over[0]?.level === "ustunde" && over[0].ratio > 1.1, "DRL üstü 'üstünde' işaretlenir");
const under = sumFull ? compareToDrl(sumFull, { dlp: 5000 }) : [];
ok(under[0]?.level === "altinda", "DRL altı 'altında' işaretlenir");
ok(sumFull ? compareToDrl(sumFull, {}).length === 0 : false, "DRL girilmemişse karşılaştırma yok");
ok(sumFull ? compareToDrl(sumFull, { dlp: 0 }).length === 0 : false, "sıfır DRL yok sayılır");
ok(ORNEK_DRL.every((d) => d.source?.includes("örnek")), "örnek DRL değerleri 'örnek' olarak işaretli");
ok(ORNEK_DRL.every((d) => (d.ctdiVol ?? 0) > 0 && (d.dlp ?? 0) > 0), "örnek DRL değerleri pozitif");

const text = report && sumFull ? doseSummaryText(report, sumFull, { region: "chest", drl: { dlp: 500 } }) : "";
ok(text.includes("Toplam DLP: 700.0"), "metin özeti toplam DLP içerir");
ok(text.includes("Yaklaşık etkin doz: 9.80 mSv"), "metin etkin dozu içerir");
ok(text.includes("DRL"), "metin DRL karşılaştırmasını içerir");
ok(text.includes("klinik karar aracı değildir"), "metin uyarı satırı taşır");
const textNoRegion = report && sumFull ? doseSummaryText(report, sumFull) : "";
ok(!textNoRegion.includes("etkin doz"), "bölge seçilmezse etkin doz satırı yazılmaz");

if (failed) { console.error(`${failed} doz testi başarısız`); process.exit(1); }
console.log("Tüm radyasyon dozu (RDSR) testleri geçti.");

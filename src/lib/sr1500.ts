/**
 * DICOM SR — TID 1500 (Imaging Measurement Report) ve kodlu ölçümler.
 *
 * Neden gerekli: `dicomSr.buildReportSr` **Basic Text SR** üretir; ölçümler serbest
 * metin olarak gider, PACS/izleyici bunları yeniden işleyemez. TID 1500'de her
 * ölçüm sayısal (NUM) olarak, izleme kimliği ve kodlu bulgu/bölge ile yazılır:
 *
 *   Imaging Measurement Report (126000)          ← kapsayıcı
 *    └─ Imaging Measurements (126010)
 *        └─ Measurement Group (125007)           ← her ölçüm için bir tane
 *            ├─ Tracking Identifier (112039, TEXT)
 *            ├─ Tracking Unique Identifier (112040, UIDREF)
 *            ├─ Finding (121071, CODE)
 *            ├─ Finding Site (363698007, CODE)
 *            ├─ Numeric Value (NUM: değer + birim kodu)
 *            └─ Referenced Image (121191, IMAGE)
 *
 * Kodlama ilkesi: kod UYDURULMAZ. Standart kod yalnızca kesin bilinen yerlerde
 * (DICOM TID 1500/300 kodları) yazılır; bölge/bulgu kodları çağırandan gelir ve
 * bilinmeyenler `99ATIKVIEWER` özel şemasıyla işaretlenir. Lisanslı RadLex/SNOMED
 * sözlüğü kuruma bırakılmıştır.
 */
import { concat, el, enc, newUid, pad, str, uidEl } from "./dicomWrite";

export const SOP_COMPREHENSIVE_SR = "1.2.840.10008.5.1.4.1.1.88.33";

export interface Code {
  value: string;
  scheme: string;
  meaning: string;
}

/** TID 1500/300 standart kodları (DICOM standardı). */
export const CODES = {
  measurementReport: { value: "126000", scheme: "DCM", meaning: "Imaging Measurement Report" },
  imagingMeasurements: { value: "126010", scheme: "DCM", meaning: "Imaging Measurements" },
  measurementGroup: { value: "125007", scheme: "DCM", meaning: "Measurement Group" },
  trackingIdentifier: { value: "112039", scheme: "DCM", meaning: "Tracking Identifier" },
  trackingUid: { value: "112040", scheme: "DCM", meaning: "Tracking Unique Identifier" },
  finding: { value: "121071", scheme: "DCM", meaning: "Finding" },
  findingSite: { value: "363698007", scheme: "SCT", meaning: "Finding Site" },
  referencedImage: { value: "121191", scheme: "DCM", meaning: "Referenced Image" },
} as const;

/** Ölçüm türü kodları (NUM öğesinin kavram adı). */
export const QUANTITY = {
  length: { value: "410668003", scheme: "SCT", meaning: "Length" },
  volume: { value: "G-D705", scheme: "SRT", meaning: "Volume" },
  mean: { value: "112022", scheme: "DCM", meaning: "Mean" },
  max: { value: "56816-2", scheme: "LN", meaning: "Maximum" },
  suvMax: { value: "126105", scheme: "DCM", meaning: "SUV max" },
} as const satisfies Record<string, Code>;
export type QuantityId = keyof typeof QUANTITY;

/** Birim kodu eşlemesi (UCUM). */
export const UNITS: Record<string, Code> = {
  mm: { value: "mm", scheme: "UCUM", meaning: "millimeter" },
  cm: { value: "cm", scheme: "UCUM", meaning: "centimeter" },
  mm2: { value: "mm2", scheme: "UCUM", meaning: "square millimeter" },
  mm3: { value: "mm3", scheme: "UCUM", meaning: "cubic millimeter" },
  cm3: { value: "cm3", scheme: "UCUM", meaning: "cubic centimeter" },
  hu: { value: "[hnsf'U]", scheme: "UCUM", meaning: "Hounsfield unit" },
  suv: { value: "{SUVbw}", scheme: "UCUM", meaning: "SUV body weight" },
  pct: { value: "%", scheme: "UCUM", meaning: "percent" },
};

const ATIK = "99ATIKVIEWER";
export const atikCode = (value: string, meaning: string): Code => ({ value, scheme: ATIK, meaning });

/**
 * Hazır bölge kodları. Yalnızca yaygın SNOMED CT kavramları; başka bölgeler için
 * `atikCode()` ile özel kod üretilir (uydurma SNOMED kodu yazılmaz).
 */
export const SITES: Record<string, Code> = {
  akciger: { value: "39607008", scheme: "SCT", meaning: "Lung" },
  beyin: { value: "12738006", scheme: "SCT", meaning: "Brain" },
  karaciger: { value: "10200004", scheme: "SCT", meaning: "Liver" },
};

export interface Measurement {
  /** Kararlı izleme kimliği (ör. "NOD-1") */
  trackingId: string;
  /** İzleme UID'si; verilmezse üretilir */
  trackingUid?: string;
  value: number;
  /** Birim anahtarı (`UNITS`) veya UCUM kodu */
  unit: string;
  quantity: Code;
  finding: Code;
  site?: Code;
  image?: { seriesUid: string; sopClassUid: string; sopUid: string };
}

export interface Sr1500Input {
  patientName: string; patientId: string; patientSex: string; patientAge?: string;
  studyUid: string; studyDate: string; institution: string; studyModality?: string;
  title?: string;
  measurements: Measurement[];
  approvedBy?: string; doctorTitle?: string; approvedAt?: string | null;
}

// ── DICOM yazım yardımcıları (dicomSr ile aynı desen) ──
interface E { t: number; b: Uint8Array }
const tag = (g: number, e: number) => ((g << 16) | e) >>> 0;
const S = (g: number, e: number, vr: string, v: string): E => ({ t: tag(g, e), b: vr === "UI" ? uidEl(g, e, v) : str(g, e, vr, v) });
const UT = (g: number, e: number, v: string): E => ({ t: tag(g, e), b: el(g, e, "UT", pad(enc.encode(v), 0x20)) });
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
/** Tek öğeli SQ: verilen alan listesinden tek bir içerik öğesi üretir. */
const SQe = (g: number, e: number, els: E[]): E => SQ(g, e, [item(...els)]);
const build = (els: E[]): Uint8Array => concat(els.slice().sort((a, b) => a.t - b.t).map((x) => x.b));

const codeItem = (c: Code): Uint8Array[] =>
  item(S(0x0008, 0x0100, "SH", c.value), S(0x0008, 0x0102, "SH", c.scheme), S(0x0008, 0x0104, "LO", c.meaning));
const conceptName = (c: Code): E => SQ(0x0040, 0xa043, [codeItem(c)]);

const pn = (name: string) => (name || "").trim().replace(/\s+/g, "^").slice(0, 60);
const digits = (s: string) => (s || "").replace(/\D/g, "");
const dicomDate = (s: string, fallback = new Date()) => { const d = digits(s).slice(0, 8); return d.length === 8 ? d : fallback.toISOString().slice(0, 10).replace(/-/g, ""); };
const nowTM = (d = new Date()) => d.toISOString().slice(11, 19).replace(/:/g, "");
const nowDA = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Sayısal değeri DS (≤16 karakter) biçimine getirir. */
export function dsValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  let s = Math.abs(v) >= 1 ? v.toFixed(3).replace(/\.?0+$/, "") : v.toPrecision(5);
  if (s.includes("e")) s = v.toFixed(6).replace(/\.?0+$/, "");
  return s.slice(0, 16);
}

/** Birim anahtarını koda çevirir; bilinmeyen anahtar UCUM kodu olarak geçer. */
export function unitCode(unit: string): Code {
  const k = (unit || "").trim();
  return UNITS[k] ?? { value: k || "1", scheme: "UCUM", meaning: k || "no units" };
}

/** Ölçümleri doğrular; geçersizleri nedeniyle ayırır (gönderim öncesi gösterilir). */
export function validateMeasurements(ms: Measurement[]): { ok: Measurement[]; rejected: { index: number; reason: string }[] } {
  const ok: Measurement[] = [];
  const rejected: { index: number; reason: string }[] = [];
  ms.forEach((m, index) => {
    if (!m.trackingId?.trim()) { rejected.push({ index, reason: "İzleme kimliği boş" }); return; }
    if (!Number.isFinite(m.value)) { rejected.push({ index, reason: "Değer sayısal değil" }); return; }
    if (!m.unit?.trim()) { rejected.push({ index, reason: "Birim yok" }); return; }
    if (!m.finding?.value || !m.finding?.scheme) { rejected.push({ index, reason: "Bulgu kodu yok" }); return; }
    ok.push(m);
  });
  return { ok, rejected };
}

/**
 * TID 300 ölçüm grubunun içerik öğesi: (0040,A010) CONTAINS + 125007 konteyneri.
 * Export edilir; testler ve SR incelemesi aynı üreticiyi kullanır.
 */
export function measurementGroupItem(m: Measurement): Uint8Array[] {
  const unit = unitCode(m.unit);
  const children: E[] = [
    // İzleme kimliği (TEXT) ve UID
    S(0x0040, 0xa010, "CS", "HAS OBS CONTEXT"), S(0x0040, 0xa040, "CS", "TEXT"),
    S(0x0040, 0xa160, "UT", m.trackingId.slice(0, 64)), conceptName(CODES.trackingIdentifier),
    S(0x0040, 0xa010, "CS", "HAS OBS CONTEXT"), S(0x0040, 0xa040, "CS", "UIDREF"),
    S(0x0040, 0xa124, "UI", m.trackingUid ?? newUid()), conceptName(CODES.trackingUid),
    // Bulgu + bölge
    S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "CODE"),
    SQ(0x0040, 0xa168, [codeItem(m.finding)]), conceptName(CODES.finding),
  ];
  if (m.site) {
    children.push(
      S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "CODE"),
      SQ(0x0040, 0xa168, [codeItem(m.site)]), conceptName(CODES.findingSite),
    );
  }
  children.push(
    S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "NUM"),
    SQ(0x0040, 0xa300, [item(S(0x0040, 0xa30a, "DS", dsValue(m.value)), SQ(0x0040, 0x08ea, [codeItem(unit)]))]),
    conceptName(m.quantity),
  );
  if (m.image) {
    children.push(
      S(0x0040, 0xa010, "CS", "SELECTED FROM"), S(0x0040, 0xa040, "CS", "IMAGE"),
      SQ(0x0008, 0x1199, [item(S(0x0008, 0x1150, "UI", m.image.sopClassUid), S(0x0008, 0x1155, "UI", m.image.sopUid))]),
      conceptName(CODES.referencedImage),
    );
  }
  return item(
    S(0x0040, 0xa010, "CS", "CONTAINS"),
    S(0x0040, 0xa040, "CS", "CONTAINER"),
    conceptName(CODES.measurementGroup),
    S(0x0040, 0xa050, "CS", "SEPARATE"),
    S(0x0040, 0xa491, "CS", "COMPLETE"),
    SQe(0x0040, 0xa730, children),
  );
}

function wrap(sopClass: string, sopUid: string, body: Uint8Array): Uint8Array {
  const meta = concat([
    el(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    uidEl(0x0002, 0x0002, sopClass), uidEl(0x0002, 0x0003, sopUid),
    uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"), uidEl(0x0002, 0x0012, newUid()), str(0x0002, 0x0013, "SH", "ATIKVIEWER"),
  ]);
  const glen = new Uint8Array(4);
  new DataView(glen.buffer).setUint32(0, meta.length, true);
  return concat([new Uint8Array(128), enc.encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body]);
}

/**
 * Ölçüm raporu → DICOM Comprehensive SR (TID 1500).
 * `measurements` boşsa boş kapsayıcı yazılmaz: çağıran doğrulamalıdır.
 */
export function buildMeasurementReportSr(input: Sr1500Input): Uint8Array {
  const sop = newUid();
  const now = new Date();
  const groups = input.measurements.map(measurementGroupItem);
  const els: E[] = [
    S(0x0008, 0x0005, "CS", "ISO_IR 192"),
    S(0x0008, 0x0016, "UI", SOP_COMPREHENSIVE_SR), S(0x0008, 0x0018, "UI", sop),
    S(0x0008, 0x0020, "DA", dicomDate(input.studyDate, now)), S(0x0008, 0x0023, "DA", nowDA(now)),
    S(0x0008, 0x0030, "TM", "000000"), S(0x0008, 0x0033, "TM", nowTM(now)),
    S(0x0008, 0x0060, "CS", "SR"), S(0x0008, 0x0070, "LO", "AtikViewer"),
    S(0x0008, 0x0080, "LO", (input.institution || "").slice(0, 60)),
    S(0x0008, 0x103e, "LO", input.title?.slice(0, 64) || "Yapılandırılmış ölçümler (TID 1500)"),
    S(0x0010, 0x0010, "PN", pn(input.patientName)), S(0x0010, 0x0020, "LO", (input.patientId || "").slice(0, 60)),
    S(0x0010, 0x0040, "CS", /^[MFO]$/.test(input.patientSex) ? input.patientSex : ""),
    S(0x0018, 0x1020, "LO", "AtikViewer"),
    S(0x0020, 0x000d, "UI", input.studyUid), S(0x0020, 0x000e, "UI", newUid()),
    S(0x0020, 0x0010, "SH", "1"), S(0x0020, 0x0011, "IS", "950"), S(0x0020, 0x0013, "IS", "1"),
    // Kapsayıcı: Imaging Measurement Report (126000)
    S(0x0040, 0xa040, "CS", "CONTAINER"),
    conceptName(CODES.measurementReport),
    S(0x0040, 0xa050, "CS", "SEPARATE"),
    S(0x0040, 0xa491, "CS", "COMPLETE"),
    S(0x0040, 0xa493, "CS", input.approvedAt && input.approvedBy ? "VERIFIED" : "UNVERIFIED"),
    SQ(0x0040, 0xa730, [
      item(
        S(0x0040, 0xa010, "CS", "CONTAINS"),
        S(0x0040, 0xa040, "CS", "CONTAINER"),
        conceptName(CODES.imagingMeasurements),
        S(0x0040, 0xa050, "CS", "SEPARATE"),
        S(0x0040, 0xa491, "CS", "COMPLETE"),
        SQ(0x0040, 0xa730, groups),
      ),
    ]),
  ];
  if (input.approvedAt && input.approvedBy) {
    const dt = digits(String(input.approvedAt).replace(/\.\d+/, "")).slice(0, 14).padEnd(14, "0");
    const w = (input.approvedBy || "").trim().split(/\s+/).filter(Boolean);
    const doctor = w.length ? `${w[w.length - 1]}^${w.slice(0, -1).join(" ")}^^${(input.doctorTitle || "").trim()}` : "";
    els.push(SQ(0x0040, 0xa073, [item(
      S(0x0040, 0xa027, "LO", (input.institution || "AtikViewer").slice(0, 60)),
      S(0x0040, 0xa030, "DT", dt),
      S(0x0040, 0xa075, "PN", doctor.slice(0, 60)),
    )]));
  }
  return wrap(SOP_COMPREHENSIVE_SR, sop, build(els));
}

/** SR metninde geçen kodları (denetim/rapor için) listeler. */
export function codeSummary(ms: Measurement[]): string[] {
  return ms.map((m) => `${m.trackingId}: ${m.finding.scheme}/${m.finding.value} (${m.finding.meaning}) · ${m.quantity.meaning} ${dsValue(m.value)} ${unitCode(m.unit).value}`);
}

import { concat, el, enc, newUid, pad, str, uidEl, us } from "./dicomWrite";
import { annotationsToGsps, LAYER_KIND, type GspsAnnotationItem, type GspsGraphic, type GspsGraphicType, type GspsText } from "./gspsGraphics";
import type { Annotation, DicomGSPS } from "./types";

/**
 * DICOM Basic Text SR (rapor) ve Key Object Selection (anahtar kesit) belgeleri.
 * Explicit VR Little Endian, UTF-8 (ISO_IR 192). Etiketler artan sırada yazılır.
 */
export const SOP_BASIC_TEXT_SR = "1.2.840.10008.5.1.4.1.1.88.11";
export const SOP_KEY_OBJECT = "1.2.840.10008.5.1.4.1.1.88.59";

interface E { t: number; b: Uint8Array }
const tag = (g: number, e: number) => ((g << 16) | e) >>> 0;
const S = (g: number, e: number, vr: string, v: string): E => ({ t: tag(g, e), b: vr === "UI" ? uidEl(g, e, v) : str(g, e, vr, v) });
/** US (tek değer) ve FL (float dizisi) yazıcıları: GSPS grafik verisi için. */
const US_EL = (g: number, e: number, n: number): E => ({ t: tag(g, e), b: us(g, e, n) });
const FL_EL = (g: number, e: number, vals: number[]): E => {
  const b = new Uint8Array(4 * vals.length);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return { t: tag(g, e), b: el(g, e, "FL", b) };
};
const UT = (g: number, e: number, v: string): E => ({ t: tag(g, e), b: el(g, e, "UT", pad(enc.encode(v), 0x20)) });
/** Tanımlı uzunluklu dizi (SQ). */
const SQ = (g: number, e: number, items: Uint8Array[][]): E => {
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const body = concatSorted(it);
    const h = new Uint8Array(8);
    const dv = new DataView(h.buffer);
    dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true); dv.setUint32(4, body.length, true);
    parts.push(h, body);
  }
  return { t: tag(g, e), b: el(g, e, "SQ", concat(parts)) };
};
// `items` içindeki öğeler E[] olarak da verilebilsin diye iki aşamalı yardımcılar:
function concatSorted(x: Uint8Array[]): Uint8Array { return concat(x); }
const item = (...els: E[]): Uint8Array[] => els.slice().sort((a, b) => a.t - b.t).map((x) => x.b);
const build = (els: E[]): Uint8Array => concat(els.slice().sort((a, b) => a.t - b.t).map((x) => x.b));

const code = (value: string, scheme: string, meaning: string): Uint8Array[] =>
  item(S(0x0008, 0x0100, "SH", value), S(0x0008, 0x0102, "SH", scheme), S(0x0008, 0x0104, "LO", meaning));
const codeSeq = (g: number, e: number, value: string, scheme: string, meaning: string): E => SQ(g, e, [code(value, scheme, meaning)]);

const digits = (s: string) => (s || "").replace(/\D/g, "");
export const dicomDate = (s: string, fallback = new Date()) => { const d = digits(s).slice(0, 8); return d.length === 8 ? d : fallback.toISOString().slice(0, 10).replace(/-/g, ""); };
const nowTM = (d = new Date()) => d.toISOString().slice(11, 19).replace(/:/g, "");
const nowDA = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, "");
/** DICOM PN: Soyad^Ad^Orta^Önek^Sonek. Hastada kaynak sırası (SOYAD AD) korunur; hekimde son sözcük soyad, unvan önek olur. */
const pn = (name: string) => (name || "").trim().replace(/\s+/g, "^").slice(0, 60);
const pnDoctor = (title: string, name: string) => {
  const w = (name || "").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return "";
  return `${w[w.length - 1]}^${w.slice(0, -1).join(" ")}^^${(title || "").trim()}`.slice(0, 60);
};

export interface PatientStudy {
  patientName: string; patientId: string; patientSex: string; patientAge?: string;
  studyUid: string; studyDate: string; institution: string; studyModality?: string;
}
export interface EvidenceRef { seriesUid: string; sopClassUid: string; sopUids: string[] }

function evidence(studyUid: string, ev: EvidenceRef | null): E[] {
  if (!ev || ev.sopUids.length === 0) return [];
  return [SQ(0x0040, 0xa375, [item(
    S(0x0020, 0x000d, "UI", studyUid),
    SQ(0x0008, 0x1115, [item(
      S(0x0020, 0x000e, "UI", ev.seriesUid),
      SQ(0x0008, 0x1199, ev.sopUids.map((u) => item(S(0x0008, 0x1150, "UI", ev.sopClassUid), S(0x0008, 0x1155, "UI", u)))),
    )]),
  )])];
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

function common(p: PatientStudy, sopClass: string, sopUid: string, modality: string, seriesDesc: string, seriesNo: number, instNo: number): E[] {
  const now = new Date();
  return [
    S(0x0008, 0x0005, "CS", "ISO_IR 192"),
    S(0x0008, 0x0016, "UI", sopClass), S(0x0008, 0x0018, "UI", sopUid),
    S(0x0008, 0x0020, "DA", dicomDate(p.studyDate, now)), S(0x0008, 0x0023, "DA", nowDA(now)),
    S(0x0008, 0x0030, "TM", "000000"), S(0x0008, 0x0033, "TM", nowTM(now)),
    S(0x0008, 0x0050, "SH", ""), S(0x0008, 0x0060, "CS", modality), S(0x0008, 0x0070, "LO", "AtikViewer"),
    S(0x0008, 0x0080, "LO", (p.institution || "").slice(0, 60)), S(0x0008, 0x0090, "PN", ""),
    S(0x0008, 0x103e, "LO", seriesDesc),
    S(0x0010, 0x0010, "PN", pn(p.patientName)), S(0x0010, 0x0020, "LO", (p.patientId || "").slice(0, 60)),
    S(0x0010, 0x0030, "DA", ""), S(0x0010, 0x0040, "CS", /^[MFO]$/.test(p.patientSex) ? p.patientSex : ""),
    S(0x0018, 0x1020, "LO", "AtikViewer"),
    S(0x0020, 0x000d, "UI", p.studyUid), S(0x0020, 0x000e, "UI", newUid()),
    S(0x0020, 0x0010, "SH", "1"), S(0x0020, 0x0011, "IS", String(seriesNo)), S(0x0020, 0x0013, "IS", String(instNo)),
  ];
}

const textItem = (concept: Uint8Array[], text: string): Uint8Array[] =>
  item(S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "TEXT"), SQ(0x0040, 0xa043, [concept]), UT(0x0040, 0xa160, text));

export interface ReportSrInput extends PatientStudy {
  clinicalInfo: string; technique: string; findings: string; impression: string; recommendation: string; measurements?: string;
  approvedBy?: string; doctorTitle?: string; approvedAt?: string | null; contentHash?: string;
  evidence?: EvidenceRef | null;
}

/** Radyoloji raporu → DICOM Basic Text SR. Onaylı rapor VERIFIED işaretlenir (imza değildir). */
export function buildReportSr(r: ReportSrInput): Uint8Array {
  const sop = newUid();
  const verified = !!r.approvedAt && !!r.approvedBy;
  const sections: Uint8Array[][] = [];
  const add = (c: Uint8Array[], text: string) => { if (text && text.trim()) sections.push(textItem(c, text.trim())); };
  add(code("ATIK-CLIN", "99ATIKVIEWER", "Klinik bilgi"), r.clinicalInfo);
  add(code("ATIK-TECH", "99ATIKVIEWER", "Teknik"), r.technique);
  add(code("121070", "DCM", "Findings"), r.findings);
  if (r.measurements) add(code("ATIK-MEAS", "99ATIKVIEWER", "Ölçümler"), r.measurements);
  add(code("121073", "DCM", "Impression"), r.impression);
  add(code("ATIK-RECO", "99ATIKVIEWER", "Öneri"), r.recommendation);
  const els: E[] = [
    ...common(r, SOP_BASIC_TEXT_SR, sop, "SR", "Radyoloji Raporu", 900, 1),
    S(0x0040, 0xa040, "CS", "CONTAINER"),
    codeSeq(0x0040, 0xa043, "11528-7", "LN", "Radiology Report"),
    S(0x0040, 0xa050, "CS", "SEPARATE"),
    SQ(0x0040, 0xa372, []),
    ...evidence(r.studyUid, r.evidence ?? null),
    S(0x0040, 0xa491, "CS", "COMPLETE"),
    S(0x0040, 0xa493, "CS", verified ? "VERIFIED" : "UNVERIFIED"),
    SQ(0x0040, 0xa730, sections),
  ];
  if (verified) {
    const dt = digits(r.approvedAt!.replace(/\.\d+/, "")).slice(0, 14).padEnd(14, "0");
    els.push(SQ(0x0040, 0xa073, [item(
      S(0x0040, 0xa027, "LO", (r.institution || "AtikViewer").slice(0, 60)),
      S(0x0040, 0xa030, "DT", dt),
      S(0x0040, 0xa075, "PN", pnDoctor(r.doctorTitle ?? "", r.approvedBy ?? "")),
      SQ(0x0040, 0xa088, []),
    )]));
  }
  return wrap(SOP_BASIC_TEXT_SR, sop, build(els));
}

export interface KeyObjectInput extends PatientStudy {
  title?: string;
  seriesUid: string; sopClassUid: string;
  items: { sopUid: string; note?: string }[];
}

export const SOP_PRESENTATION_STATE = "1.2.840.10008.5.1.4.1.1.11.1";

export interface PresentationStateInput extends PatientStudy {
  seriesUid: string; sopClassUid: string; sopUids: string[];
  wl: number; ww: number;
  rotation?: 0 | 90 | 180 | 270;
  flipH?: boolean; flipV?: boolean; invert?: boolean;
  /** Ekran ölçüm/işaretleri: GSPS grafik katmanı olarak yazılır (isteğe bağlı). */
  annotations?: Annotation[];
}

/**
 * Anotasyonlar → GSPS grafik katmanı + grafik/metin nesneleri.
 * Graphic Layer Sequence (0070,0060) ve Graphic Annotation Sequence (0070,0001);
 * her anotasyon kendi referans görüntüsüne (0008,1140) bağlanır.
 */
function gspsAnnotationEls(items: GspsAnnotationItem[], sopUids: string[], sopClassUid: string): E[] {
  if (items.length === 0) return [];
  const annots: Uint8Array[][] = items.map((i) =>
    item(
      S(0x0070, 0x0002, "CS", i.layer),
      SQ(0x0008, 0x1140, [item(S(0x0008, 0x1150, "UI", sopClassUid), S(0x0008, 0x1155, "UI", sopUids[i.slice]))]),
      SQ(0x0070, 0x0008, i.texts.map((t) => item(
        S(0x0070, 0x0003, "CS", "PIXEL"), S(0x0070, 0x0004, "CS", "PIXEL"),
        S(0x0070, 0x0006, "ST", t.text),
        FL_EL(0x0070, 0x0014, t.anchor),
        S(0x0070, 0x0018, "CS", "LEFT"),
      ))),
      SQ(0x0070, 0x0009, i.graphics.map((g) => item(
        S(0x0070, 0x0005, "CS", "PIXEL"),
        US_EL(0x0070, 0x0020, 2),
        US_EL(0x0070, 0x0021, g.data.length / 2),
        FL_EL(0x0070, 0x0022, g.data),
        S(0x0070, 0x0023, "CS", g.type),
        S(0x0070, 0x0024, "CS", "N"),
      ))),
    ),
  );
  // Graphic Layer Sequence: kullanılan her katman için bir öğe (sıra = çizim sırası).
  const layers = [...new Set(items.map((i) => i.layer))];
  return [
    SQ(0x0070, 0x0060, layers.map((name, idx) => item(
      S(0x0070, 0x0002, "CS", name),
      US_EL(0x0070, 0x0061, 255),
      S(0x0070, 0x0062, "IS", String(idx + 1)),
    ))),
    SQ(0x0070, 0x0001, annots),
  ];
}

/**
 * Görünüm durumu → DICOM Grayscale Softcopy Presentation State (GSPS, PR).
 * Kaydetme içeriği: referans seri/kesitler, pencere (VOI LUT), döndürme ve yatay
 * çevirme. Not: PR bir rapor/imza belgesi DEĞİLDİR; yalnızca sunum ayarlarını taşır.
 */
export function buildPresentationState(p: PresentationStateInput): Uint8Array {
  const sop = newUid();
  const num = (v: number) => String(Math.round(v * 100) / 100);
  const els: E[] = [
    ...common(p, SOP_PRESENTATION_STATE, sop, "PR", "Sunum Durumu", 902, 1),
    SQ(0x0008, 0x1115, [item(
      S(0x0020, 0x000e, "UI", p.seriesUid),
      SQ(0x0008, 0x1140, p.sopUids.map((u) => item(S(0x0008, 0x1150, "UI", p.sopClassUid), S(0x0008, 0x1155, "UI", u)))),
    )]),
    // Softcopy VOI LUT: kaydedilen pencere/seviye
    SQ(0x0028, 0x3010, [item(
      S(0x0028, 0x1050, "DS", num(p.wl)),
      S(0x0028, 0x1051, "DS", num(Math.max(1, p.ww))),
    )]),
    S(0x0070, 0x0041, "CS", String(p.rotation ?? 0)),
    S(0x0070, 0x0042, "CS", p.flipH ? "Y" : "N"),
    ...gspsAnnotationEls(annotationsToGsps(p.annotations ?? []).filter((i) => !!p.sopUids[i.slice]), p.sopUids, p.sopClassUid),
    S(0x0070, 0x0080, "CS", "ATIK-PR"),
    UT(0x0070, 0x0081, `WL=${num(p.wl)} WW=${num(Math.max(1, p.ww))} dondurme=${String(p.rotation ?? 0)} yatayCevir=${p.flipH ? "Y" : "N"} dikeyCevir=${p.flipV ? "Y" : "N"} ters=${p.invert ? "Y" : "N"}`),
  ];
  return wrap(SOP_PRESENTATION_STATE, sop, build(els));
}

/**
 * Mevcut GSPS'yi (DicomGSPS) `GspsAnnotationItem[]` öğelerine çevirir —
 * her grafik nesnesinin bağlı olduğu kesit (sopUids üzerinden indeks) ve
 * katman kimliği korunur. Eski PR'ın grafikleri yeni PR'da aynı şekilde
 * geri yazılır (güncelleme akışı).
 */
function gspsToAnnotationItems(base: DicomGSPS, sopUids: string[]): GspsAnnotationItem[] {
  const items: GspsAnnotationItem[] = [];
  const refs = base.referenceSopUids ?? [];
  for (let i = 0; i < base.graphics.length; i++) {
    const g = base.graphics[i];
    const refUid = refs[i];
    const slice = refUid ? sopUids.indexOf(refUid) : -1;
    if (slice < 0) continue; // bu PR'ın referans listesinde yok → yazılmamaz
    const layer = base.layers?.[i] ?? "ANNOT";
    items.push({
      slice,
      graphics: [{ type: (g.type as GspsGraphicType), data: g.data } as GspsGraphic],
      texts: [],
      kind: LAYER_KIND[layer] ?? "arrow",
      layer,
    });
  }
  // Eski metin nesneleri: ilgili kesite bağlanır (referans yoksa atlanır).
  for (const t of base.texts) {
    const slice = t.referenceSopUid ? sopUids.indexOf(t.referenceSopUid) : -1;
    if (slice < 0) continue;
    const item = items.find((it) => it.slice === slice);
    if (item) {
      item.texts.push({
        text: t.text,
        anchor: t.anchorPoint ? [t.anchorPoint.x, t.anchorPoint.y] : [0, 0],
      });
    } else {
      items.push({
        slice,
        graphics: [],
        texts: [{ text: t.text, anchor: t.anchorPoint ? [t.anchorPoint.x, t.anchorPoint.y] : [0, 0] }],
        kind: "length",
        layer: "ANNOT",
      });
    }
  }
  return items;
}

/**
 * GSPS öğelerini birleştirir: mevcut öğelere yenileri eklenir; slice+layer+
 * geometri eşit olanlar bir kez yazılır (tekilleştirme). Sıra korunur.
 */
function mergeGspsItems(base: GspsAnnotationItem[], incoming: GspsAnnotationItem[]): GspsAnnotationItem[] {
  const seen = new Set(base.map((it) => `${it.slice}|${it.layer}|${it.graphics.map((g) => g.data.join(",")).join(";")}`));
  const out = base.slice();
  for (const it of incoming) {
    const key = `${it.slice}|${it.layer}|${it.graphics.map((g) => g.data.join(",")).join(";")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Presentation State güncelleme akışı (f-objects).
 *
 * Mevcut bir GSPS (base) + yeni görünüm durumu + yeni anotasyonlar alır;
 * eski grafik/metin/katmanlar korunduktan sonra yeniler eklenerek **yeni bir
 * PR** üretir. DICOM'da PR güncellemesi yeni SOP Instance UID ile yapılır ve
 * önceki instance'a (0008,1155) referans verilir — geçmişe dokunulmaz.
 * Base tanımlı değilse `buildPresentationState` gibi yeni bir PR üretir.
 */
export interface PresentationStateUpdateInput extends PresentationStateInput {
  /** Güncellenecek mevcut PR (null ise yeni PR üretilir) */
  baseGsps?: DicomGSPS | null;
}

export function buildUpdatedPresentationState(p: PresentationStateUpdateInput): Uint8Array {
  const base = p.baseGsps ?? null;
  const sop = newUid();
  const num = (v: number) => String(Math.round(v * 100) / 100);
  // Eski PR'ın grafikleri + yeni anotasyonlar birleştirilir.
  const baseItems = base ? gspsToAnnotationItems(base, p.sopUids) : [];
  const newItems = annotationsToGsps(p.annotations ?? []).filter((i) => !!p.sopUids[i.slice]);
  const merged = mergeGspsItems(baseItems, newItems);
  // Eski PR'ın SOP Instance UID'si varsa güncelleme notuna yazılır (referans).
  const baseSopUid = base?.sopInstanceUid ?? "";
  const els: E[] = [
    ...common(p, SOP_PRESENTATION_STATE, sop, "PR", "Sunum Durumu", 902, 1),
    SQ(0x0008, 0x1115, [item(
      S(0x0020, 0x000e, "UI", p.seriesUid),
      SQ(0x0008, 0x1140, p.sopUids.map((u) => item(S(0x0008, 0x1150, "UI", p.sopClassUid), S(0x0008, 0x1155, "UI", u)))),
    )]),
    // Softcopy VOI LUT: güncel pencere/seviye
    SQ(0x0028, 0x3010, [item(
      S(0x0028, 0x1050, "DS", num(p.wl)),
      S(0x0028, 0x1051, "DS", num(Math.max(1, p.ww))),
    )]),
    S(0x0070, 0x0041, "CS", String(p.rotation ?? 0)),
    S(0x0070, 0x0042, "CS", p.flipH ? "Y" : "N"),
    ...gspsAnnotationEls(merged, p.sopUids, p.sopClassUid),
    S(0x0070, 0x0080, "CS", "ATIK-PR"),
    UT(0x0070, 0x0081,
      `WL=${num(p.wl)} WW=${num(Math.max(1, p.ww))} dondurme=${String(p.rotation ?? 0)} yatayCevir=${p.flipH ? "Y" : "N"} dikeyCevir=${p.flipV ? "Y" : "N"} ters=${p.invert ? "Y" : "N"}` +
      (baseSopUid ? ` | guncellen: ${baseSopUid}` : "")),
  ];
  return wrap(SOP_PRESENTATION_STATE, sop, build(els));
}

/** Anahtar kesitler → DICOM Key Object Selection Document (TID 2010). */
export function buildKeyObjectSelection(k: KeyObjectInput): Uint8Array {
  const sop = newUid();
  const content: Uint8Array[][] = [];
  const notes = k.items.filter((i) => i.note && i.note.trim()).map((i, n) => `${n + 1}. ${i.note!.trim()}`).join("\n");
  if (notes) content.push(textItem(code("113012", "DCM", "Key Object Description"), notes));
  for (const it of k.items) {
    content.push(item(
      SQ(0x0008, 0x1199, [item(S(0x0008, 0x1150, "UI", k.sopClassUid), S(0x0008, 0x1155, "UI", it.sopUid))]),
      S(0x0040, 0xa010, "CS", "CONTAINS"), S(0x0040, 0xa040, "CS", "IMAGE"),
    ));
  }
  const els: E[] = [
    ...common(k, SOP_KEY_OBJECT, sop, "KO", k.title || "Anahtar kesitler", 901, 1),
    S(0x0040, 0xa040, "CS", "CONTAINER"),
    codeSeq(0x0040, 0xa043, "113000", "DCM", "Of Interest"),
    S(0x0040, 0xa050, "CS", "SEPARATE"),
    SQ(0x0040, 0xa504, [item(S(0x0008, 0x0105, "CS", "DCMR"), S(0x0040, 0xdb00, "CS", "2010"))]),
    SQ(0x0040, 0xa372, []),
    ...evidence(k.studyUid, { seriesUid: k.seriesUid, sopClassUid: k.sopClassUid, sopUids: k.items.map((i) => i.sopUid) }),
    S(0x0040, 0xa491, "CS", "COMPLETE"),
    S(0x0040, 0xa493, "CS", "UNVERIFIED"),
    SQ(0x0040, 0xa730, content),
  ];
  return wrap(SOP_KEY_OBJECT, sop, build(els));
}

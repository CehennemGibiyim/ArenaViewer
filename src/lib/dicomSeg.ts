/**
 * DICOM Segmentation (SEG, …66.4) ve RT Structure Set (RTSTRUCT, …481.5) yazımı
 * (c-seg-rtstruct).
 *
 * - SEG: segment başına 1 bit/piksel binary maske; tüm segmentler aynı kesit
 *   kümesini paylaşır (çerçeve sayısı = segment × kesit). Renk, segment etiketi
 *   ve algoritma türü (MANUAL/SEMIAUTOMATIC/AUTOMATIC) yazılır.
 * - RTSTRUCT: maske sınırlarından çıkarılan konturlar (CLOSED_PLANAR) + ROI
 *   gözlemleri. Kontur sınırı `maskContours` ile **kenar takibi** yapılarak
 *   çıkarılır: konkav bölgeler ve delikler korunur (eski satır taraması yalnız
 *   dış zarfı veriyordu; `maskContour` geriye dönük uyumluluk için duruyor).
 *
 * Her iki belge de Explicit VR Little Endian, UTF-8 (ISO_IR 192) yazılır.
 */
import { traceContours, type Pt } from "./segEditing";
import { concat, el, enc, newUid, pad, str, uidEl, us } from "./dicomWrite";
import type { SegMask, SegmentDef } from "./segmentation";

export const SOP_SEG = "1.2.840.10008.5.1.4.1.1.66.4";
export const SOP_RTSTRUCT = "1.2.840.10008.5.1.4.1.1.481.5";

export interface SegGeometry {
  pxMm: number;
  pyMm: number;
  /** Kesit kalınlığı/aralığı (mm) */
  dz: number;
  /** İlk kesitin ImagePositionPatient [x,y,z] */
  origin: [number, number, number];
}

export interface SegSource {
  seriesUid: string;
  sopClassUid: string;
  sopUids: string[];
}

export interface SegInput {
  patientName: string; patientId: string; patientSex: string;
  studyUid: string; studyDate: string; institution: string;
  source: SegSource;
  frameOfReferenceUid?: string;
  geometry: SegGeometry;
  width: number;
  height: number;
  segments: { def: SegmentDef; mask: SegMask }[];
}

export interface RtStructInput extends Omit<SegInput, "segments"> {
  rois: { def: SegmentDef; mask: SegMask }[];
  /** Kontur başına azami nokta (varsayılan 200) */
  maxPointsPerContour?: number;
}

// ── yazım yardımcıları ──
interface E { t: number; b: Uint8Array }
const tag = (g: number, e: number) => ((g << 16) | e) >>> 0;
const S = (g: number, e: number, vr: string, v: string): E => ({ t: tag(g, e), b: vr === "UI" ? uidEl(g, e, v) : str(g, e, vr, v) });
const US = (g: number, e: number, n: number): E => ({ t: tag(g, e), b: us(g, e, n) });
/** (0004,1500) gibi AT (attribute tag) VR'ı. */
const AT = (g: number, e: number, refs: [number, number][]): E => {
  const b = new Uint8Array(refs.length * 4);
  const dv = new DataView(b.buffer);
  refs.forEach(([rg, re], i) => { dv.setUint16(i * 4, rg, true); dv.setUint16(i * 4 + 2, re, true); });
  return { t: tag(g, e), b: el(g, e, "AT", pad(b, 0)) };
};
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
const build = (els: E[]): Uint8Array => concat(els.slice().sort((a, b) => a.t - b.t).map((x) => x.b));
const codeItem = (value: string, scheme: string, meaning: string): Uint8Array[] =>
  item(S(0x0008, 0x0100, "SH", value), S(0x0008, 0x0102, "SH", scheme), S(0x0008, 0x0104, "LO", meaning));

const pn = (n: string) => (n || "").trim().replace(/\s+/g, "^").slice(0, 60);
const digits = (s: string) => (s || "").replace(/\D/g, "");
const dicomDate = (s: string, fb = new Date()) => { const d = digits(s).slice(0, 8); return d.length === 8 ? d : fb.toISOString().slice(0, 10).replace(/-/g, ""); };
const nowTM = (d = new Date()) => d.toISOString().slice(11, 19).replace(/:/g, "");
const nowDA = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, "");

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

function patientStudy(p: SegInput | RtStructInput, modality: string, seriesDesc: string, seriesNo: number): E[] {
  const now = new Date();
  return [
    S(0x0008, 0x0005, "CS", "ISO_IR 192"),
    S(0x0008, 0x0020, "DA", dicomDate(p.studyDate, now)), S(0x0008, 0x0023, "DA", nowDA(now)),
    S(0x0008, 0x0030, "TM", "000000"), S(0x0008, 0x0033, "TM", nowTM(now)),
    S(0x0008, 0x0060, "CS", modality), S(0x0008, 0x0070, "LO", "AtikViewer"),
    S(0x0008, 0x0080, "LO", (p.institution || "").slice(0, 60)),
    S(0x0008, 0x103e, "LO", seriesDesc),
    S(0x0010, 0x0010, "PN", pn(p.patientName)), S(0x0010, 0x0020, "LO", (p.patientId || "").slice(0, 60)),
    S(0x0010, 0x0040, "CS", /^[MFO]$/.test(p.patientSex) ? p.patientSex : ""),
    S(0x0018, 0x1020, "LO", "AtikViewer"),
    S(0x0020, 0x000d, "UI", p.studyUid), S(0x0020, 0x000e, "UI", newUid()),
    S(0x0020, 0x0010, "SH", "1"), S(0x0020, 0x0011, "IS", String(seriesNo)), S(0x0020, 0x0013, "IS", "1"),
  ];
}

/** Binary maskeyi 1 bit/piksel çerçevelere paketler (bit sırası LSB önce). */
export function packBinaryFrames(frames: Uint8Array[], width: number, height: number): Uint8Array {
  const pixels = width * height;
  const bytesPerFrame = Math.ceil(pixels / 8);
  const out = new Uint8Array(bytesPerFrame * frames.length);
  frames.forEach((f, fi) => {
    const base = fi * bytesPerFrame;
    for (let p = 0; p < pixels; p++) if (f[p]) out[base + (p >> 3)] |= 1 << (p & 7);
  });
  return out;
}

/** Maskeyi oku (bit paketinden) — test/inceleme için. */
export function unpackBinaryFrame(buf: Uint8Array, frameIndex: number, width: number, height: number): Uint8Array {
  const pixels = width * height;
  const bytesPerFrame = Math.ceil(pixels / 8);
  const base = frameIndex * bytesPerFrame;
  const out = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) out[p] = (buf[base + (p >> 3)] >> (p & 7)) & 1;
  return out;
}

/** Segmentasyon → DICOM SEG. */
export function buildSegDocument(input: SegInput): Uint8Array {
  const sop = newUid();
  const forUid = input.frameOfReferenceUid || newUid();
  const frames = input.source.sopUids.length;

  const packed: Uint8Array[] = [];
  for (const seg of input.segments) {
    for (let f = 0; f < frames; f++) packed.push(seg.mask.slices.get(f) ?? new Uint8Array(input.width * input.height));
  }
  const pixelData = packBinaryFrames(packed, input.width, input.height);

  const segSequence = input.segments.map((s) => item(
    US(0x0062, 0x0004, s.def.segmentNumber),
    S(0x0062, 0x0005, "LO", s.def.label.slice(0, 64)),
    S(0x0062, 0x0006, "ST", `Renk: ${s.def.color.join(",")}`),
    S(0x0062, 0x0008, "CS", s.def.algorithmType),
    S(0x0062, 0x0009, "LO", (s.def.algorithmName || "AtikViewer").slice(0, 64)),
    SQ(0x0062, 0x000d, [codeItem("85756007", "SCT", "Tissue")]),
  ));

  // Çerçeve başına konum (segment sırayla, her segment tüm kesitler)
  const frameItems: Uint8Array[][] = [];
  for (let s = 0; s < input.segments.length; s++) {
    for (let f = 0; f < frames; f++) {
      const z = input.geometry.origin[2] + f * input.geometry.dz;
      frameItems.push(item(
        SQ(0x0020, 0x9111, [item(US(0x0020, 0x9057, s + 1), US(0x0020, 0x9056, f + 1))]),
        SQ(0x0020, 0x9113, [item(
          S(0x0020, 0x0032, "DS", [input.geometry.origin[0].toFixed(2), input.geometry.origin[1].toFixed(2), z.toFixed(3)].join("\\")),
          S(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
        )]),
      ));
    }
  }

  const els: E[] = [
    ...patientStudy(input, "SEG", "Segmentasyon", 960),
    S(0x0008, 0x0016, "UI", SOP_SEG), S(0x0008, 0x0018, "UI", sop),
    S(0x0020, 0x0052, "UI", forUid),
    // Kaynak seri referansı
    SQ(0x0008, 0x1115, [item(
      S(0x0020, 0x000e, "UI", input.source.seriesUid),
      SQ(0x0008, 0x1140, input.source.sopUids.map((u) => item(S(0x0008, 0x1150, "UI", input.source.sopClassUid), S(0x0008, 0x1155, "UI", u)))),
    )]),
    SQ(0x0062, 0x0002, segSequence),
    // Ortak geometri / piksel tanımı
    US(0x0028, 0x0002, 1),
    S(0x0028, 0x0004, "CS", "MONOCHROME2"),
    US(0x0028, 0x0010, input.height),
    US(0x0028, 0x0011, input.width),
    US(0x0028, 0x0008, packed.length),
    AT(0x0028, 0x0009, [[0x0020, 0x9111]]),
    S(0x0028, 0x0030, "DS", `${input.geometry.pxMm.toFixed(4)}\\${input.geometry.pyMm.toFixed(4)}`),
    US(0x0028, 0x0100, 1),
    US(0x0028, 0x0101, 1),
    US(0x0028, 0x0102, 7),
    US(0x0028, 0x0103, 0),
    SQ(0x5200, 0x9230, frameItems),
  ];
  // PixelData ayrı: OB, uzun VR
  const body = concat([build(els), el(0x7fe0, 0x0010, "OB", pad(pixelData, 0))]);
  return wrap(SOP_SEG, sop, body);
}

// ─────────────── RTSTRUCT ───────────────

/**
 * Maskeden kapalı kontur çıkarır (satır taraması).
 * Her satırın en sol ve en sağ dolu pikseli alınır; üst kenar soldan sağa,
 * alt kenar sağdan sola eklenir. Konkav segmentlerde dış zarfa yaklaşır.
 */
export function maskContour(mask: Uint8Array, width: number, height: number): { x: number; y: number }[] {
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let y = 0; y < height; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) { if (l < 0) l = x; r = x; }
    }
    if (l >= 0) { left.push({ x: l, y }); right.push({ x: r, y }); }
  }
  if (!left.length) return [];
  return [...left, ...right.reverse()];
}

/** Kontur noktalarını piksel → hasta koordinatına (mm) çevirir ve seyreltir. */
export function contourPoints(pts: { x: number; y: number }[], g: SegGeometry, slice: number, maxPoints = 200): number[] {
  const z = g.origin[2] + slice * g.dz;
  const stride = Math.max(1, Math.ceil(pts.length / Math.max(8, maxPoints)));
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += stride) {
    out.push(
      Number((g.origin[0] + (pts[i].x + 0.5) * g.pxMm).toFixed(3)),
      Number((g.origin[1] + (pts[i].y + 0.5) * g.pyMm).toFixed(3)),
      Number(z.toFixed(3)),
    );
  }
  return out;
}

/**
 * Maskeden DICOM kontur halkaları (c-seg-rtstruct): gerçek sınır izleme.
 *
 * `maskContour` satır taramasıdır ve konkav bölgelerde dış zarfa yaklaşır.
 * RTSTRUCT yazımı bu fonksiyonu kullanır: her kapalı halka (varsa delikler
 * dahil) ayrı CLOSED_PLANAR kontur olarak yazılır.
 */
export function maskContours(mask: Uint8Array, width: number, height: number): { pts: Pt[]; hole: boolean }[] {
  // Sadeleştirme eşiği çok küçük: amaç yalnız **tam doğrusal** noktaları atmak.
  // Daha büyük eşik konkav köşeleri keser ve kontur alanını düşürür (ölçüldü).
  const traced = traceContours({ width, height, data: mask }, 0.01);
  // Delik halkaları da yazılır: RTSTRUCT'ta iç içe kontur kuralı (delik saat
  // yönünde) korunur; tek halka kalırsa delik işareti düşer.
  const onlyOne = traced.length === 1;
  return traced.map((t) => ({ pts: t.ring, hole: onlyOne ? false : t.hole }));
}

/** Halka noktalarını hasta koordinatına (mm) çevirir ve seyreltir. */
export function ringPoints(ring: Pt[], g: SegGeometry, slice: number, maxPoints = 200): number[] {
  return contourPoints(ring, g, slice, maxPoints);
}

/** Segmentasyon → DICOM RT Structure Set. */
export function buildRtStruct(input: RtStructInput): Uint8Array {
  const sop = newUid();
  const forUid = input.frameOfReferenceUid || newUid();
  const maxPts = input.maxPointsPerContour ?? 200;

  const roiSeq: Uint8Array[][] = [];
  const roiContourSeq: Uint8Array[][] = [];
  const observationSeq: Uint8Array[][] = [];

  for (const roi of input.rois) {
    const n = roi.def.segmentNumber;
    roiSeq.push(item(
      S(0x3006, 0x0022, "IS", String(n)),
      S(0x3006, 0x0026, "LO", roi.def.label.slice(0, 64)),
      S(0x3006, 0x0028, "IS", String(n)),
      S(0x3006, 0x002a, "IS", "1"),
      S(0x3006, 0x0036, "IS", "1"),
      S(0x3006, 0x0038, "LO", "Segmentasyon"),
      S(0x3006, 0x0039, "CS", "CLOSED_PLANAR"),
      S(0x3006, 0x002c, "DS", "1"),
    ));
    observationSeq.push(item(
      S(0x3006, 0x0082, "IS", String(n)),
      S(0x3006, 0x0085, "CS", "ORGAN"),
      S(0x3006, 0x0088, "ST", `AtikViewer segment: ${roi.def.label}`),
    ));

    const contours: Uint8Array[][] = [];
    for (const slice of [...roi.mask.slices.keys()].sort((a, b) => a - b)) {
      const m = roi.mask.slices.get(slice)!;
      if (!m.some((v) => v)) continue;
      // Gerçek sınır izleme (delikler korunur); tek halka/kontur her zaman yazılır.
      for (const c of maskContours(m, input.width, input.height)) {
        if (c.pts.length < 3) continue;
        const pts = c.hole ? [...c.pts].reverse() : c.pts;
        const data = ringPoints(pts, input.geometry, slice, maxPts);
        if (data.length < 9) continue;
        contours.push(item(
          S(0x3006, 0x0042, "CS", "CLOSED_PLANAR"),
          S(0x3006, 0x0046, "IS", String(data.length / 3)),
          S(0x3006, 0x0050, "DS", data.join("\\")),
          S(0x3006, 0x0040, "IS", String(slice + 1)),
        ));
      }
    }
    roiContourSeq.push(item(
      S(0x3006, 0x0084, "IS", String(n)),
      SQ(0x3006, 0x0040, contours),
    ));
  }

  const els: E[] = [
    ...patientStudy(input, "RTSTRUCT", "Yapı seti", 970),
    S(0x0008, 0x0016, "UI", SOP_RTSTRUCT), S(0x0008, 0x0018, "UI", sop),
    S(0x3006, 0x0002, "SH", "1"),
    SQ(0x3006, 0x0010, [item(
      S(0x0020, 0x0052, "UI", forUid),
      SQ(0x3006, 0x0012, [item(
        S(0x0020, 0x000e, "UI", input.source.seriesUid),
        SQ(0x3006, 0x0014, input.source.sopUids.slice(0, 512).map((u) => item(S(0x0008, 0x1150, "UI", input.source.sopClassUid), S(0x0008, 0x1155, "UI", u)))),
      )]),
    )]),
    SQ(0x3006, 0x0020, roiSeq),
    SQ(0x3006, 0x0039, roiContourSeq),
    SQ(0x3006, 0x0080, observationSeq),
  ];
  return wrap(SOP_RTSTRUCT, sop, build(els));
}

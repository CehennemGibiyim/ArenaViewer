/**
 * DICOM Segmentation (SEG, …66.4) ve RT Structure Set (RTSTRUCT, …481.5) yazımı
 * (c-seg-rtstruct).
 *
 * - SEG: segment başına 1 bit/piksel binary maske; tüm segmentler aynı kesit
 *   kümesini paylaşır (çerçeve sayısı = segment × kesit). Renk, segment etiketi
 *   ve algoritma türü (MANUAL/SEMIAUTOMATIC/AUTOMATIC) yazılır.
 * - RTSTRUCT: maske sınırlarından Moore komşuluk izlemesiyle çıkarılan
 *   konturlar (CLOSED_PLANAR, bileşen başına bir kontur) + ROI gözlemleri;
 *   noktalar Douglas–Peucker (contourSimplify.ts) ile mm cinsinden sadeleştirilir.
 *
 * Her iki belge de Explicit VR Little Endian, UTF-8 (ISO_IR 192) yazılır.
 */
import { concat, el, enc, newUid, pad, str, uidEl, us } from "./dicomWrite";
import type { SegMask, SegmentDef } from "./segmentation";
import { simplifyClosedContour } from "./contourSimplify";

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
  /** Douglas–Peucker toleransı (mm, varsayılan 0,5); 0 sadeleştirmeyi kapatır */
  contourToleranceMm?: number;
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
/**
 * Moore komşuluk izleme (8 komşu, saat yönü, batıdan başlar): tek bir bağlı
 * bileşenin sınır piksellerini **sıralı** döndürür. Kenar izleme, satır taraması
 * gibi içbükeylikleri kesmez.
 */
const MOORE: [number, number][] = [
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
];

function traceBoundary(
  sx: number, sy: number, width: number, height: number,
  inside: (x: number, y: number) => boolean,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  let cx = sx, cy = sy;
  // Geri izleme (backtrack) hücresi: başlangıçta batı komşusu.
  let bx = sx - 1, by = sy;
  const dirIndex = (dx: number, dy: number) => {
    const i = MOORE.findIndex(([mx, my]) => mx === dx && my === dy);
    return i < 0 ? 0 : i;
  };
  const seenStates = new Set<number>();
  const guard = 8 * width * height + 16;
  for (let step = 0; step < guard; step++) {
    const backDir = dirIndex(bx - cx, by - cy);
    const state = (cy * width + cx) * 8 + backDir;
    if (seenStates.has(state)) break; // Jacob'ın durma kuralı: durum tekrarı
    seenStates.add(state);
    pts.push({ x: cx, y: cy });
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (backDir + k) % 8;
      const nx = cx + MOORE[d][0], ny = cy + MOORE[d][1];
      if (!inside(nx, ny)) continue;
      bx = cx; by = cy; // eski piksel yeni backtrack
      cx = nx; cy = ny;
      moved = true;
      break;
    }
    if (!moved) break; // izole piksel
    if (cx === sx && cy === sy) break; // başlangıca döndük
  }
  // Ardışık tekrarları at
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}

const polyArea = (pts: readonly { x: number; y: number }[]): number => {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/**
 * Maskedeki **tüm bağlı bileşenlerin** sınır konturları (büyükten küçüğe).
 *
 * Delikler (iç boşluk) ayrı kontur olarak döndürülmez; DICOM RTSTRUCT'ta delik
 * XOR ile değil, ayrı ROI/kontur ile temsil edilir. Bu nedenle içi boş halkalarda
 * yalnız dış sınır çıkar.
 */
export function traceContours(mask: Uint8Array, width: number, height: number): { x: number; y: number }[][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;
  const seen = new Uint8Array(width * height);
  const out: { x: number; y: number }[][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (seen[idx] || !inside(x, y)) continue;
      // 4-komşu taşkın doldurma: bileşenin en üst-sol pikselini bul
      const stack = [idx];
      seen[idx] = 1;
      let startX = x, startY = y;
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % width, py = (p - px) / width;
        if (py < startY || (py === startY && px < startX)) { startX = px; startY = py; }
        const nb: [number, number][] = [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]];
        for (const [nx, ny] of nb) {
          if (!inside(nx, ny)) continue;
          const ni = ny * width + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      const poly = traceBoundary(startX, startY, width, height, inside);
      if (poly.length > 0) out.push(poly);
    }
  }
  return out.sort((a, b) => polyArea(b) - polyArea(a));
}

/** Geriye dönük uyumluluk: en büyük bileşenin sınır konturu. */
export function maskContour(mask: Uint8Array, width: number, height: number): { x: number; y: number }[] {
  const polys = traceContours(mask, width, height);
  return polys[0] ?? [];
}

/**
 * Bir kesitteki tüm konturların hasta koordinatları (mm) — bileşen başına bir
 * CLOSED_PLANAR kontur. RTSTRUCT üretimi ve testler bu yardımcıyı paylaşır.
 */
export function sliceContourPoints(
  mask: Uint8Array, width: number, height: number, geometry: SegGeometry, slice: number, maxPoints = 200, toleranceMm = 0.5,
): number[][] {
  return traceContours(mask, width, height)
    .filter((p) => p.length >= 3)
    .map((p) => contourPoints(p, geometry, slice, maxPoints, toleranceMm));
}

/**
 * Kontur noktalarını piksel → hasta koordinatına (mm) çevirir.
 * Önce Douglas–Peucker (varsayılan ε = 0,5 mm) ile düz kenar/staircase
 * noktaları elenir; ε ≤ 0 sadeleştirmeyi kapatır. Sadeleştirme sonrası
 * hâlâ maxPoints aşılırsa tek tip seyreltme emniyet supabı devreye girer.
 */
export function contourPoints(pts: { x: number; y: number }[], g: SegGeometry, slice: number, maxPoints = 200, toleranceMm = 0.5): number[] {
  const z = g.origin[2] + slice * g.dz;
  const mm = pts.map((p) => ({ x: g.origin[0] + (p.x + 0.5) * g.pxMm, y: g.origin[1] + (p.y + 0.5) * g.pyMm }));
  let simple = simplifyClosedContour(mm, toleranceMm);
  if (simple.length > maxPoints) {
    const stride = Math.max(1, Math.ceil(simple.length / maxPoints));
    simple = simple.filter((_, i) => i % stride === 0);
  }
  const out: number[] = [];
  for (const p of simple) {
    out.push(
      Number(p.x.toFixed(3)),
      Number(p.y.toFixed(3)),
      Number(z.toFixed(3)),
    );
  }
  return out;
}

/** Segmentasyon → DICOM RT Structure Set. */
export function buildRtStruct(input: RtStructInput): Uint8Array {
  const sop = newUid();
  const forUid = input.frameOfReferenceUid || newUid();
  const maxPts = input.maxPointsPerContour ?? 200;
  const tol = input.contourToleranceMm ?? 0.5;

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
      // Birden fazla bağlı bileşen varsa her biri ayrı kontur olarak yazılır.
      for (const data of sliceContourPoints(m, input.width, input.height, input.geometry, slice, maxPts, tol)) {
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

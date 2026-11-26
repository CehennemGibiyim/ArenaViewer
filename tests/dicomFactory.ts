/**
 * E2E testleri için paylaşılan minimal DICOM üreteci.
 *
 * pacs.orthanc.e2e.ts ve pacs-lazy.e2e.ts aynı üreteci kullanır; davranış
 * değişikliği sessiz sapmaya yol açmasın diye bu dosya TEK kaynak.
 *
 * `minimalDicom(meta)` (opts'suz) geçmiş sürümle BAYTİBAYT aynı dosyayı üretir.
 */

export interface MinimalMeta {
  patientId: string;
  patientName: string;
  studyUid: string;
  seriesUid: string;
  sopUid: string;
}

export interface MinimalOptions {
  /** InstanceNumber (0020,0013) — varsayılan 1 (eski davranış) */
  instanceNumber?: number;
  /** ImagePositionPatient[2] (z, mm) — verilirse 0020,0032 "0\\0\\z" olarak yazılır */
  sliceLocation?: number;
  /** Slice Thickness (0018,0050) — verilirse yazılır */
  sliceThickness?: number;
  /** Pixel Spacing (0028,0030) — verilirse "p\\p" yazılır */
  pixelSpacing?: number;
  /** Piksel örneklerinin başlangıç değeri: değer = seed + i (4×4 uint16). Varsayılan 16 (eski davranış) */
  pixelSeed?: number;
}

export function element(group: number, elem: number, vr: string, value: Uint8Array): Uint8Array {
  const long = ["OB", "OW", "OF", "SQ", "UC", "UR", "UT", "UN"].includes(vr);
  const paddedLength = value.length + (value.length % 2);
  const head = long ? 12 : 8;
  const out = new Uint8Array(head + paddedLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out.set(vr.split("").map((c) => c.charCodeAt(0)), 4);
  if (long) { dv.setUint32(8, paddedLength, true); } else { dv.setUint16(6, paddedLength, true); }
  out.set(value, head);
  if (paddedLength !== value.length && vr !== "UI" && vr !== "OB" && vr !== "OW") out[out.length - 1] = 0x20;
  return out;
}

export const strVal = (s: string) => new TextEncoder().encode(s);
export const uiVal = (s: string) => new TextEncoder().encode(s);
export const makeUid = (root: string, n: number) => `${root}.${n}`;

export function minimalDicom(meta: MinimalMeta, opts: MinimalOptions = {}): Uint8Array {
  const sopClass = "1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture Image Storage
  const parts: Uint8Array[] = [];

  // Preamble + DICM
  parts.push(new Uint8Array(128), strVal("DICM"));

  // Dosya meta grubu (0002)
  const metaElems: Uint8Array[] = [
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0002, "UI", uiVal(sopClass)),
    element(0x0002, 0x0003, "UI", uiVal(meta.sopUid)),
    element(0x0002, 0x0010, "UI", uiVal("1.2.840.10008.1.2.1")),
    element(0x0002, 0x0012, "UI", uiVal("1.2.3.4.5.6.7.8.9")),
    element(0x0002, 0x0013, "SH", strVal("ARENA-E2E")),
  ];
  const metaLen = metaElems.reduce((n, e) => n + e.length, 0);
  parts.push(element(0x0002, 0x0000, "UL", new Uint8Array(4)));
  // grup uzunluğu elemanını doğru değerle yeniden yaz
  {
    const dv = new DataView(parts[parts.length - 1].buffer);
    dv.setUint32(8, metaLen, true);
  }
  parts.push(...metaElems);

  // Veri kümesi
  const px = new Uint8Array(32);
  const dvpx = new DataView(px.buffer);
  const seed = opts.pixelSeed ?? 16;
  for (let i = 0; i < px.length / 2; i++) dvpx.setUint16(i * 2, seed + i, true);
  parts.push(
    element(0x0008, 0x0016, "UI", uiVal(sopClass)),
    element(0x0008, 0x0018, "UI", uiVal(meta.sopUid)),
    element(0x0008, 0x0020, "DA", strVal("20260101")),
    element(0x0008, 0x0030, "TM", strVal("120000")),
    element(0x0008, 0x0060, "CS", strVal("OT")),
    element(0x0010, 0x0010, "PN", strVal(meta.patientName)),
    element(0x0010, 0x0020, "LO", strVal(meta.patientId)),
    element(0x0020, 0x000d, "UI", uiVal(meta.studyUid)),
    element(0x0020, 0x000e, "UI", uiVal(meta.seriesUid)),
    element(0x0020, 0x0011, "IS", strVal("1")),
    element(0x0020, 0x0013, "IS", strVal(String(opts.instanceNumber ?? 1))),
    element(0x0028, 0x0002, "US", new Uint8Array([1, 0])),
    element(0x0028, 0x0004, "CS", strVal("MONOCHROME2")),
    element(0x0028, 0x0010, "US", new Uint8Array([4, 0])),
    element(0x0028, 0x0011, "US", new Uint8Array([4, 0])),
    element(0x0028, 0x0100, "US", new Uint8Array([16, 0])),
    element(0x0028, 0x0101, "US", new Uint8Array([16, 0])),
    element(0x0028, 0x0102, "US", new Uint8Array([15, 0])),
    element(0x0028, 0x0103, "US", new Uint8Array([0, 0])),
  );
  // İsteğe bağlı künye elemanları (iskelet tahsisi / sıralama için) — Pixel Data'dan ÖNCE
  if (opts.sliceLocation !== undefined) {
    parts.push(element(0x0020, 0x0032, "DS", strVal(`0\\0\\${opts.sliceLocation}`)));
  }
  if (opts.sliceThickness !== undefined) {
    parts.push(element(0x0018, 0x0050, "DS", strVal(String(opts.sliceThickness))));
  }
  if (opts.pixelSpacing !== undefined) {
    parts.push(element(0x0028, 0x0030, "DS", strVal(`${opts.pixelSpacing}\\${opts.pixelSpacing}`)));
  }
  parts.push(element(0x7fe0, 0x0010, "OW", px));

  const total = parts.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** WADO ile geri alınan DICOM baytlarından 16-bit örnekleri okur (Explicit VR LE, tek örnek). */
export function decodeUint16Samples(dcm: Uint8Array): Uint16Array {
  const idx = findElementOffset(dcm, 0x7fe0, 0x0010);
  if (!idx) return new Uint16Array(0);
  const out = new Uint16Array(idx.valueLength / 2);
  const dv = new DataView(dcm.buffer, dcm.byteOffset + idx.valueOffset, idx.valueLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
  return out;
}

/** Explicit VR Little Endian bayt dizisinde eleman ofsetini bulur (test amaçlı, yalın ayrıştırıcı). */
function findElementOffset(
  dcm: Uint8Array,
  group: number,
  elem: number,
): { valueOffset: number; valueLength: number } | null {
  let pos = 132; // preamble + "DICM"
  const dv = new DataView(dcm.buffer, dcm.byteOffset, dcm.byteLength);
  const longVRs = new Set(["OB", "OW", "OF", "OD", "SQ", "UC", "UR", "UT", "UN"]);
  while (pos + 8 <= dcm.length) {
    const g = dv.getUint16(pos, true);
    const e = dv.getUint16(pos + 2, true);
    const vr = String.fromCharCode(dcm[pos + 4], dcm[pos + 5]);
    let headerLen: number;
    let valueLength: number;
    if (longVRs.has(vr)) {
      valueLength = dv.getUint32(pos + 8, true);
      headerLen = 12;
    } else {
      valueLength = dv.getUint16(pos + 6, true);
      headerLen = 8;
    }
    const valueOffset = pos + headerLen;
    if (g === group && e === elem) return { valueOffset, valueLength };
    if (valueLength === 0xffffffff) return null; // belirsiz uzunluk — bu testte kullanılmaz
    pos = valueOffset + valueLength + (valueLength % 2);
  }
  return null;
}

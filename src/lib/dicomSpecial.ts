import type { DicomDataSet, DicomElement } from "dicom-parser";
import type {
  DicomECGWaveform,
  DicomGSPS,
  DicomOverlayPlane,
  DicomSRDocument,
  ECGChannel,
  EncapsulatedPDFDocument,
  GSPSGraphicObject,
  GSPSTextObject,
  PaletteColorLUT,
  SRNode,
} from "./types";

export function isSOPClass(sop: string | undefined, prefixOrUid: string): boolean {
  if (!sop) return false;
  return sop === prefixOrUid || sop.startsWith(prefixOrUid);
}

// ───────────── 1. Encapsulated PDF Parser ─────────────

export const SOP_ENCAPSULATED_PDF = "1.2.840.10008.5.1.4.1.1.104.1";

export function parseEncapsulatedPDF(ds: DicomDataSet): EncapsulatedPDFDocument | null {
  const el: DicomElement | undefined = ds.elements["x00420011"];
  if (!el || el.length === 0) return null;

  const buf = ds.byteArray.buffer as ArrayBuffer;
  const offset = ds.byteArray.byteOffset + el.dataOffset;
  const pdfBytes = new Uint8Array(buf, offset, el.length);

  // Convert bytes to base64 data URL
  let binary = "";
  const len = pdfBytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  const base64 = typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(pdfBytes).toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;

  const title = ds.string("x0008103e") || ds.string("x00081030") || ds.string("x00420010") || "DICOM PDF Raporu";

  return {
    id: `pdf-${Date.now()}`,
    title,
    sopInstanceUid: ds.string("x00080018") || `pdf-${Date.now()}`,
    dataUrl,
    sizeBytes: el.length,
  };
}

// ───────────── 2. DICOM Structured Reporting (SR) Parser ─────────────

export const SOP_PREFIX_SR = "1.2.840.10008.5.1.4.1.1.88.";

function parseCode(itemDs: DicomDataSet, tag: string) {
  const codeSeq = itemDs.elements[tag];
  if (!codeSeq?.items?.[0]?.dataSet) return undefined;
  const cds = codeSeq.items[0].dataSet;
  return {
    code: cds.string("x00080100") || "",
    scheme: cds.string("x00080102") || "",
    meaning: cds.string("x00080104") || "",
  };
}

function parseSRItem(itemDs: DicomDataSet, index: number): SRNode {
  const valueType = (itemDs.string("x0040a040") || "TEXT").toUpperCase() as SRNode["valueType"];
  const relationship = itemDs.string("x0040a010") || undefined;
  const conceptName = parseCode(itemDs, "x0040a043");
  const textValue = itemDs.string("x0040a160");
  const codeValue = parseCode(itemDs, "x0040a168");

  let numValue: SRNode["numValue"] = undefined;
  const numSeq = itemDs.elements["x0040a300"];
  if (numSeq?.items?.[0]?.dataSet) {
    const nds = numSeq.items[0].dataSet;
    const num = nds.floatString("x0040a30a");
    const unit = parseCode(nds, "x004008ea")?.meaning || "";
    if (num !== undefined) numValue = { value: num, unit };
  }

  // Children: Content Sequence (0040,a730)
  const children: SRNode[] = [];
  const contentSeq = itemDs.elements["x0040a730"];
  if (contentSeq?.items) {
    contentSeq.items.forEach((childItem, i) => {
      if (childItem.dataSet) children.push(parseSRItem(childItem.dataSet, i));
    });
  }

  return {
    id: `sr-node-${index}-${Math.random().toString(36).slice(2, 7)}`,
    relationship,
    valueType,
    conceptName,
    textValue,
    codeValue,
    numValue,
    children: children.length > 0 ? children : undefined,
  };
}

export function parseStructuredReport(ds: DicomDataSet): DicomSRDocument | null {
  const rootNode = parseSRItem(ds, 0);
  const title =
    rootNode.conceptName?.meaning ||
    ds.string("x0008103e") ||
    ds.string("x00081030") ||
    "DICOM Yapısal Rapor (SR)";

  return {
    id: `sr-${Date.now()}`,
    title,
    sopInstanceUid: ds.string("x00080018") || `sr-${Date.now()}`,
    templateId: ds.string("x0040db00") || undefined,
    completionFlag: ds.string("x0040a491") || undefined,
    verificationFlag: ds.string("x0040a493") || undefined,
    root: rootNode,
  };
}

// ───────────── 3. 12-Lead ECG / Waveform Parser ─────────────

export const SOP_PREFIX_ECG = "1.2.840.10008.5.1.4.1.1.9.";

const STANDARD_12_LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];

export function parseECGWaveform(ds: DicomDataSet): DicomECGWaveform | null {
  const waveformSeq = ds.elements["x54000100"];
  if (!waveformSeq?.items?.[0]?.dataSet) return null;

  const wds = waveformSeq.items[0].dataSet;
  const numChannels = wds.uint16("x003a0005") || 12;
  const numSamples = wds.uint32("x003a0010") || 1000;
  const samplingFreq = wds.floatString("x003a001a") || 500;
  const bitsAllocated = wds.uint16("x54001004") || 16;

  const waveDataEl = wds.elements["x54001010"];
  if (!waveDataEl) return null;

  const buf = wds.byteArray.buffer as ArrayBuffer;
  const offset = wds.byteArray.byteOffset + waveDataEl.dataOffset;
  const bytes = new Int16Array(buf, offset, numChannels * numSamples);

  // Parse Channel Definitions
  const channelSeq = wds.elements["x003a0200"];
  const channels: ECGChannel[] = [];

  for (let c = 0; c < numChannels; c++) {
    let leadName = STANDARD_12_LEADS[c] || `Lead ${c + 1}`;
    let sensitivity = 0.005; // standard mV per unit

    if (channelSeq?.items?.[c]?.dataSet) {
      const cds = channelSeq.items[c].dataSet;
      const srcCode = parseCode(cds, "x003a0208");
      if (srcCode?.meaning) leadName = srcCode.meaning.replace(/Lead\s*/i, "");
      const sens = cds.floatString("x003a0210");
      if (sens) sensitivity = sens;
    }

    const samples = new Float32Array(numSamples);
    for (let s = 0; s < numSamples; s++) {
      // Waveform samples are interleaved: s0_c0, s0_c1, ..., s1_c0, ...
      const val = bytes[s * numChannels + c] || 0;
      samples[s] = val * sensitivity; // in mV
    }

    channels.push({
      leadName,
      samples,
      samplingFrequency: samplingFreq,
      sensitivity: 10, // display 10mm / mV
    });
  }

  const durationSec = numSamples / samplingFreq;
  const title = ds.string("x0008103e") || ds.string("x00081030") || "12-Derivasyonlu Diyagnostik EKG";

  return {
    id: `ecg-${Date.now()}`,
    title,
    samplingFrequency: samplingFreq,
    durationSec,
    channels,
  };
}

// ───────────── 4. DICOM Overlay Planes Parser (60xx,3000) ─────────────

export function parseOverlayPlanes(ds: DicomDataSet): DicomOverlayPlane[] {
  const overlays: DicomOverlayPlane[] = [];

  // DICOM allows up to 16 overlay groups from 0x6000 to 0x601E in steps of 2
  for (let group = 0x6000; group <= 0x601e; group += 2) {
    const gHex = group.toString(16).padStart(4, "0");
    const dataTag = `x${gHex}3000`;
    const rowsTag = `x${gHex}0010`;
    const colsTag = `x${gHex}0011`;
    const typeTag = `x${gHex}0040`;
    const originTag = `x${gHex}0050`;
    const labelTag = `x${gHex}1500`;

    const dataEl = ds.elements[dataTag];
    const rows = ds.uint16(rowsTag);
    const cols = ds.uint16(colsTag);

    if (!dataEl || !rows || !cols) continue;

    const type = ((ds.string(typeTag) || "G").toUpperCase() as "G" | "R") || "G";
    const label = ds.string(labelTag) || `Katman 0x${gHex.toUpperCase()} (${type === "G" ? "Grafik" : "ROI"})`;

    const originStr = ds.string(originTag) || "1\\1";
    const [ox, oy] = originStr.split("\\").map(Number);

    const buf = ds.byteArray.buffer as ArrayBuffer;
    const offset = ds.byteArray.byteOffset + dataEl.dataOffset;
    const rawBytes = new Uint8Array(buf, offset, dataEl.length);

    // Unpack 1-bit per pixel into Uint8Array (1 byte per pixel: 1 or 0)
    const totalPixels = rows * cols;
    const unpacked = new Uint8Array(totalPixels);

    for (let p = 0; p < totalPixels; p++) {
      const byteIndex = Math.floor(p / 8);
      const bitIndex = p % 8;
      if (byteIndex < rawBytes.length) {
        const bit = (rawBytes[byteIndex] >> bitIndex) & 1;
        unpacked[p] = bit;
      }
    }

    overlays.push({
      group,
      rows,
      cols,
      originX: ox || 1,
      originY: oy || 1,
      data: unpacked,
      type,
      label,
      visible: true,
    });
  }

  return overlays;
}

// ───────────── 5. Grayscale Softcopy Presentation State (GSPS) ─────────────

export const SOP_GSPS = "1.2.840.10008.5.1.4.1.1.11.1";

/** FL (float) dizisini ikili okur: Graphic Data (0070,0022) metin VR değildir. */
function readFloatArray(ds: DicomDataSet, tag: string): number[] {
  const el = ds.elements[tag];
  if (!el || el.length < 4) return [];
  const n = Math.floor(el.length / 4);
  const dv = new DataView(ds.byteArray.buffer as ArrayBuffer, ds.byteArray.byteOffset + el.dataOffset, n * 4);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = dv.getFloat32(i * 4, true);
    if (Number.isFinite(v)) out.push(Math.round(v * 100) / 100);
  }
  return out;
}

export function parsePresentationState(ds: DicomDataSet): DicomGSPS | null {
  const graphicSeq = ds.elements["x00700001"];
  const graphics: GSPSGraphicObject[] = [];
  const texts: GSPSTextObject[] = [];
  // Her grafik/metin nesnesinin bağlı olduğu görüntü (0008,1140 → 0008,1155).
  const refs: (string | undefined)[] = [];
  // Graphic Layer kimliği (0070,0002) → anotasyon türü eşlemesi. Yalnız kendi
  // yazdığımız PR belgelerinde bulunur; dış belgelerde tür geometriden çıkarılır.
  const layers: string[] = [];

  if (graphicSeq?.items) {
    for (const item of graphicSeq.items) {
      if (!item.dataSet) continue;
      const itemDs = item.dataSet;

      // Bu grafik katmanı öğesinin referans görüntüsü (varsa).
      const imgSeq = itemDs.elements["x00081140"];
      const refUid = imgSeq?.items?.[0]?.dataSet?.string("x00081155")?.trim() || undefined;
      const layer = (itemDs.string("x00700002") || "").trim().toUpperCase();

      // Text Objects (0070,0008)
      const textSeq = itemDs.elements["x00700008"];
      if (textSeq?.items) {
        for (const tItem of textSeq.items) {
          if (!tItem.dataSet) continue;
          const text = tItem.dataSet.string("x00700006") || "";
          // Anchor Point (0070,0014) FL çifti: metnin görüntüdeki bağlantı noktası.
          const anchor = readFloatArray(tItem.dataSet, "x00700014");
          if (text) {
            texts.push({
              text,
              ...(anchor.length >= 2 ? { anchorPoint: { x: anchor[0], y: anchor[1] } } : {}),
              ...(refUid ? { referenceSopUid: refUid } : {}),
            });
          }
        }
      }

      // Graphic Objects (0070,0009)
      const grSeq = itemDs.elements["x00700009"];
      if (grSeq?.items) {
        for (const gItem of grSeq.items) {
          if (!gItem.dataSet) continue;
          const gType = (gItem.dataSet.string("x00700023") || "POLYLINE").toUpperCase() as GSPSGraphicObject["type"];
          // Graphic Data (0070,0022) FL'dir: ikili okunur (metin olarak okumak bozuk değer verir).
          const data = readFloatArray(gItem.dataSet, "x00700022");
          if (data.length === 0) continue;
          graphics.push({ type: gType, data });
          refs.push(refUid);
          layers.push(layer);
        }
      }
    }
  }

  const label = ds.string("x00700080") || "GSPS Anotasyonları";
  const description = ds.string("x00700081") || "";
  const presentationLutShape = (ds.string("x20500020") || "IDENTITY").toUpperCase() as DicomGSPS["presentationLutShape"];

  // Displayed Area (0070,005A): TLHC \\ BRHC, piksel koordinatı.
  const areaRaw = ds.string("x0070005a") || "";
  const areaNums = areaRaw.split("\\").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
  const displayedArea = areaNums.length >= 4
    ? { tl: { x: areaNums[0], y: areaNums[1] }, br: { x: areaNums[2], y: areaNums[3] } }
    : undefined;

  const presentedSeriesUid = ds.elements["x00081115"]?.items?.[0]?.dataSet?.string("x0020000e")?.trim() || undefined;

  return {
    id: `gsps-${Date.now()}`,
    label,
    description,
    graphics,
    texts,
    ...(displayedArea ? { displayedArea } : {}),
    ...(presentedSeriesUid ? { presentedSeriesUid } : {}),
    referenceSopUids: refs,
    ...(layers.some(Boolean) ? { layers } : {}),
    presentationLutShape,
  };
}

// ───────────── 6. Palette Color Lookup Table (LUT) ─────────────

/**
 * Palet tanımlayıcısı (0028,110x) VR'ı: tek üçlü ya da **segmentli palet**.
 * Segmentli olduğunda ardışık üçlüler bulunur (ör. 2 segment = 6 US değeri);
 * her üçlü `(numEntries, firstMappedIndex, bitsPerEntry)` taşır ve LUT verisi
 * segmentlerin sırayla eklenmesiyle oluşur. Üçlülerin katı 3 katı olmayan
 * kuyruk yok sayılır (ilk üçlü her zaman alınır). `ds.string()` metin olmayan
 * VR'da yalnız ilk baytı döndürdüğü için ikili okuma gerekir; eski metin
 * biçimi de (test/üretici hatası) desteklenir.
 */
export interface LutSegment { entries: number; first: number; bits: number }

function readLutSegments(ds: DicomDataSet, tag: string): LutSegment[] | null {
  const el = ds.elements[tag];
  if (!el) return null;
  let raw: number[] = [];
  const s = ds.string(tag);
  if (s && s.includes("\\")) {
    raw = s.split("\\").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  } else if (el.length >= 6) {
    const buf = ds.byteArray.buffer as ArrayBuffer;
    const words = Math.min(Math.floor(el.length / 2), 3 * 16); // en çok 16 üçlü
    const dv = new DataView(buf, ds.byteArray.byteOffset + el.dataOffset, words * 2);
    const signed = el.vr === "SS";
    for (let i = 0; i < words; i++) raw.push(signed ? dv.getInt16(i * 2, true) : dv.getUint16(i * 2, true));
  }
  if (raw.length < 3) return null;
  const segs: LutSegment[] = [];
  for (let k = 0; k + 3 <= raw.length; k += 3) {
    const entriesRaw = raw[k], first = raw[k + 1], bitsRaw = raw[k + 2];
    const entries = entriesRaw === 0 ? 65536 : entriesRaw; // 0 = 65536 giriş (DICOM)
    if (!(entries > 0)) continue;
    segs.push({ entries, first: Math.max(0, first | 0), bits: bitsRaw === 16 ? 16 : 8 });
  }
  return segs.length > 0 ? segs : null;
}

export function parsePaletteColorLUT(ds: DicomDataSet): PaletteColorLUT | null {
  const rData = ds.elements["x00281201"];
  const gData = ds.elements["x00281202"];
  const bData = ds.elements["x00281203"];
  if (!rData || !gData || !bData) return null;

  // Her kanalın kendi tanımlayıcısı olabilir (segmentli palet); yoksa R'ninki
  // kullanılır (DICOM'da üçü genellikle aynıdır).
  const rS = readLutSegments(ds, "x00281101");
  const gS = readLutSegments(ds, "x00281102") ?? rS;
  const bS = readLutSegments(ds, "x00281103") ?? rS;
  const segsR = rS ?? gS ?? bS;
  const segsG = gS ?? rS ?? bS;
  const segsB = bS ?? rS ?? gS;
  if (!segsR || !segsG || !segsB) return null;

  // Ortak indeks örgüsü: tüm segmentlerin kapladığı aralık (boşluklar sıfır kalır).
  const all = [...segsR, ...segsG, ...segsB];
  const first = all.reduce((m, x) => Math.min(m, x.first), Infinity);
  const last = all.reduce((m, x) => Math.max(m, x.first + x.entries), 0);
  const numEntries = Math.max(1, last - first);
  const bits = all.some((x) => x.bits === 16) ? 16 : 8;

  const buf = ds.byteArray.buffer as ArrayBuffer;
  const offsetOf = (el: { dataOffset: number }) => ds.byteArray.byteOffset + el.dataOffset;
  const expand = (segs: LutSegment[], el: { vr?: string; length: number; dataOffset: number }) => {
    const total = segs.reduce((a, x) => a + x.entries, 0);
    const chMax16 = segs.some((x) => x.bits === 16);
    const wide = chMax16 || el.length >= total * 2; // 8-bit değer OW kabında gelebilir
    const out: Uint8Array | Uint16Array = bits === 16 ? new Uint16Array(numEntries) : new Uint8Array(numEntries);
    let cursor = 0;
    for (const seg of segs) {
      const base = seg.first - first;
      // Global 16-bit örgüde 8-bit segment ×256 ölçeklenir (255 → 0xff00/256 = 255).
      const scale = bits === 16 && seg.bits === 8 ? 256 : 1;
      if (wide) {
        const maxWords = Math.max(0, Math.floor((el.length - cursor * 2) / 2));
        const words = new Uint16Array(buf, offsetOf(el) + cursor * 2, Math.min(seg.entries, maxWords));
        for (let i = 0; i < words.length && base + i < numEntries; i++) out[base + i] = words[i] * scale;
        cursor += Math.min(seg.entries, maxWords);
      } else {
        const maxBytes = Math.max(0, el.length - cursor);
        const bytes = new Uint8Array(buf, offsetOf(el) + cursor, Math.min(seg.entries, maxBytes));
        for (let i = 0; i < bytes.length && base + i < numEntries; i++) out[base + i] = bytes[i] * scale;
        cursor += Math.min(seg.entries, maxBytes);
      }
    }
    return out;
  };
  const r = expand(segsR, rData);
  const g = expand(segsG, gData);
  const b = expand(segsB, bData);

  return {
    numEntries,
    firstMapped: first,
    bits,
    r,
    g,
    b,
    segments: Math.max(segsR.length, segsG.length, segsB.length),
  };
}

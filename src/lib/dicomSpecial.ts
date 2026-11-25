import { expandSegmentedPalette16, expandSegmentedPalette8 } from "./segmentedPalette";
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

export function parsePresentationState(ds: DicomDataSet): DicomGSPS | null {
  const graphicSeq = ds.elements["x00700001"];
  const graphics: GSPSGraphicObject[] = [];
  const texts: GSPSTextObject[] = [];

  if (graphicSeq?.items) {
    for (const item of graphicSeq.items) {
      if (!item.dataSet) continue;
      const itemDs = item.dataSet;

      // Text Objects (0070,0008)
      const textSeq = itemDs.elements["x00700008"];
      if (textSeq?.items) {
        for (const tItem of textSeq.items) {
          if (!tItem.dataSet) continue;
          const text = tItem.dataSet.string("x00700006") || "";
          if (text) texts.push({ text });
        }
      }

      // Graphic Objects (0070,0009)
      const grSeq = itemDs.elements["x00700009"];
      if (grSeq?.items) {
        for (const gItem of grSeq.items) {
          if (!gItem.dataSet) continue;
          const gType = (gItem.dataSet.string("x00700023") || "POLYLINE").toUpperCase() as GSPSGraphicObject["type"];
          const dataStr = gItem.dataSet.string("x00700022") || "";
          const data = dataStr.split("\\").map(Number).filter((n) => !Number.isNaN(n));
          graphics.push({ type: gType, data });
        }
      }
    }
  }

  const label = ds.string("x00700080") || "GSPS Anotasyonları";
  const description = ds.string("x00700081") || "";
  const presentationLutShape = (ds.string("x20500020") || "IDENTITY").toUpperCase() as DicomGSPS["presentationLutShape"];

  return {
    id: `gsps-${Date.now()}`,
    label,
    description,
    graphics,
    texts,
    presentationLutShape,
  };
}

// ───────────── 6. Palette Color Lookup Table (LUT) ─────────────

export function parsePaletteColorLUT(ds: DicomDataSet): PaletteColorLUT | null {
  // Descriptor US/SS olarak ikili kodlanır; ilk ve üçüncü değer daima unsigned'dır.
  const descTags = ["x00281101", "x00281102", "x00281103"];
  const dataTags = ["x00281201", "x00281202", "x00281203"];
  const read16 = (offset: number) => ds.byteArrayParser.readUint16(ds.byteArray, offset);
  const signed = ds.uint16("x00280103") === 1;
  const descriptors = descTags.map(tag => {
    const el = ds.elements[tag];
    if (!el || el.length !== 6 || el.dataOffset + el.length > ds.byteArray.length) return null;
    const count = read16(el.dataOffset) || 65536;
    const first = signed ? ds.byteArrayParser.readInt16(ds.byteArray, el.dataOffset + 2) : read16(el.dataOffset + 2);
    return { count, first, bits: read16(el.dataOffset + 4) };
  });
  const desc = descriptors[0];
  if (!desc || ![8, 16].includes(desc.bits) || descriptors.some(d => !d || d.count !== desc.count || d.first !== desc.first || d.bits !== desc.bits)) return null;

  const channels = dataTags.map((tag, index) => {
    const el = ds.elements[tag];
    const segmented = ds.elements[`x0028122${index + 1}`];
    if (segmented) {
      if (el || segmented.length % 2 || segmented.dataOffset + segmented.length > ds.byteArray.length) return null;
      if (desc.bits === 8) {
        const bytes = Array.from(ds.byteArray.subarray(segmented.dataOffset, segmented.dataOffset + segmented.length));
        return expandSegmentedPalette8(bytes, desc.count, ds.string("x00020010")?.trim() === "1.2.840.10008.1.2.2");
      }
      const words: number[] = [];
      for (let i = 0; i < segmented.length; i += 2) words.push(read16(segmented.dataOffset + i));
      return expandSegmentedPalette16(words, desc.count);
    }
    if (!el || el.dataOffset + el.length > ds.byteArray.length) return null;
    if (desc.bits === 8 && desc.count === 1) return null; // packed vs word storage is ambiguous
    const packedLength = desc.count + (desc.count % 2);
    const words = el.length === desc.count * 2;
    if (desc.bits === 16 && !words) return null;
    if (desc.bits === 8 && !words && el.length !== packedLength) return null;
    const out = desc.bits === 16 ? new Uint16Array(desc.count) : new Uint8Array(desc.count);
    for (let i = 0; i < desc.count; i++) {
      if (words) {
        const value = read16(el.dataOffset + i * 2);
        if (desc.bits === 8 && value > 255) return null;
        out[i] = value;
      } else if (el.vr === "OB") {
        out[i] = ds.byteArray[el.dataOffset + i];
      } else {
        // OW is a sequence of endian-aware words, including packed 8-bit entries.
        const word = read16(el.dataOffset + (i & ~1));
        out[i] = i % 2 ? word >>> 8 : word & 255;
      }
    }
    return out;
  });
  const [r, g, b] = channels;
  if (!r || !g || !b) return null;
  return { numEntries: desc.count, firstMapped: desc.first, bits: desc.bits, r, g, b };
}

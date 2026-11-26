/**
 * DICOM video (MPEG-2 / MPEG-4 AVC/H.264 / HEVC/H.265) nesneleri (f-objects).
 *
 * Video kareleri piksel kod çözücüye GİRMEZ; kapsüllenmiş piksel verisi
 * dosyanın kendisidir. Bu modül fragment'ları doğru sırayla birleştirip
 * tarayıcının oynatabileceği Blob/MIME ikilisini hazırlar. Oynatma
 * `<video>` öğesine devredilir — codec desteği tarayıcıya bağlıdır
 * (ör. MPEG-2 ve HEVC çoğu tarayıcıda oynatılamaz; bu durumda indirme
 * düğmesiyle yerel oynatıcıya yönlendirilir).
 */
import type { DicomDataSet } from "dicom-parser";
import type { DicomVideoSequence } from "./types";

/** Transfer Syntax UID → MIME ve insan okunur codec etiketi (PS3.6). */
const VIDEO_TS: Record<string, { mime: string; label: string }> = {
  "1.2.840.10008.1.2.4.100": { mime: "video/mpeg", label: "MPEG-2 (Main Profile @ Main Level)" },
  "1.2.840.10008.1.2.4.101": { mime: "video/mpeg", label: "MPEG-2 (Main Profile @ High Level)" },
  "1.2.840.10008.1.2.4.102": { mime: "video/mp4", label: "MPEG-4 AVC/H.264 (High Profile @L4.1)" },
  "1.2.840.10008.1.2.4.103": { mime: "video/mp4", label: "MPEG-4 AVC/H.264 (BD-compatible High Profile @L4.1)" },
  "1.2.840.10008.1.2.4.104": { mime: "video/mp4", label: "MPEG-4 AVC/H.264 (High Profile @L4.2)" },
  "1.2.840.10008.1.2.4.105": { mime: "video/mp4", label: "MPEG-4 AVC/H.264 (Stereo High Profile @L4.2)" },
  "1.2.840.10008.1.2.4.106": { mime: "video/mp4", label: "HEVC/H.265 (Main Profile @L5.1)" },
  "1.2.840.10008.1.2.4.107": { mime: "video/mp4", label: "HEVC/H.265 (Main 10 Profile @L5.1)" },
};

export const VIDEO_TRANSFER_SYNTAXES = Object.keys(VIDEO_TS);

export function isVideoTransferSyntax(ts: string | null | undefined): boolean {
  return !!ts && ts.trim() in VIDEO_TS;
}

/** MIME türü ve codec etiketi; bilinmeyen TS için null. */
export function videoInfo(ts: string | null | undefined): { mime: string; label: string } | null {
  if (!ts) return null;
  return VIDEO_TS[ts.trim()] ?? null;
}

/** Kapsüllenmiş video dosyasının tamamını (tüm fragment'ların birleşimi) döndürür. */
export function extractVideoPayload(ds: DicomDataSet): Uint8Array | null {
  const el = ds.elements["x7fe00010"];
  if (!el || !el.encapsulatedPixelData) return null;
  const fragments = el.fragments;
  if (!fragments || fragments.length === 0) return null;
  let total = 0;
  for (const f of fragments) {
    if (f.position < 0 || f.length < 0 || f.position + f.length > ds.byteArray.length) return null;
    total += f.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of fragments) {
    out.set(ds.byteArray.subarray(f.position, f.position + f.length), off);
    off += f.length;
  }
  return out;
}

/**
 * Video nesnesini ayrıştırır. TS video değilse veya payload fragment'larından
 * okunamazsa null döner (çağıran "desteklenmiyor" sayacına yazar).
 */
export function parseDicomVideo(ds: DicomDataSet): DicomVideoSequence | null {
  const ts = (ds.string("x00020010") ?? "").trim();
  const info = videoInfo(ts);
  if (!info) return null;
  const payload = extractVideoPayload(ds);
  if (!payload || payload.length === 0) return null;
  const frames = ds.intString("x00280008") ?? 0;
  const rate = ds.intString("x00180040") ?? 0; // Cine Rate (frames/s), Cine Module
  const title = (ds.string("x0008103e") || ds.string("x00081030") || "Video").slice(0, 120);
  return {
    id: `dicom-video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    frameRate: rate > 0 ? rate : 0,
    totalFrames: frames > 0 ? frames : 0,
    payload,
    mimeType: info.mime,
    codecLabel: info.label,
  };
}

/** İndirme için dosya uzantısı (Blob/oynatma hatasında yerel oynatıcı). */
export function videoFileExtension(mimeType: string): string {
  return mimeType === "video/mpeg" ? ".mpg" : ".mp4";
}

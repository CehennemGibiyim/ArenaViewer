/**
 * DICOMweb STOW-RS ile canlı XA/US kabul — saf çekirdek (f-objects).
 *
 * Kapsam dürüstlüğü: bu modül DIMSE **C-STORE** DEĞİLDİR; DICOMweb STOW-RS
 * (`POST /api/dicomweb/studies`) üzerinden modalite/ağ geçidi/Orthanc'ın
 * gönderdiği örnekleri doğrular, depolama ve akış oynatıcıya birleştirme
 * kararlarını saf tutar. AE başlığı/C-ECHO/DIMSE yoktur; kurum DIMSE gerektiriyorsa
 * önüne bir DICOMweb ağ geçidi (Orthanc/dcm4chee) konmalıdır.
 *
 * `mergeSeriesData` istemci (Workstation) tarafında canlı akışla kullanılır;
 * bu dosya yalnız istemci-güvenli modüllere bağımlıdır (dicom-parser, tipler).
 */
import * as dicomParser from "dicom-parser";
import type { SeriesData } from "./types";

export const INGEST_MAX_INSTANCES = 64;
export const INGEST_MAX_INSTANCE_BYTES = 40 * 1024 * 1024; // 40 MB (base64 hariç ham bayt)
export const INGEST_MAX_TOTAL_BYTES = 300 * 1024 * 1024;

export interface IngestInstanceInfo {
  sopClass: string;
  sopUid: string;
  studyUid: string;
  seriesUid: string;
  modality: string;
  seriesDescription: string;
  patientName: string;
  patientId: string;
  patientAge: string;
  patientSex: string;
  studyDate: string;
  institution: string;
  bodyPart: string;
  accession: string;
}

export type IngestValidation =
  | { ok: true; info: IngestInstanceInfo }
  | { ok: false; error: string };

const isUid = (s: string) => /^[0-9]+(\.[0-9]+)*$/.test(s) && s.length <= 64;

/** Minimal, çevrimdışı doğrulama: DICM imzası + zorunlu UID etiketleri. */
export function validateIngestInstance(bytes: Uint8Array): IngestValidation {
  if (bytes.length < 132) return { ok: false, error: `Örnek çok küçük (${bytes.length} bayt)` };
  if (bytes[128] !== 0x44 || bytes[129] !== 0x49 || bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
    return { ok: false, error: "Geçerli DICOM P10 değil (DICM imzası yok)" };
  }
  try {
    // Yalnız zorunlu etiketlere kadar ayrıştır (piksel verisi okunmaz — büyük medya gövdesi)
    const ds = dicomParser.parseDicom(bytes, { untilTag: "x0020000e" });
    const sopClass = (ds.string("x00080016") ?? "").trim();
    const sopUid = (ds.string("x00080018") ?? "").trim();
    const studyUid = (ds.string("x0020000d") ?? "").trim();
    const seriesUid = (ds.string("x0020000e") ?? "").trim();
    if (!isUid(sopClass) || !isUid(sopUid) || !isUid(studyUid) || !isUid(seriesUid)) {
      return { ok: false, error: "Zorunlu SOP/Study/Series UID etiketleri eksik veya geçersiz" };
    }
    return {
      ok: true,
      info: {
        sopClass,
        sopUid,
        studyUid,
        seriesUid,
        modality: (ds.string("x00080060") ?? "OT").trim(),
        seriesDescription: (ds.string("x0008103e") ?? ds.string("x00081030") ?? "").trim().slice(0, 120),
        patientName: (ds.string("x00100010") ?? "").replace(/\^/g, " ").trim().slice(0, 120),
        patientId: (ds.string("x00100020") ?? "").trim().slice(0, 64),
        patientAge: (ds.string("x00101010") ?? "").trim().slice(0, 16),
        patientSex: (ds.string("x00100040") ?? "").trim().slice(0, 8),
        studyDate: (ds.string("x00080020") ?? "").trim().slice(0, 16),
        institution: (ds.string("x00080080") ?? "").trim().slice(0, 120),
        bodyPart: (ds.string("x00180015") ?? "").trim().slice(0, 32),
        accession: (ds.string("x00080050") ?? "").trim().slice(0, 64),
      },
    };
  } catch (e) {
    return { ok: false, error: `DICOM ayrıştırılamadı: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface IngestResultEntry {
  sopUid: string;
  ok: boolean;
  error?: string;
}

/**
 * STOW-RS yanıtı (application/dicom+json): başarılar `00081199`, hatalar
 * `00081198` referanslarıyla; `parseStowResponse` (uygulama istemcisi) ile
 * uyumludur.
 */
export function buildStowResponseBody(results: IngestResultEntry[]): Record<string, unknown> {
  const ref = (uid: string, status?: number, description?: string) => ({
    "00081155": { vr: "UI", Value: [uid] },
    ...(status !== undefined
      ? { "00081190": { vr: "US", Value: [status] }, "00081196": { vr: "LO", Value: [description ?? "kabukta işlenemedi"] } }
      : {}),
  });
  const succeeded = results.filter((r) => r.ok).map((r) => ref(r.sopUid));
  const failed = results.filter((r) => !r.ok).map((r) => ref(r.sopUid, 272, r.error ?? "hata"));
  const out: Record<string, unknown> = {};
  if (succeeded.length) out["00081199"] = { vr: "SQ", Value: succeeded };
  if (failed.length) out["00081198"] = { vr: "SQ", Value: failed };
  return out;
}

export interface MergeOutcome {
  series: SeriesData[];
  /** Eklenen (yeni örneklerden gelen) kare/dosya sayısı. */
  addedFrames: number;
  /** Eşleşen seri (seriesUid) sayısı. */
  mergedSeries: number;
}

/**
 * Akıştan gelen yeni örnekleri açık serilerle birleştirir. Seriler seriesUid ile
 * eşleşir; yalnız aynı width/height ise kareler ART ARDA eklenir ve mevcut
 * serinin id'si korunur (anotasyon/kesit imleci etkilenmez). Eşleşmeyen ya da
 * boyutu farklı gelenler listenin sonuna AYRI seri olarak eklenir.
 * Saf fonksiyon; gelen diziler değiştirilmez.
 */
export function mergeSeriesData(existing: SeriesData[], incoming: SeriesData[]): MergeOutcome {
  const series = existing.map((s) => ({ ...s }));
  let addedFrames = 0;
  let mergedSeries = 0;
  for (const inc of incoming) {
    const idx = inc.seriesUid ? series.findIndex((s) => s.seriesUid === inc.seriesUid) : -1;
    if (idx >= 0 && series[idx].width === inc.width && series[idx].height === inc.height) {
      const cur = series[idx];
      const cat = <T,>(a?: T[], b?: T[]) => (a || b ? [...(a ?? []), ...(b ?? [])] : undefined);
      series[idx] = {
        ...cur,
        slices: [...cur.slices, ...inc.slices],
        rgbaSlices: cur.rgbaSlices && inc.rgbaSlices ? [...cur.rgbaSlices, ...inc.rgbaSlices] : undefined,
        files: [...(cur.files ?? []), ...(inc.files ?? [])],
        sopUids: cat(cur.sopUids, inc.sopUids),
        ipp: cat(cur.ipp, inc.ipp),
        slicePositions: cat(cur.slicePositions, inc.slicePositions),
      };
      addedFrames += inc.slices.length;
      mergedSeries++;
    } else {
      series.push(inc);
      addedFrames += inc.slices.length;
    }
  }
  return { series, addedFrames, mergedSeries };
}

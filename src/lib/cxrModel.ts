/**
 * Akciğer grafisi (CXR) derin sınıflandırma entegrasyonu — istemci tarafı.
 *
 * Model: Medical_X DenseNet121 (NIH ChestX-ray14, Apache-2.0) yerel ai-worker'da
 * çalışır (ONNX Runtime, CPU). Gömülü ONNX ve kaynak bildirimi:
 * ai-worker/models/NOTICE.md · python tarafı: ai-worker/cxr_lib.py.
 *
 * Çıkarım sonucu KLİNİK DEĞER DEĞİLDİR: yalnızca aday bulgu üretir, radyoloji
 * uzmanı onayı olmadan kullanılamaz. Model bbox/lokalizasyon VERMEZ; bunun yerine
 * pozitif sınıflar için ısı haritası (Grad-CAM) döner.
 */
import { gzip } from "fflate";
import type { Finding, Pixels, SeriesData } from "./types";
import { cxrProjection } from "./cxr";

/** Sınıf sözleşmesi: ai-worker/cxr_lib.py::CLASS_NAMES ile birebir. */
export const CXR_CLASSES = [
  { name: "Atelectasis", labelTr: "Atelektazi", threshold: 0.5 },
  { name: "Cardiomegaly", labelTr: "Kardiyomegali", threshold: 0.53 },
  { name: "Effusion", labelTr: "Effüzyon", threshold: 0.59 },
  { name: "Infiltration", labelTr: "İnfiltrat", threshold: 0.54 },
  { name: "Mass", labelTr: "Kütle", threshold: 0.51 },
  { name: "Nodule", labelTr: "Nodül", threshold: 0.5 },
  { name: "Pneumonia", labelTr: "Pnömoni", threshold: 0.36 },
  { name: "Pneumothorax", labelTr: "Pnömotoraks", threshold: 0.47 },
  { name: "Consolidation", labelTr: "Konsolidasyon", threshold: 0.51 },
  { name: "Edema", labelTr: "Ödem", threshold: 0.55 },
  { name: "Emphysema", labelTr: "Amfizem", threshold: 0.47 },
  { name: "Fibrosis", labelTr: "Fibrozis", threshold: 0.46 },
  { name: "Pleural_Thickening", labelTr: "Plevral Kalınlaşma", threshold: 0.47 },
  { name: "Hernia", labelTr: "Herniasyon", threshold: 0.53 },
] as const;

export interface CxrScore {
  index: number;
  name: string;
  labelTr: string;
  prob: number;
  threshold: number;
  positive: boolean;
}

/** Isı haritası: 64×64, 0–255 gri, base64 (worker'a giden boyutu küçültür). */
export interface CxrHeat {
  index: number;
  name: string;
  w: number;
  h: number;
  b64: string;
}

export interface CxrResult {
  scores: CxrScore[];
  top: { index: number; name: string; prob: number };
  heats: CxrHeat[];
  elapsedMs: number;
  model: string;
  imageSize: number;
}

export interface DecodedHeat {
  w: number;
  h: number;
  /** 0–255 gri değerler (satır satır). */
  data: Uint8Array;
}

const STATIC_DEMO_HALT =
  "statik web sürümünde yerel derin AI modeli çalışmaz — CXR modeli için Windows (ai-worker) veya Docker sürümünü kullanın";

/** Serinin CXR modeline uygun olup olmadığı; uygunsa null, değilse neden. */
export function cxrEligible(s: SeriesData): string | null {
  if (s.specialType && s.specialType !== "image") return "seri bir görüntü serisi değil";
  const m = s.modality.toUpperCase();
  if (!["CR", "DX", "RG"].includes(m)) return `yalnızca direkt grafide (CR/DX/RG) çalışır; bu seri ${s.modality}`;
  const txt = `${s.bodyPart} ${s.description}`.toUpperCase();
  if (!/(AKCİĞER|AKCIGER|GÖĞÜS|GOGUS|CHEST|TORAX|TORAKS|THORAX|LUNG|PA.?FILM)/.test(txt)) {
    return "bölge/seri tanımı akciğer grafisi göstermiyor (yanlış seri seçimi olabilir)";
  }
  const sliceCount = Math.min(s.slices.length, 4);
  if (sliceCount < 1) return "görüntü karesi yok";
  if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width < 8 || s.height < 8) return "görüntü boyutu bilinmiyor";
  const frame = s.slices[Math.min(s.slices.length - 1, Math.floor(sliceCount / 2))];
  if (frame.length !== s.width * s.height) return "kare piksel boyutu tutarsız";
  return null;
}

function toGray(pixels: Pixels, s: SeriesData, idx: number): Float32Array {
  const n = s.width * s.height;
  const out = new Float32Array(n);
  const rgba = s.isColor ? s.rgbaSlices?.[idx] : undefined;
  const sl = s.slices[idx];
  if (rgba && rgba.length === n) {
    for (let i = 0; i < n; i++) {
      const v = rgba[i];
      out[i] = 0.299 * (v & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * ((v >> 16) & 255);
    }
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = sl[i];
  return out;
}

export interface PackedCxr {
  bytes: Uint8Array;                     // gzip(float32 LE, tek kare)
  dims: [number, number, number];        // [1, Y, X]
  spacing: [number, number, number];     // [1, sy, sx]
}

/** Tek karelik gri grafi hacmini worker'a gönderilecek biçimde pakler. */
export async function packCxrImage(s: SeriesData): Promise<PackedCxr | null> {
  if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width < 8 || s.height < 8 || !s.slices.length) return null;
  const idx = Math.min(s.slices.length - 1, Math.floor(Math.min(s.slices.length, 4) / 2));
  const gray = toGray(s.slices[idx], s, idx);
  if (gray.some((v) => !Number.isFinite(v))) return null;
  const raw = new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength);
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    gzip(raw, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const dx = s.pixelSpacingX ?? s.pixelSpacing ?? 1;
  return { bytes, dims: [1, s.height, s.width], spacing: [1, s.pixelSpacing || 1, dx] };
}

/** Worker'ın CXR sonucunu sunucu yanıtına taşır; hata mesajını fırlatır. */
export async function cxrScan(s: SeriesData, signal?: AbortSignal): Promise<CxrResult> {
  if (process.env.NEXT_PUBLIC_STATIC_DEMO === "true") throw new Error(STATIC_DEMO_HALT);
  const packed = await packCxrImage(s);
  if (!packed) throw new Error("Grafik pikselleri paketlenemedi");
  const res = await fetch("/api/deep-scan?protocol=cxr", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Dims": packed.dims.join(","),
      "X-Spacing": packed.spacing.map((v) => v.toFixed(4)).join(","),
      "X-Protocol": "cxr",
    },
    body: packed.bytes.buffer as ArrayBuffer,
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  const data = (await res.json().catch(() => null)) as ({ error?: string } & Partial<CxrResult>) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `yerel AI worker hatası (${res.status})`);
  if (!Array.isArray(data.scores) || data.scores.length !== CXR_CLASSES.length) {
    throw new Error("CXR model yanıtı eksik/kusurlu");
  }
  return {
    scores: data.scores.map((r, i) => ({
      index: i,
      name: CXR_CLASSES[i].name,
      labelTr: CXR_CLASSES[i].labelTr,
      prob: Number(r.prob) || 0,
      threshold: CXR_CLASSES[i].threshold,
      // Tek doğruluk kaynağı istemcidir: worker yanıtındaki bayrak görmezden gelinir.
      positive: Number(r.prob) >= CXR_CLASSES[i].threshold,
    })),
    top: { index: Number(data.top?.index) || 0, name: String(data.top?.name ?? ""), prob: Number(data.top?.prob) || 0 },
    heats: Array.isArray(data.heats) ? (data.heats as CxrHeat[]) : [],
    elapsedMs: Number(data.elapsedMs) || 0,
    model: String(data.model ?? "Medical_X DenseNet121"),
    imageSize: Number(data.imageSize) || 320,
  };
}

/** 64×64 base64 ısı haritasını çözümler (tarayıcıda örtü çizimi için). */
export function decodeCxrHeat(h: CxrHeat): DecodedHeat {
  const bin = globalThis.atob ? globalThis.atob(h.b64) : Buffer.from(h.b64, "base64").toString("binary");
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { w: h.w, h: h.h, data };
}

/** Aday öncelik bandı (model skoru kalibre olasılık değildir). */
export function cxrSeverity(prob: number): Finding["severity"] {
  if (prob >= 0.75) return "yuksek";
  if (prob >= 0.55) return "orta";
  return "dusuk";
}

/**
 * CXR model çıktısını rapor bulgularına çevirir. Model bbox vermez; konum yerine
 * ısı haritası harita anahtarıyla (finding id) gönderilir.
 */
export function cxrResultsToFindings(res: CxrResult, s: SeriesData): Finding[] {
  const projection = cxrProjection({ bodyPart: s.bodyPart, description: s.description });
  // Sunucu/worker'dan gelen pozitif bayrağı GÜVENİLMEZ: tek doğruluk kaynağı bu
  // istemcinin sabit eşik tablosudur (prob >= CXR_CLASSES[i].threshold).
  const positive = res.scores
    .filter((c) => Number.isFinite(c.prob) && Number(c.prob) >= CXR_CLASSES[c.index]?.threshold)
    .sort((a, b) => b.prob - a.prob);
  return positive.slice(0, 8).map((c, i) => {
    const hasHeat = res.heats.some((h) => h.index === c.index);
    const sev = cxrSeverity(c.prob);
    return {
      id: `cx${i + 1}`,
      sliceIndex: 0,
      sliceStart: 0,
      sliceEnd: Math.max(0, s.slices.length - 1),
      keySliceNumber: 1,
      sliceRangeStr: s.slices.length > 1 ? `Kare 1 – ${s.slices.length}` : "Kare 1",
      anatomicalLocation: `${s.bodyPart} (grafik · projeksiyon ${projection})`,
      densityOrSignal: `model olasılığı %${Math.round(c.prob * 100)} (eşik %${Math.round(c.threshold * 100)})`,
      sizeMmStr: "ölçüm yok (lokalizasyon üretmez)",
      bbox: null,
      label: `${c.labelTr} adayı`,
      detail:
        `Yerel derin öğrenme modeli (Medical_X DenseNet121, NIH ChestX-ray14) bu grafide ${c.name} için ` +
        `%${Math.round(c.prob * 100)} model olasılığı bildirdi (sınıf eşiği %${Math.round(c.threshold * 100)}; ` +
        `kalibre olasılık değildir).${hasHeat ? " Konumsal aday alan modelin ısı haritasıyla gösterilir (oturumda; rapora işlenmez)." : ""} ` +
        `Model lokalizasyon KUTUSU üretmez; bulgu yerleştirmesi ve klinik geçerliliği radyolog aittir. ` +
        `BULGU YAPAY ZEKA ÇIKTISIDIR VE RADYOLOJİ UZMANI TARAFINDAN ONAYLANMADAN GEÇERLİ DEĞİLDİR.`,
      category: "CXR AI",
      severity: sev,
      confidence: c.prob,
      confidenceKind: "heuristic",
      source: "ai-model",
      // Isı haritası Finding'e SAKLANMAZ: rapor kaydı şişmesin. Görselleştirme
      // anahtarı Workstation'da tutulur (bulgu sırası = pozitif sınıf sırası).
    } satisfies Finding;
  });
}

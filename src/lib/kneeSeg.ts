/**
 * Diz MR — menisküs/kıkırdak/kemik segmentasyonu istemci entegrasyonu.
 *
 * - MR serisinin gerçek piksel değerleri Int16 little-endian hacme paketlenir
 *   (HU varsayımı YOK — ham sinyal gönderilir), gzip ile sıkıştırılır ve yerel
 *   AI worker'a (127.0.0.1:8787) yalnızca bu makine üzerinden iletilir.
 *   Hasta verisi ağ dışına ÇIKMAZ, ücretli servis KULLANILMAZ.
 * - Model: `aagatti/nnunet_knee` (MIT lisans, nnU-Net v2 cascade, OAI-ZIB
 *   eğitimi; Goyal et al., medRxiv 2025.02.21.25322094). Ağırlıklar depoda
 *   GÖMÜLÜ DEĞİLDİR; `python ai-worker/setup_knee_model.py` ile indirilir.
 * - Çıktı 9 yapının maskesidir; **yırtık/dejenerasyon sınıflaması YAPILMAZ**.
 *   Bulgular araştırma amaçlıdır; radyoloji uzmanı onayı olmadan klinik
 *   olarak kullanılamaz. Segmentlerin örtüsü bu sürümde çizilmez (SEG/RTSTRUCT
 *   indirme ve mL istatistikleri verilir).
 */
import { gzip, gunzipSync } from "fflate";
import type { SeriesData } from "./types";
import type { SegMask } from "./segmentation";

/** Modelin etiket uzayıyla bire bir aynı 9 yapı (0 = arka plan). */
export interface KneeStructure {
  id: number;
  tr: string;
  en: string;
}

export const KNEE_STRUCTURES: KneeStructure[] = [
  { id: 1, tr: "Patella kıkırdağı", en: "Patellar cartilage" },
  { id: 2, tr: "Femur kıkırdağı", en: "Femoral cartilage" },
  { id: 3, tr: "Medial tibia kıkırdağı", en: "Medial tibial cartilage" },
  { id: 4, tr: "Lateral tibia kıkırdağı", en: "Lateral tibial cartilage" },
  { id: 5, tr: "Medial menisküs", en: "Medial meniscus" },
  { id: 6, tr: "Lateral menisküs", en: "Lateral meniscus" },
  { id: 7, tr: "Femur kemiği", en: "Femur bone" },
  { id: 8, tr: "Tibia kemiği", en: "Tibia bone" },
  { id: 9, tr: "Patella kemiği", en: "Patella bone" },
];

/** Konnektivite-sınırlı üst sınır: ~120M voksel (sagittal diz ~20M, büyük aksiyel setler sığar). */
const MAX_VOXELS = 120_000_000;

/** Diz segmentasyonu için uygun değilse nedenini döndürür; uygunsa null. */
export function kneeSegEligible(s: SeriesData): string | null {
  if (s.specialType && s.specialType !== "image") return "seri bir görüntü serisi değil";
  if (s.modality.toUpperCase() !== "MR") return "yalnızca MR (diz) serilerinde çalışır";
  if (s.isColor || s.rgbaSlices) return "renkli/görüntü serisi değil";
  if (s.slices.length < 12) return `seri çok kısa (${s.slices.length} kesit; en az 12 gerekli)`;
  const Y = s.height, X = s.width;
  if (!Y || !X) return "kesit boyutları bilinmiyor";
  for (const sl of s.slices) {
    if (!sl || sl.length !== Y * X) return "kesit boyutları tutarsız";
  }
  if (s.slices.length * Y * X > MAX_VOXELS) return "hacim çok büyük (120M voksel sınırı)";
  return null;
}

export interface PackedKnee {
  bytes: Uint8Array; // gzip(int16 LE)
  dims: [number, number, number];     // Z, Y, X
  spacing: [number, number, number];  // sz, sy, sx mm
}

/** Seriyi ham MR yoğunluk hacmine paketler (gzip dahil). Uygun değilse null. */
export async function packMrVolume(s: SeriesData): Promise<PackedKnee | null> {
  const Z = s.slices.length, Y = s.height, X = s.width;
  if (!Z || !Y || !X) return null;
  if (s.slices.some((sl) => !sl || sl.length !== Y * X)) return null;
  if (Z * Y * X > MAX_VOXELS) return null;

  const vol = new Int16Array(Z * Y * X);
  let o = 0;
  for (let z = 0; z < Z; z++) {
    const sl = s.slices[z];
    for (let i = 0; i < sl.length; i++) {
      const v = sl[i];
      // Ham MR sinyali: işaretli/işaretsiz aralık ne olursa olsun int16'ya kırp.
      vol[o++] = v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v);
    }
  }

  // Kesit aralığı: slicePositions > sliceSpacing > sliceThickness (deep scan ile aynı sıra).
  const dz = Math.abs((s.slicePositions?.[1] ?? 0) - (s.slicePositions?.[0] ?? 0)) || s.sliceSpacing || s.sliceThickness || 1;
  const dy = s.pixelSpacing > 0 ? s.pixelSpacing : 1;
  const dx = s.pixelSpacingX && s.pixelSpacingX > 0 ? s.pixelSpacingX : dy;

  const raw = new Uint8Array(vol.buffer, vol.byteOffset, vol.byteLength);
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    gzip(raw, (err, out) => (err ? reject(err) : resolve(out)));
  });
  return { bytes, dims: [Z, Y, X], spacing: [dz, dy, dx] };
}

export interface KneeScanOutput {
  /** Z*Y*X boyutunda etiket hacmi (0 arka plan, 1..9 KNEE_STRUCTURES). */
  labels: Uint8Array;
  dims: [number, number, number];
  elapsedMs: number;
  model: string;
}

/**
 * Seriyi yerel AI worker'a gönderir ve 9 yapının maske etiketlerini döndürür.
 * Ağ hatası / worker kapalı / model kurulu değilse hata fırlatır (çağıran akış devam eder).
 */
export async function kneeScan(s: SeriesData, signal?: AbortSignal): Promise<KneeScanOutput> {
  // GitHub Pages (NEXT_PUBLIC_STATIC_DEMO) derlemesinde /api/* yoktur.
  if (process.env.NEXT_PUBLIC_STATIC_DEMO === "true") {
    throw new Error(
      "statik web sürümünde yerel derin AI modeli çalışmaz — diz segmentasyonu için Windows (ai-worker) veya Docker/Render sürümünü kullanın",
    );
  }
  const packed = await packMrVolume(s);
  if (!packed) throw new Error("MR hacmi paketlenemedi (boyut sınırı/tutarsız kesit)");

  const res = await fetch("/api/deep-scan?protocol=knee", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Dims": packed.dims.join(","),
      "X-Spacing": packed.spacing.map((v) => v.toFixed(4)).join(","),
      "X-Protocol": "knee",
    },
    body: packed.bytes.buffer as ArrayBuffer, // fflate taze tampon döndürür
    signal: signal ?? AbortSignal.timeout(1_500_000), // nnU-Net CPU'da dk'lar sürebilir
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `yerel AI worker hatası (${res.status})`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let labels: Uint8Array;
  try {
    labels = gunzipSync(buf);
  } catch {
    throw new Error("worker yanıtı çözülemedi (gzip bekleniyordu)");
  }
  const [Z, Y, X] = packed.dims;
  const dimsHdr = (res.headers.get("x-dims") ?? "").split(",").map((v) => parseInt(v, 10));
  const dims: [number, number, number] =
    dimsHdr.length === 3 && dimsHdr.every((n) => Number.isFinite(n))
      ? [dimsHdr[0], dimsHdr[1], dimsHdr[2]]
      : [Z, Y, X];
  if (labels.length !== dims[0] * dims[1] * dims[2]) {
    throw new Error(`worker etiket hacmi boyutu tutmuyor (${labels.length} != ${dims.join("×")})`);
  }
  return {
    labels,
    dims,
    elapsedMs: Number(res.headers.get("x-elapsed-ms")) || 0,
    model: "nnU-Net Knee MRI (aagatti/nnunet_knee, MIT)",
  };
}

/** Etiket hacmini yapı başına binary SegMask'lara böler (boş yapılar dahil edilmez). */
export function splitKneeLabels(labels: Uint8Array, dims: [number, number, number]): Map<number, SegMask> {
  const [Z, Y, X] = dims;
  const out = new Map<number, SegMask>();
  for (const st of KNEE_STRUCTURES) out.set(st.id, { slices: new Map(), width: X, height: Y });
  for (let z = 0; z < Z; z++) {
    const base = z * Y * X;
    const perLabel = new Map<number, Uint8Array>();
    for (let i = 0; i < Y * X; i++) {
      const v = labels[base + i];
      if (v === 0 || v > 9) continue;
      let m = perLabel.get(v);
      if (!m) { m = new Uint8Array(Y * X); perLabel.set(v, m); }
      m[i] = 1;
    }
    for (const [label, sliceMask] of perLabel) {
      out.get(label)!.slices.set(z, sliceMask);
    }
  }
  return out;
}

export interface KneeVolumeStat {
  id: number;
  label: string;
  voxels: number;
  ml: number;
  /** En az bir dolu voxeli olan dilim sayısı */
  slices: number;
}

/** Voksel × voksel hacmi → mL. spacing [dz, dy, dx] (mm). */
export function kneeVolumeStats(masks: Map<number, SegMask>, spacing: [number, number, number]): KneeVolumeStat[] {
  const [dz, dy, dx] = spacing;
  const mm3 = Math.abs(dz * dy * dx) || 1;
  return KNEE_STRUCTURES.map((st) => {
    let voxels = 0;
    const m = masks.get(st.id);
    let slices = 0;
    if (m) {
      for (const slice of m.slices.values()) {
        let any = 0;
        for (let i = 0; i < slice.length; i++) { if (slice[i]) { voxels++; any = 1; } }
        slices += any;
      }
    }
    return { id: st.id, label: st.tr, voxels, ml: (voxels * mm3) / 1000, slices };
  });
}

/** Rapor/akış satırı — araştırma amaçlı etiketi zorunlu olarak içerir. */
export function kneeSegSummaryText(stats: KneeVolumeStat[], meta: { elapsedMs: number; model: string }): string {
  const lines = [
    "DİZ MR SEGMENTASYONU — nnU-Net Knee MRI (araştırma amaçlı; yırtık tanısı KONULMAZ; klinik karar için kullanılamaz):",
  ];
  for (const st of stats) {
    lines.push(`  ${st.label}: ${st.ml.toFixed(2)} mL (${st.voxels} voksel, ${st.slices} kesitte)`);
  }
  lines.push(`  Model: ${meta.model} · süre: ${(meta.elapsedMs / 1000).toFixed(1)} sn · Dice kendini bildirilen ≈ 0,84 (menisküs) / 0,906 (ortalama); prospektif doğrulama YOK.`);
  return lines.join("\n");
}

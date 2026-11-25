/**
 * Nükleer tıp analiz yardımcıları (kural tabanlı):
 *  - DSA/pre-post subtraksiyon özeti
 *  - TIC (zaman-aktivite eğrisi) sınıflandırması
 *  - Metabolik tümör hacmi (MTV) / SUVpeak
 *
 * SINIRLILIK: Bu modül projeksiyon/histogram verisi üzerinde çalışır; gerçek
 * SPECT/PET rekonstrüksiyonu, dikotomik zaman çözünürlüğü veya decay düzeltmesi
 * içermez. Sonuçlar araştırma/karşılaştırma çıktısıdır, klinik tanı değildir.
 */

export interface Matrix {
  rows: number[][];
  /** Piksel başına hacim (mL) — MTV için */
  voxelMl?: number | null;
}

export interface SubtractionSummary {
  /** Pre/post farkı ortalama ve standart sapma */
  meanDiff: number;
  stdDiff: number;
  /** Post'ta pozitif artış gösteren piksel oranı (%) */
  enhancedPct: number;
  /** Artış en yüksek olan piksel sayısı (üst %1) */
  hotPixels: number;
}

/** İki eş boyutlu matrisin farkı (post − pre); DSA benzeri subtraksiyon özeti. */
export function subtractionSummary(pre: Matrix, post: Matrix): SubtractionSummary | null {
  if (!pre.rows.length || !post.rows.length) return null;
  if (pre.rows.length !== post.rows.length || pre.rows[0].length !== post.rows[0].length) return null;

  const diffs: number[] = [];
  let enhanced = 0;
  for (let r = 0; r < pre.rows.length; r++) {
    for (let c = 0; c < pre.rows[r].length; c++) {
      const d = post.rows[r][c] - pre.rows[r][c];
      diffs.push(d);
      if (d > 0) enhanced++;
    }
  }
  const n = Math.max(1, diffs.length);
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sorted = [...diffs].sort((a, b) => b - a);
  const hotCount = Math.max(1, Math.floor(n * 0.01));
  return {
    meanDiff: mean,
    stdDiff: Math.sqrt(variance),
    enhancedPct: (enhanced / n) * 100,
    hotPixels: sorted.slice(0, hotCount).reduce((a, b) => a + b, 0),
  };
}

// ─────────────── TIC ───────────────

export type TicPattern = "washout" | "plateau" | "progressif" | "yetersiz";

export interface TicResult {
  pattern: TicPattern;
  peakValue: number;
  peakTimeSec: number;
  /** İlk çekimden zirveye wash-in hızı (birim/sn) */
  washIn: number | null;
  /** Zirveden sonra wash-out oranı (%) */
  washOutPct: number | null;
  advice: string;
}

/** Zaman-aktivite eğrisinden TIC modeli tahmini. */
export function ticCurve(t: number[], v: number[]): TicResult {
  const n = Math.min(t.length, v.length);
  if (n < 3) return { pattern: "yetersiz", peakValue: 0, peakTimeSec: 0, washIn: null, washOutPct: null, advice: "En az 3 zaman noktası gerekli." };

  let iPeak = 0;
  for (let i = 0; i < n; i++) if (v[i] > v[iPeak]) iPeak = i;

  const peakValue = v[iPeak];
  const peakTimeSec = t[iPeak];
  const dt = t[iPeak] - t[0];
  const washIn = dt > 0 ? (peakValue - v[0]) / dt : null;

  // Zirveden sonraki ilk ve son nokta arası düşüş
  let washOutPct: number | null = null;
  if (iPeak < n - 1 && peakValue > 0) {
    washOutPct = ((peakValue - v[n - 1]) / peakValue) * 100;
  }

  let pattern: TicPattern;
  let advice: string;
  if (washOutPct === null) {
    pattern = "yetersiz"; advice = "Zirve sonrası doygunluk noktası yok; wash-out hesaplanamadı.";
  } else if (washOutPct >= 15) {
    pattern = "washout"; advice = "Wash-out ≥%15: malign/metastatik veya hipervasküler lezyonda görülebilir; klinik korelasyon gerekir.";
  } else if (washOutPct <= 5) {
    pattern = "progressif"; advice = "Artan kinetik (wash-out ≤%5): benign/inflamatuar süreç olasılığı daha yüksektir; klinik korelasyon gerekir.";
  } else {
    pattern = "plateau"; advice = "Plato eğrisi: belirgin wash-out yok; benign/malign ayrımı klinik ve diğer tetkiklere bağlıdır.";
  }
  return { pattern, peakValue, peakTimeSec, washIn, washOutPct, advice };
}

// ─────────────── MTV / SUV ───────────────

export interface MtvResult {
  suvThreshold: number;
  mtvMl: number;
  suvPeak: number;
  voxelCount: number;
  advice: string;
}

/** SUV haritası (voxel dizisi) üzerinde metabolik tümör hacmi ve SUVpeak. */
export function metabolicTumorVolume(suvVoxels: number[], voxelMl: number, threshold = 2.5): MtvResult {
  const vals = suvVoxels.filter((x) => Number.isFinite(x));
  if (!vals.length) return { suvThreshold: threshold, mtvMl: 0, suvPeak: 0, voxelCount: 0, advice: "SUV verisi yok." };
  const peak = Math.max(...vals);
  const above = vals.filter((x) => x >= threshold);
  const mtv = above.length * (voxelMl ?? 0);
  return {
    suvThreshold: threshold,
    mtvMl: Math.round(mtv * 10) / 10,
    suvPeak: peak,
    voxelCount: above.length,
    advice:
      mtv <= 0
        ? `Hiç voxel ${threshold} SUV altında değil; MTV 0.`
        : `MTV ${mtv.toFixed(1)} mL (≥${threshold} SUV, ${above.length} voxel), SUVpeak ${peak.toFixed(1)}. Eşik ve segmentasyon protokole göredir.`,
  };
}

// ─────────────── Seriden SUV örnekleme ───────────────

export interface SuvSampleOptions {
  /** Piksel → SUV çarpanı (seri SuvInfo.factor). */
  factor: number;
  /** Piksel örnekleme adımı (varsayılan 2). */
  pixelStride?: number;
  /** En fazla kaç kesit (varsayılan 64). */
  maxSlices?: number;
}

export interface SuvSample {
  /** Örneklenen SUV değerleri (Bq/mL × factor). */
  values: number[];
  /** Örnek başına hacim (mL) — MTV için örnekleme ölçeklenmiş. */
  voxelMl: number;
  sampledVoxels: number;
  sliceStep: number;
  pixelStride: number;
}

/**
 * PET serisinden SUV örnekleri çıkarır (a-nm).
 *
 * Piksel değerleri `factor` ile SUV'a çevrilir (SuvInfo.factor = SUVbw/piksel).
 * Örnekleme nedeniyle elde edilen hacim **yaklaşıktır**; negatif/NaN pikseller
 * atılır. Mutlak kalibrasyon (doz/decay/att düzeltmesi) seri meta verisine bağlıdır.
 */
export function sampleSuvVoxels(
  getSlice: (z: number) => ArrayLike<number> | undefined,
  width: number,
  height: number,
  sliceCount: number,
  voxelMm3: number,
  opts: SuvSampleOptions,
): SuvSample {
  const stride = Math.max(1, Math.round(opts.pixelStride ?? 2));
  const maxSlices = Math.max(1, Math.round(opts.maxSlices ?? 64));
  const step = Math.max(1, Math.ceil(Math.max(1, sliceCount) / maxSlices));
  const factor = Number.isFinite(opts.factor) ? opts.factor : 0;
  const values: number[] = [];
  if (factor <= 0 || width <= 0 || height <= 0) {
    return { values, voxelMl: (voxelMm3 * stride * stride * step) / 1000, sampledVoxels: 0, sliceStep: step, pixelStride: stride };
  }
  for (let z = 0; z < sliceCount; z += step) {
    const data = getSlice(z);
    if (!data || data.length < width * height) continue;
    for (let y = 0; y < height; y += stride) {
      const row = y * width;
      for (let x = 0; x < width; x += stride) {
        const p = data[row + x];
        if (!Number.isFinite(p) || p <= 0) continue;
        values.push(p * factor);
      }
    }
  }
  return {
    values,
    voxelMl: (voxelMm3 * stride * stride * step) / 1000,
    sampledVoxels: values.length,
    sliceStep: step,
    pixelStride: stride,
  };
}

/** Eşik modu: mutlak SUV ya da maksimumun yüzdesi (ör. %41). */
export function resolveSuvThreshold(values: readonly number[], mode: "mutlak" | "yuzde", input: number): number {
  if (mode === "yuzde") {
    const peak = values.length ? Math.max(...values) : 0;
    const pct = Number.isFinite(input) ? Math.min(100, Math.max(1, input)) : 41;
    return Number(((peak * pct) / 100).toFixed(2));
  }
  return Number.isFinite(input) && input > 0 ? input : 2.5;
}

/** Eşik üstü voxellerin ortalama SUV'u (SUVmean); yoksa null. */
export function suvMeanAbove(values: readonly number[], threshold: number): number | null {
  const above = values.filter((v) => v >= threshold);
  if (!above.length) return null;
  return Number((above.reduce((a, b) => a + b, 0) / above.length).toFixed(2));
}

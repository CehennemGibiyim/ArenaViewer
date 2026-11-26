/**
 * 3 eksenli ölçüm: 3. çap tahmini — m-shapes "3. çapı otomatik başka kesitten alan
 * 3 eksenli ölçüm sihirbazı" maddesi.
 *
 * Elips çizildiği kesitte (aksiyel) 3. çap (kraniokaudal) henüz bilinmez. Bu modül,
 * aynı elips ayak izini komşu kesitlerde tarar; kesit başına ortalama yoğunluğu
 * (HU) çıkarır, 1B Otsu ile iki sınıfa ayırır ve çizilen kesiti içeren "parlak"
 * koşuyu sayar. Tahmini çap = koşu × kesit aralığı (sliceSpacing). Hacim hekim
 * onayına tabidir; tahmin yalnızca varsayılan değeri doldurur, kullanıcı değiştirebilir.
 */
import type { SeriesData } from "./types";
import { ellipseTest, regionStats } from "./geometry";

export interface D3Estimate {
  /** Tahmini 3. çap (mm). */
  d3Mm: number;
  /** Kontrastlı koşudaki kesit sayısı. */
  sliceRun: number;
  /** Otsu eşiği (HU). */
  threshold: number;
  /** Kesit başına elips içi ortalama (HU). */
  means: Float32Array;
}

/** 1B Otsu eşik: iki sınıf arası varyansı maksimize eder. Boş/tek değer → null. */
export function otsu1d(values: ArrayLike<number>): number | null {
  const n = values.length;
  if (n < 2) return null;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) { const v = values[i]; if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min) || max - min < 1e-9) return null;
  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const span = max - min;
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((values[i] - min) / span) * (BINS - 1));
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const total = n;
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += hist[b] * (b + 0.5);
  let sumB = 0, wB = 0, best = -1, bestVar = -1;
  for (let b = 0; b < BINS; b++) {
    wB += hist[b]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += hist[b] * (b + 0.5);
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = b; }
  }
  if (best < 0) return null;
  return min + ((best + 0.5) / BINS) * span;
}

/**
 * Aynı elips ayak izinde komşu kesitleri tarayıp 3. çap tahmin eder.
 * Yetersiz kontrast (maks-min < minContrast, varsayılan 30 HU) veya koşu yok → null.
 */
export function suggestEllipsoidD3(
  series: SeriesData,
  slice: number,
  e: { cx: number; cy: number; rx: number; ry: number },
  opts: { minContrast?: number } = {},
): D3Estimate | null {
  const N = series.slices.length;
  if (N === 0 || !series.slices[slice]) return null;
  const box = { x0: e.cx - e.rx, y0: e.cy - e.ry, x1: e.cx + e.rx, y1: e.cy + e.ry };
  const inside = ellipseTest(e.cx, e.cy, e.rx, e.ry);
  const means = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) {
    const st = regionStats(series, k, box, inside);
    means[k] = st ? st.mean : NaN;
  }
  const valid = Float32Array.from(means).filter((v) => Number.isFinite(v));
  if (valid.length < 2) return null;
  let mn = Infinity, mx = -Infinity;
  for (const v of valid) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const contrast = mx - mn;
  if (contrast < (opts.minContrast ?? 30)) return null; // düz hacim → tahmin yok
  const thr = otsu1d(valid);
  if (thr === null) return null;
  const bright = (v: number) => Number.isFinite(v) && v >= thr;
  // çizilen kesiti içeren parlak koşu
  let lo = slice, hi = slice;
  if (!bright(means[slice])) {
    // merkez kesit parlak değilse: en yakın parlak kesiti merkez al
    let bestK = -1, bestD = Infinity;
    for (let k = 0; k < N; k++) if (bright(means[k]) && Math.abs(k - slice) < bestD) { bestD = Math.abs(k - slice); bestK = k; }
    if (bestK < 0) return null;
    lo = hi = bestK;
  }
  while (lo - 1 >= 0 && bright(means[lo - 1])) lo--;
  while (hi + 1 < N && bright(means[hi + 1])) hi++;
  const run = hi - lo + 1;
  const step = series.sliceSpacing || series.sliceThickness || 1;
  return { d3Mm: run * step, sliceRun: run, threshold: thr, means };
}

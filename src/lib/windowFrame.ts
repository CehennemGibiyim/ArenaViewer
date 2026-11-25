/**
 * Pencereleme (WL/WW) çerçevesi — paylaşılan hesap (v-perf).
 *
 * Aynı dönüşüm üç yolda da birebir aynı olmalı:
 *   1. ana iş parçacığı (`window.windowToRGBA`),
 *   2. Web Worker (`src/workers/window.worker.ts`), GPU yoksa/başarısızsa,
 *   3. WebGL2 gölgelendiricisi (`src/lib/webglWindow.ts`).
 * Bu yüzden indeks → gri eşlemesi burada tek fonksiyonda tanımlanır ve
 * gölgelendirici aynı aritmetiği taklit eder.
 */

import { buildWindowLUT, windowToRGBA } from "./window";
import type { Pixels } from "./types";

export interface WindowFrameInput {
  wl: number;
  ww: number;
  invert: boolean;
}

/**
 * Pencere içi tamsayı indeksinden gri seviyesi (0–255).
 *
 * `buildWindowLUT` ile aynı: t >= span → 255, aksi hâlde trunc(t·255/span).
 * Gölgelendirici bu formülü birebir uygular; testler ikisini karşılaştırır.
 */
export function windowGrayFromIndex(t: number, span: number, invert = false): number {
  const s = Math.max(1, span);
  if (t <= 0) return invert ? 255 : 0;
  const g = t >= s ? 255 : Math.min(255, Math.trunc(t * (255 / s)));
  return invert ? 255 - g : g;
}

/** Tek piksel için referans gri değeri (GPU öz-testi ve testler). */
export function windowSampleGray(v: number, wl: number, ww: number, invert = false): number {
  const span = Math.max(1, ww);
  const lo = wl - span / 2;
  return windowGrayFromIndex((v - lo) | 0, span, invert);
}

/** Kesitin tamamını RGBA'ya çevirir (worker ve ana iş parçacığı ortak yolu). */
export function renderWindowFrame(
  pixels: Pixels | ArrayLike<number>,
  wl: number,
  ww: number,
  invert: boolean,
  out?: Uint32Array,
): Uint32Array {
  const { lut, lo } = buildWindowLUT(wl, ww, invert);
  return windowToRGBA(pixels, lut, lo, out);
}

/**
 * Worker'a devretme eşiği (~1 MP): küçük görüntülerde mesaj kopyalama maliyeti
 * kazancı aşar; büyük CR/DR ve ince BT serilerinde ana iş parçacığı boş kalır.
 */
export const WINDOW_WORKER_MIN_PIXELS = 1_000_000;

/** GPU'ya uygunluk: gölgelendirici tamsayı indeks kullanır (WL−WW/2 tam sayı). */
export function gpuWindowCompatible(wl: number, ww: number): boolean {
  const span = Math.max(1, ww);
  const lo = wl - span / 2;
  return Number.isInteger(span) && Number.isInteger(lo) && Math.abs(lo) < 1_000_000;
}

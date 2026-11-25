/**
 * Fotometrik yorum (Photometric Interpretation) yardımcıları — `f-pixel`.
 *
 * DICOM renkli görüntülerde piksel verisi farklı düzenlerde gelir:
 *  - **MONOCHROME1/2**: tek örnek (gri). MONOCHROME1'de düşük değer beyazdır.
 *  - **RGB / YBR_FULL / YBR_FULL_422 / YBR_PARTIAL_422 / YBR_PARTIAL_420**: 3 örnek;
 *    YBR olanlar önce RGB'ye çevrilir. 4:2:2/4:2:0'da renk örnekleri yatay/dikey
 *    olarak seyreltilmiştir (piksel başına 2 ya da 1,5 bayt).
 *  - **PALETTE COLOR**: 1 örnek + (0028,1101–1103)/(0028,1201–1203) LUT tablosu.
 *  - **Planar Configuration = 1**: R/G/B düzlemleri art arda (piksel değil düzlem sıralı).
 *
 * Bu modül saf fonksiyonlardır; DICOM ayrıştırıcı (`dicom.ts`) buradan çağırır ve
 * testler doğrudan bu fonksiyonları sınar. Çıktı her zaman **32-bit RGBA**
 * (`0xAABBGGRR`) tamponudur — görüntüleyici tuvali doğrudan bu tamponu yazar.
 */
import type { PaletteColorLUT } from "./types";

/** Renkli mi? (3 örnek ya da palet) */
export function isColorPhotometric(photometric: string, samples: number): boolean {
  return samples >= 3 || photometric === "PALETTE COLOR";
}

/** 4:2:2 / 4:2:0 seyreltilmiş mi? */
export function isSubsampled(photometric: string): boolean {
  return /_422$|_420$/.test(photometric);
}

/** YBR ailesi mi? */
export function isYbr(photometric: string): boolean {
  return photometric.startsWith("YBR");
}

/** Dar aralıklı (partial range) YBR mi? (JPEG/native 4:2:2 çoğunlukla partial) */
export function isPartialRange(photometric: string): boolean {
  return photometric.includes("PARTIAL") || photometric.includes("422") || photometric.includes("420");
}

/** 16 bit renk değerini 8 bite indirger (bitsStored 8 ise dokunmaz). */
export function scaleTo8(v: number, bitsStored = 8): number {
  if (!(v > 0)) return 0;
  const shift = Math.max(0, Math.min(8, (bitsStored || 8) - 8));
  const x = shift > 0 ? v / (1 << shift) : v;
  return Math.max(0, Math.min(255, Math.round(x)));
}

/**
 * YBR → RGB. `full` = Y/Cb/Cr tam aralıklı (0–255); partial'da Y 16–235,
 * Cb/Cr 16–240 aralığındadır (BT.601).
 */
export function ybrToRgb(y: number, cb: number, cr: number, partial = false): [number, number, number] {
  let r: number, g: number, b: number;
  if (partial) {
    const yy = Math.max(0, Math.min(255, (y - 16) * 1.164));
    const cbb = cb - 128, crr = cr - 128;
    r = yy + 1.596 * crr;
    g = yy - 0.813 * crr - 0.391 * cbb;
    b = yy + 2.018 * cbb;
  } else {
    const cbb = cb - 128, crr = cr - 128;
    r = y + 1.402 * crr;
    g = y - 0.344136 * cbb - 0.714136 * crr;
    b = y + 1.772 * cbb;
  }
  return [Math.max(0, Math.min(255, Math.round(r))), Math.max(0, Math.min(255, Math.round(g))), Math.max(0, Math.min(255, Math.round(b)))];
}

/** Planar (düzlem sıralı) veriyi piksel sıralı hâle getirir. */
export function deplanarize<T extends ArrayLike<number>>(
  src: T,
  pixels: number,
  samples: number,
  out?: Float32Array | Uint8Array | Uint16Array
): ArrayLike<number> {
  if (samples < 2) return src;
  const dst = out ?? new Uint8Array(pixels * samples);
  for (let s = 0; s < samples; s++) {
    const base = s * pixels;
    for (let i = 0; i < pixels; i++) dst[i * samples + s] = src[base + i];
  }
  return dst;
}

/**
 * Native (sıkıştırılmamış) 8 bit 4:2:2 / 4:2:0 veriyi Y,Cb,Cr üçlülerine açar.
 * 4:2:2: 4 bayt = 2 piksel (Y0,Cb,Y1,Cr). 4:2:0: 6 bayt = 4 piksel (Y0..Y3,Cb,Cr).
 */
export function upsampleSubsampled(src: ArrayLike<number>, pixels: number, rows420 = false): Uint8Array {
  const out = new Uint8Array(pixels * 3);
  if (!rows420) {
    for (let i = 0; i < pixels; i += 2) {
      const o = i * 2;
      const y0 = src[o] ?? 0, cb = src[o + 1] ?? 128, y1 = src[o + 2] ?? y0, cr = src[o + 3] ?? 128;
      out[i * 3] = y0; out[i * 3 + 1] = cb; out[i * 3 + 2] = cr;
      if (i + 1 < pixels) { out[(i + 1) * 3] = y1; out[(i + 1) * 3 + 1] = cb; out[(i + 1) * 3 + 2] = cr; }
    }
    return out;
  }
  // 4:2:0: her 2×2 blok için tek Cb/Cr çifti (bayt sayısı: 4 Y + 1 Cb + 1 Cr = 6)
  for (let p = 0; p < pixels; p += 4) {
    const o = (p / 4) * 6;
    const cb = src[o + 4] ?? 128, cr = src[o + 5] ?? 128;
    for (let k = 0; k < 4 && p + k < pixels; k++) {
      out[(p + k) * 3] = src[o + k] ?? 0;
      out[(p + k) * 3 + 1] = cb;
      out[(p + k) * 3 + 2] = cr;
    }
  }
  return out;
}

export interface ColorOptions {
  photometric: string;
  /** Örnek başına bit (8 ya da 16) */
  bitsStored?: number;
  /** YBR ise RGB'ye çevir (JPEG codec RGB veriyorsa false) */
  convertYbr?: boolean;
}

/**
 * Piksel sıralı renk verisini 32-bit RGBA tamponuna çevirir.
 * `raw` 3 örnek/piksel içermelidir.
 */
export function colorToRgba(raw: ArrayLike<number>, pixels: number, opts: ColorOptions): Uint32Array {
  const rgba = new Uint32Array(pixels);
  const bits = opts.bitsStored ?? 8;
  const ybr = (opts.convertYbr ?? true) && isYbr(opts.photometric);
  const partial = ybr && isPartialRange(opts.photometric);
  for (let i = 0; i < pixels; i++) {
    let r = scaleTo8(raw[i * 3], bits);
    let g = scaleTo8(raw[i * 3 + 1], bits);
    let b = scaleTo8(raw[i * 3 + 2], bits);
    if (ybr) [r, g, b] = ybrToRgb(r, g, b, partial);
    rgba[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return rgba;
}

/** PALETTE COLOR: indeks → RGBA (firstMapped ofseti ve 8/16-bit LUT destekli). */
export function paletteToRgba(indices: ArrayLike<number>, lut: PaletteColorLUT): Uint32Array {
  const rgba = new Uint32Array(indices.length);
  const n = Math.max(1, lut.numEntries);
  for (let i = 0; i < indices.length; i++) {
    const mapped = Math.max(0, Math.min(n - 1, (indices[i] | 0) - lut.firstMapped));
    const r = lut.r[mapped] ?? 0, g = lut.g[mapped] ?? 0, b = lut.b[mapped] ?? 0;
    const r8 = lut.bits === 16 ? Math.min(255, Math.round(r / 256)) : r;
    const g8 = lut.bits === 16 ? Math.min(255, Math.round(g / 256)) : g;
    const b8 = lut.bits === 16 ? Math.min(255, Math.round(b / 256)) : b;
    rgba[i] = 0xff000000 | (b8 << 16) | (g8 << 8) | r8;
  }
  return rgba;
}

/**
 * MONOCHROME1 → MONOCHROME2: `k = max + min`, `v' = k − v`.
 * Görüntüleyici her yerde MONOCHROME2 (düşük = siyah) varsayar; ters çevirme
 * pencere/ölçüm öncesinde, tüm kesitler için **tek** sabit ile yapılır (kesitler
 * arasında parlaklık sıçraması olmaması için).
 */
export function monochrome1Invert<T extends ArrayLike<number>>(frames: T[]): { k: number; frames: T[] } {
  let mn = Infinity, mx = -Infinity;
  for (const f of frames) for (let i = 0; i < f.length; i++) { const v = f[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return { k: 0, frames };
  const k = mx + mn;
  const out = frames.map((f) => {
    const Ctor = (f as unknown as { constructor: new (n: number) => T }).constructor;
    const dst = new Ctor(f.length);
    for (let i = 0; i < f.length; i++) (dst as unknown as number[])[i] = k - f[i];
    return dst;
  });
  return { k, frames: out };
}

/** Görüntüleyicide gösterilecek kısa fotometri etiketi. */
export function photometricLabel(photometric: string, samples: number): string {
  if (photometric === "PALETTE COLOR") return "Palet renkli";
  if (samples >= 3) {
    if (isYbr(photometric)) return `${photometric} (renkli)`;
    return "RGB (renkli)";
  }
  return photometric === "MONOCHROME1" ? "MONOCHROME1 (ters)" : photometric === "MONOCHROME2" ? "MONOCHROME2" : photometric || "—";
}

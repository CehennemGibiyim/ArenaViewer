/**
 * Sıkıştırılmamış **gri** piksel verisinin çözülmesi (v-perf).
 *
 * Amaç: CT/MR gibi tek örnekli (grayscale), sıkıştırılmamış serilerde kesit
 * başına yapılan sayısal işi (bayt→örnek, endian çevirme, Bits Stored maskesi/
 * işaret, Rescale Slope/Intercept, kompakt tipe paketleme) **Web Worker**'a
 * taşıyabilmek. Bu dosyadaki `decodeGrayNative` hem ana iş parçacığı yedeği hem
 * de worker kaynağının (`pixelWorker.ts`) doğruluk referansıdır; ikisi arasındaki
 * bit eşdeğerliği `tests/pixel-worker.test.ts` içinde `node:vm` ile sabitlenir.
 *
 * Kapsam sınırı (dürüst): yalnız 8/16 bit, tek örnek, sıkıştırılmamış (native)
 * çerçeveler. Kapsüllenmiş (JPEG/JLS/J2K/RLE) veri, PALETTE COLOR, planar ve
 * çok örnekli (RGB/YBR) çerçeveler bu yoldan geçmez — onlar eskisi gibi ana iş
 * parçacığında çözülür.
 */
import type { Pixels } from "./types";

export interface GrayNativeParams {
  rows: number;
  cols: number;
  /** 8 veya 16. */
  bitsAllocated: number;
  /** Etkin bit sayısı (maskesi); Bits Stored. */
  bitsStored: number;
  /** 0 = işaretsiz, 1 = işaretli (Pixel Representation). */
  pixelRep: number;
  /** Explicit VR Big Endian aktarım sözdizimi. */
  bigEndian: boolean;
  slope: number;
  intercept: number;
}

export type PixelsKind = "i16" | "u16" | "f32";

export interface GrayDecodeResult {
  pixels: Pixels;
  kind: PixelsKind;
  min: number;
  max: number;
}

/**
 * `Float32Array` değerlerini `packPixels` ile aynı kurallarla kompakt tipe paketler:
 * tam sayı ve Int16 aralığında → Int16, tam sayı ve Uint16 aralığında → Uint16,
 * aksi hâlde Float32.
 */
export function packFloatLike(f: Float32Array): { pixels: Pixels; kind: PixelsKind; min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  let integral = true;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (integral && v !== Math.round(v)) integral = false;
  }
  if (integral && min >= -32768 && max <= 32767) {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) o[i] = f[i];
    return { pixels: o, kind: "i16", min, max };
  }
  if (integral && min >= 0 && max <= 65535) {
    const o = new Uint16Array(f.length);
    for (let i = 0; i < f.length; i++) o[i] = f[i];
    return { pixels: o, kind: "u16", min, max };
  }
  return { pixels: f, kind: "f32", min, max };
}

/**
 * Tek bir native gri çerçeveyi çözer.
 * `bytes[offset … offset+rows*cols*bytesPer)` aralığı okunur; dizi dışına taşan
 * çerçeve için `null` döner (çağıran o çerçeveyi atlar — sessiz bozulma yok).
 */
export function decodeGrayNative(bytes: Uint8Array, offset: number, p: GrayNativeParams): GrayDecodeResult | null {
  const n = p.rows * p.cols;
  if (n <= 0) return null;
  if (p.bitsAllocated !== 8 && p.bitsAllocated !== 16) return null;
  const bytesPer = p.bitsAllocated >> 3;
  const end = offset + n * bytesPer;
  if (offset < 0 || end > bytes.length) return null;

  const out = new Float32Array(n);
  const slope = p.slope;
  const intercept = p.intercept;

  if (bytesPer === 1) {
    // 8 bitte mevcut ana iş parçacığı yolu (Uint8Array → slope/intercept) aynen korunur:
    // maskeleme yalnız 16 bitlik yolda yapılır (davranış eşitliği bilinçli).
    for (let i = 0; i < n; i++) out[i] = bytes[offset + i] * slope + intercept;
  } else {
    const shift32 = 32 - p.bitsStored;
    const mask = p.bitsStored >= 32 ? 0xffffffff : (1 << p.bitsStored) - 1;
    const signed = p.pixelRep === 1;
    const maskBits = p.bitsStored < 16;
    for (let i = 0; i < n; i++) {
      const lo = bytes[offset + i * 2];
      const hi = bytes[offset + i * 2 + 1];
      // Little endian okuma; big endian aktarımda baytlar yer değiştirir.
      const raw = p.bigEndian ? (lo << 8) | hi : lo | (hi << 8);
      let v: number;
      if (maskBits) v = signed ? (raw << shift32) >> shift32 : raw & mask;
      else v = signed ? (raw << 16) >> 16 : raw;
      out[i] = v * slope + intercept;
    }
  }
  const packed = packFloatLike(out);
  return { pixels: packed.pixels, kind: packed.kind, min: packed.min, max: packed.max };
}

/** Çerçeve sayısına göre bayt aralığı (native gri: rows*cols*bytesPer). */
export function grayFrameBytes(p: GrayNativeParams): number {
  return p.rows * p.cols * (p.bitsAllocated >> 3);
}

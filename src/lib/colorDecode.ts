/**
 * Renkli (RGB / YBR ailesi / seyreltilmiş 4:2:2–4:2:0) **sıkıştırılmamış** çerçeve
 * çözümünün saf çekirdeği — v-perf.
 *
 * Neden ayrı modül: `photometric.ts` (ybrToRgb, upsampleSubsampled, scaleTo8) ve
 * `dicom.ts` (readNative + toPixels) arasındaki iş bölümü dağınıktı; worker'ın
 * birebir aynı aritmetiği çalıştırabilmesi için tek bir "saf" giriş noktası
 * gerekiyordu. Buradaki fonksiyon, `dicom.ts`'in renkli yolunun **aynı**
 * sonucunu üretir (bit eşdeğerliği `tests/color-worker.test.ts` ile sabitlenir):
 *
 *   1) 4:2:2 / 4:2:0 ise örnekleri yukarı örnekle (`upsampleSubsampled`)
 *   2) planarsa düzlemleri piksel sıralı hâle getir
 *   3) YBR ise RGB'ye çevir (`colorToRgba`)
 *   4) gri karşılık: Y (YBR) veya BT.601 parlaklık, `slope × v + intercept`
 *
 * Çıktı: 32-bit RGBA (`0xAABBGGRR`) + gri `Float32Array`. Kapsam dışı girişte
 * `null` — çağıran eşzamanlı yola düşer (davranış değişmez).
 */
import { colorToRgba, isSubsampled, isYbr, upsampleSubsampled } from "./photometric";

export interface ColorFrameParams {
  rows: number;
  cols: number;
  samples: number;
  bitsAllocated: number;
  bitsStored: number;
  /** Planar Configuration = 1 (düzlem sıralı) */
  planar: boolean;
  photometric: string;
  /** YBR→RGB dönüşümü yapılsın mı (kodek RGB verdiyse false) */
  convertYbr: boolean;
  slope: number;
  intercept: number;
  /** 16-bit örneklerde bayt sırası büyük sonlu mu */
  bigEndian?: boolean;
}

export interface ColorFrameResult {
  rgba: Uint32Array;
  gray: Float32Array;
  /** Piksel başına bayt (4:2:2 / 4:2:0 için seyreltilmiş değer) */
  bytesPerFrame: number;
}

/** Çerçevenin bayt uzunluğu (4:2:2 = 2, 4:2:0 = 1,5 bayt/piksel). */
export function colorFrameBytes(p: ColorFrameParams): number {
  const pixels = p.rows * p.cols;
  if (pixels <= 0) return 0;
  const bytesPer = p.bitsAllocated >> 3;
  if (bytesPer === 1 && p.samples === 3 && isSubsampled(p.photometric)) {
    const sub420 = /_420$/.test(p.photometric);
    return sub420 ? Math.ceil(pixels / 4) * 6 : Math.ceil(pixels / 2) * 4;
  }
  return pixels * p.samples * bytesPer;
}

/**
 * Ham baytlardan tek renkli çerçeve çözer. `bytes[offset … offset+bytesPerFrame)`
 * aralığı dışındaysa `null`.
 */
export function decodeColorFrame(bytes: Uint8Array, offset: number, p: ColorFrameParams): ColorFrameResult | null {
  const pixels = p.rows * p.cols;
  const bytesPerFrame = colorFrameBytes(p);
  if (pixels <= 0 || bytesPerFrame <= 0) return null;
  if (offset < 0 || offset + bytesPerFrame > bytes.length) return null;
  if (p.bitsAllocated !== 8 && p.bitsAllocated !== 16) return null;
  if (p.samples < 3) return null;

  const bytesPer = p.bitsAllocated >> 3;
  const sub = bytesPer === 1 && isSubsampled(p.photometric);
  let raw: Uint8Array | Uint16Array;
  if (sub) {
    const packed = bytes.subarray(offset, offset + bytesPerFrame);
    raw = upsampleSubsampled(packed as unknown as ArrayLike<number>, pixels, /_420$/.test(p.photometric));
  } else if (bytesPer === 1) {
    const frame = bytes.subarray(offset, offset + pixels * 3);
    raw = p.planar ? deplanar8(frame, pixels) : frame;
  } else {
    const n = pixels * 3;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, n * 2);
    const out = new Uint16Array(n);
    const le = !p.bigEndian;
    for (let i = 0; i < n; i++) out[i] = view.getUint16(i * 2, le);
    raw = p.planar ? deplanar16(out, pixels) : out;
  }

  const rgba = colorToRgba(raw as unknown as ArrayLike<number>, pixels, {
    photometric: p.photometric,
    bitsStored: p.bitsStored,
    convertYbr: p.convertYbr,
  });

  // Gri karşılık: dicom.ts `toPixels` ile aynı kural.
  const useY = p.convertYbr && p.photometric.startsWith("YBR");
  const gray = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const r = raw[i * 3];
    const lum = useY ? r : 0.299 * r + 0.587 * raw[i * 3 + 1] + 0.114 * raw[i * 3 + 2];
    gray[i] = lum * p.slope + p.intercept;
  }
  return { rgba, gray, bytesPerFrame };
}

/** Planar Configuration 1 (8 bit): RRR…GGG…BBB… → RGBRGB… */
export function deplanar8(src: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = src[i] ?? 0;
    out[i * 3 + 1] = src[pixels + i] ?? 0;
    out[i * 3 + 2] = src[2 * pixels + i] ?? 0;
  }
  return out;
}

/** Planar Configuration 1 (16 bit). */
export function deplanar16(src: Uint16Array, pixels: number): Uint16Array {
  const out = new Uint16Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = src[i] ?? 0;
    out[i * 3 + 1] = src[pixels + i] ?? 0;
    out[i * 3 + 2] = src[2 * pixels + i] ?? 0;
  }
  return out;
}

/** Bu çerçeve worker yoluna uygun mu? (kapsam kapısı — çağıran eşzamanlıya düşer) */
export function colorWorkerEligible(p: ColorFrameParams): boolean {
  if (p.rows * p.cols <= 0) return false;
  if (p.bitsAllocated !== 8 && p.bitsAllocated !== 16) return false;
  if (p.samples < 3) return false;
  if (p.photometric === "PALETTE COLOR") return false;
  if (!isYbr(p.photometric) && p.photometric !== "RGB") return false;
  return colorFrameBytes(p) > 0;
}

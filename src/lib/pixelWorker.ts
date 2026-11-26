/**
 * Piksel çözme Web Worker'ı (v-perf).
 *
 * `src/lib/pixelDecode.ts::decodeGrayNative` ile **aynı** aritmetiği kendi kendine
 * yeterli bir Blob worker içinde çalıştırır: bayt→örnek, endian, Bits Stored
 * maskesi/işareti, Rescale Slope/Intercept, kompakt tipe paketleme. Böylece
 * sıkıştırılmamış gri serilerin çözülmesi ana iş parçacığını meşgul etmez.
 *
 * Sözleşme:
 *  - Worker yok/başarısız (SSR, test, CSP, eski tarayıcı) → `null` döner, çağıran
 *    eşzamanlı `decodeGrayNative` yoluna düşer; **davranış değişmez**.
 *  - Dönen tampon `ArrayBuffer` olarak transfer edilir (kopya maliyeti yok).
 *  - Eşleşmeyen/hatalı yanıt bekleyen isteği `null` ile çözer (asılı kalmaz).
 *  - Worker kaynağı ile TS referansı arasındaki bit eşdeğerliği
 *    `tests/pixel-worker.test.ts` içinde `node:vm` ile doğrulanır.
 */
import { decodeGrayNative, type GrayDecodeResult, type GrayNativeParams, type PixelsKind } from "./pixelDecode";
import type { Pixels } from "./types";

/** Worker kaynağı — `decodeGrayNative` + `packFloatLike` aritmetiğinin birebir kopyası. */
export const PIXEL_WORKER_SOURCE = `function pack(f) {
  var min = Infinity, max = -Infinity, integral = true, i, v;
  for (i = 0; i < f.length; i++) {
    v = f[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (integral && v !== Math.round(v)) integral = false;
  }
  if (integral && min >= -32768 && max <= 32767) {
    var a = new Int16Array(f.length);
    for (i = 0; i < f.length; i++) a[i] = f[i];
    return { pixels: a, kind: "i16" };
  }
  if (integral && min >= 0 && max <= 65535) {
    var b = new Uint16Array(f.length);
    for (i = 0; i < f.length; i++) b[i] = f[i];
    return { pixels: b, kind: "u16" };
  }
  return { pixels: f, kind: "f32" };
}

function decode(bytes, offset, p) {
  var n = p.rows * p.cols;
  if (n <= 0) return null;
  if (p.bitsAllocated !== 8 && p.bitsAllocated !== 16) return null;
  var bytesPer = p.bitsAllocated >> 3;
  var end = offset + n * bytesPer;
  if (offset < 0 || end > bytes.length) return null;
  var out = new Float32Array(n);
  var slope = p.slope, intercept = p.intercept, i, raw, v;
  if (bytesPer === 1) {
    for (i = 0; i < n; i++) out[i] = bytes[offset + i] * slope + intercept;
  } else {
    var shift32 = 32 - p.bitsStored;
    var mask = p.bitsStored >= 32 ? 0xffffffff : (1 << p.bitsStored) - 1;
    var signed = p.pixelRep === 1;
    var maskBits = p.bitsStored < 16;
    for (i = 0; i < n; i++) {
      var lo = bytes[offset + i * 2];
      var hi = bytes[offset + i * 2 + 1];
      raw = p.bigEndian ? (lo << 8) | hi : lo | (hi << 8);
      if (maskBits) v = signed ? (raw << shift32) >> shift32 : raw & mask;
      else v = signed ? (raw << 16) >> 16 : raw;
      out[i] = v * slope + intercept;
    }
  }
  var packed = pack(out);
  return { pixels: packed.pixels, kind: packed.kind };
}

self.onmessage = function (e) {
  var d = e.data || {};
  var res;
  try {
    res = decode(d.bytes, d.offset, d.params);
  } catch (err) {
    self.postMessage({ id: d.id, error: String(err) });
    return;
  }
  if (!res) { self.postMessage({ id: d.id, outOfRange: true }); return; }
  self.postMessage({ id: d.id, kind: res.kind, buffer: res.pixels.buffer }, [res.pixels.buffer]);
};`;

interface Pending {
  resolve: (v: GrayDecodeResult | null) => void;
}

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
  try {
    const url = URL.createObjectURL(new Blob([PIXEL_WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { id?: number; kind?: PixelsKind; buffer?: ArrayBuffer; outOfRange?: boolean; error?: string } | null;
      if (!data || typeof data.id !== "number") return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.outOfRange || data.error || !data.buffer || !data.kind) { p.resolve(null); return; }
      const pixels = wrap(data.kind, data.buffer);
      p.resolve({ pixels, kind: data.kind, min: NaN, max: NaN });
    };
    w.onerror = () => {
      broken = true;
      worker = null;
      for (const [, p] of pending) p.resolve(null);
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    broken = true;
    return null;
  }
}

function wrap(kind: PixelsKind, buffer: ArrayBuffer): Pixels {
  if (kind === "i16") return new Int16Array(buffer);
  if (kind === "u16") return new Uint16Array(buffer);
  return new Float32Array(buffer);
}

/**
 * Worker'da çözer; worker yoksa **null** (çağıran `decodeGrayNative`'a düşer).
 * Baytlar kopyalanır: kaynak tampon ana iş parçacığında kalır (seri verisi
 * transfer edilip kullanılamaz hâle gelmez).
 */
export function decodeGrayNativeAsync(
  bytes: Uint8Array,
  offset: number,
  params: GrayNativeParams
): Promise<GrayDecodeResult | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const copy = bytes.slice(offset, offset + params.rows * params.cols * (params.bitsAllocated >> 3));
  const id = ++seq;
  return new Promise<GrayDecodeResult | null>((resolve) => {
    pending.set(id, { resolve });
    try {
      w.postMessage({ id, bytes: copy, offset: 0, params });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Worker kurulabiliyor mu? Bir kez kurar (tembel); `false` ise çağıran doğrudan
 * eşzamanlı yolu kullanır — çerçeve başına gereksiz promise üretilmez.
 */
export function pixelWorkerReady(): boolean {
  return !!ensureWorker();
}

/** Çözme için worker yolu var mı (tanılama/test). */
export function pixelWorkerActive(): boolean {
  return !!worker;
}

export function disposePixelWorker(): void {
  if (worker) { worker.terminate(); worker = null; }
  for (const [, p] of pending) p.resolve(null);
  pending.clear();
}

export function resetPixelWorkerForTests(): void {
  disposePixelWorker();
  broken = false;
  seq = 0;
}

/** Ana iş parçacığı yedeği (worker'sız ortamlar ve test referansı). */
export function decodeGrayNativeSync(bytes: Uint8Array, offset: number, params: GrayNativeParams): GrayDecodeResult | null {
  return decodeGrayNative(bytes, offset, params);
}

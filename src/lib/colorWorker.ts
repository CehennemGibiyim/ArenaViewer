/**
 * Renkli çerçeve çözme Web Worker'ı (v-perf).
 *
 * `colorDecode.ts::decodeColorFrame` ile **aynı** aritmetiği kendi kendine yeterli
 * bir Blob worker içinde çalıştırır: 4:2:2/4:2:0 yukarı örnekleme, planar → piksel
 * sıralı, YBR→RGB (`ybrToRgb`), 16-bit endian, gri karşılık (Y veya BT.601).
 * Böylece renkli serilerin çözülmesi ana iş parçacığını meşgul etmez.
 *
 * Sözleşme (pixelWorker ile aynı):
 *  - Worker yok/başarısız (SSR, CSP, eski tarayıcı) → `null`, çağıran eşzamanlı
 *    `decodeColorFrame` yoluna düşer; **davranış değişmez**.
 *  - RGBA ve gri tamponlar `ArrayBuffer` olarak transfer edilir (kopya yok).
 *  - Kapsam dışı/aralık hatası → `{ rejected: true }` (sessiz yanlış yok).
 *  - Bit eşdeğerliği `tests/color-worker.test.ts` içinde `node:vm` ile sabitlenir.
 */
import { colorFrameBytes, type ColorFrameParams } from "./colorDecode";

/** Worker kaynağı — `colorDecode.ts` aritmetiğinin birebir kopyası (bağımlılıksız). */
export const COLOR_WORKER_SOURCE = `
function scaleTo8(v, bits) {
  if (!(v > 0)) return 0;
  var shift = Math.max(0, Math.min(8, (bits || 8) - 8));
  var x = shift > 0 ? v / (1 << shift) : v;
  return Math.max(0, Math.min(255, Math.round(x)));
}
function ybrToRgb(y, cb, cr, partial) {
  var r, g, b, yy, cbb, crr;
  if (partial) {
    yy = Math.max(0, Math.min(255, (y - 16) * 1.164));
    cbb = cb - 128; crr = cr - 128;
    r = yy + 1.596 * crr;
    g = yy - 0.813 * crr - 0.391 * cbb;
    b = yy + 2.018 * cbb;
  } else {
    cbb = cb - 128; crr = cr - 128;
    r = y + 1.402 * crr;
    g = y - 0.344136 * cbb - 0.714136 * crr;
    b = y + 1.772 * cbb;
  }
  return [Math.max(0, Math.min(255, Math.round(r))), Math.max(0, Math.min(255, Math.round(g))), Math.max(0, Math.min(255, Math.round(b)))];
}
function isYbr(p) { return p.indexOf("YBR") === 0; }
function isPartialRange(p) { return p.indexOf("PARTIAL") >= 0 || p.indexOf("422") >= 0 || p.indexOf("420") >= 0; }
function isSubsampled(p) { return /_422$|_420$/.test(p); }
function upsample(src, pixels, rows420) {
  var out = new Uint8Array(pixels * 3), i, o, y0, cb, cr, y1, k, p;
  if (!rows420) {
    for (i = 0; i < pixels; i += 2) {
      o = i * 2;
      y0 = src[o] === undefined ? 0 : src[o];
      cb = src[o + 1] === undefined ? 128 : src[o + 1];
      y1 = src[o + 2] === undefined ? y0 : src[o + 2];
      cr = src[o + 3] === undefined ? 128 : src[o + 3];
      out[i * 3] = y0; out[i * 3 + 1] = cb; out[i * 3 + 2] = cr;
      if (i + 1 < pixels) { out[(i + 1) * 3] = y1; out[(i + 1) * 3 + 1] = cb; out[(i + 1) * 3 + 2] = cr; }
    }
    return out;
  }
  for (p = 0; p < pixels; p += 4) {
    o = (p / 4) * 6;
    cb = src[o + 4] === undefined ? 128 : src[o + 4];
    cr = src[o + 5] === undefined ? 128 : src[o + 5];
    for (k = 0; k < 4 && p + k < pixels; k++) {
      out[(p + k) * 3] = src[o + k] === undefined ? 0 : src[o + k];
      out[(p + k) * 3 + 1] = cb;
      out[(p + k) * 3 + 2] = cr;
    }
  }
  return out;
}
function bytesOf(p) {
  var pixels = p.rows * p.cols;
  if (pixels <= 0) return 0;
  var per = p.bitsAllocated >> 3;
  if (per === 1 && p.samples === 3 && isSubsampled(p.photometric)) {
    return /_420$/.test(p.photometric) ? Math.ceil(pixels / 4) * 6 : Math.ceil(pixels / 2) * 4;
  }
  return pixels * p.samples * per;
}
function decode(bytes, offset, p) {
  var pixels = p.rows * p.cols;
  var bytesPerFrame = bytesOf(p);
  if (pixels <= 0 || bytesPerFrame <= 0) return null;
  if (offset < 0 || offset + bytesPerFrame > bytes.length) return null;
  if (p.bitsAllocated !== 8 && p.bitsAllocated !== 16) return null;
  if (p.samples < 3) return null;
  if (p.photometric === "PALETTE COLOR") return null;
  var per = p.bitsAllocated >> 3, raw, i, n, k, out16, dv, le;
  if (per === 1 && isSubsampled(p.photometric)) {
    raw = upsample(bytes.subarray(offset, offset + bytesPerFrame), pixels, /_420$/.test(p.photometric));
  } else if (per === 1) {
    var frame = bytes.subarray(offset, offset + pixels * 3);
    if (p.planar) {
      raw = new Uint8Array(pixels * 3);
      for (i = 0; i < pixels; i++) {
        raw[i * 3] = frame[i] === undefined ? 0 : frame[i];
        raw[i * 3 + 1] = frame[pixels + i] === undefined ? 0 : frame[pixels + i];
        raw[i * 3 + 2] = frame[2 * pixels + i] === undefined ? 0 : frame[2 * pixels + i];
      }
    } else raw = frame;
  } else {
    n = pixels * 3;
    dv = new DataView(bytes.buffer, bytes.byteOffset + offset, n * 2);
    le = !p.bigEndian;
    out16 = new Uint16Array(n);
    for (i = 0; i < n; i++) out16[i] = dv.getUint16(i * 2, le);
    if (p.planar) {
      raw = new Uint16Array(n);
      for (i = 0; i < pixels; i++) {
        raw[i * 3] = out16[i]; raw[i * 3 + 1] = out16[pixels + i]; raw[i * 3 + 2] = out16[2 * pixels + i];
      }
    } else raw = out16;
  }
  var bits = p.bitsStored || 8;
  var ybr = p.convertYbr && isYbr(p.photometric);
  var partial = ybr && isPartialRange(p.photometric);
  var rgba = new Uint32Array(pixels);
  for (i = 0; i < pixels; i++) {
    var r = scaleTo8(raw[i * 3], bits), g = scaleTo8(raw[i * 3 + 1], bits), b = scaleTo8(raw[i * 3 + 2], bits);
    var c;
    if (ybr) { c = ybrToRgb(r, g, b, partial); r = c[0]; g = c[1]; b = c[2]; }
    rgba[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  var useY = p.convertYbr && isYbr(p.photometric);
  var gray = new Float32Array(pixels);
  for (i = 0; i < pixels; i++) {
    var lum = useY ? raw[i * 3] : 0.299 * raw[i * 3] + 0.587 * raw[i * 3 + 1] + 0.114 * raw[i * 3 + 2];
    gray[i] = lum * p.slope + p.intercept;
  }
  return { rgba: rgba, gray: gray };
}
self.onmessage = function (ev) {
  var d = ev && ev.data;
  if (!d) return;
  try {
    var res = decode(d.bytes, d.offset || 0, d.params);
    if (!res) { self.postMessage({ id: d.id, rejected: true }); return; }
    self.postMessage({ id: d.id, rgba: res.rgba.buffer, gray: res.gray.buffer }, [res.rgba.buffer, res.gray.buffer]);
  } catch (e) {
    self.postMessage({ id: d.id, error: String(e && e.message ? e.message : e) });
  }
};
`;

export interface ColorFrameResultBuffers {
  rgba: Uint32Array;
  gray: Float32Array;
}

interface Pending { resolve: (v: ColorFrameResultBuffers | null) => void }

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
  try {
    const url = URL.createObjectURL(new Blob([COLOR_WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { id?: number; rgba?: ArrayBuffer; gray?: ArrayBuffer; rejected?: boolean; error?: string } | null;
      if (!data || typeof data.id !== "number") return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.rejected || data.error || !data.rgba || !data.gray) { p.resolve(null); return; }
      p.resolve({ rgba: new Uint32Array(data.rgba), gray: new Float32Array(data.gray) });
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

/** Çözme için worker yolu var mı? (tembel kurulum; false → eşzamanlı yol) */
export function colorWorkerReady(): boolean {
  return !!ensureWorker();
}

/**
 * Worker'da çözer; worker yoksa/başarısızsa `null` (çağıran `decodeColorFrame`'a düşer).
 * Baytlar kopyalanır — kaynak tampon ana iş parçacığında erişilebilir kalır.
 */
export function decodeColorFrameAsync(
  bytes: Uint8Array,
  offset: number,
  params: ColorFrameParams,
): Promise<ColorFrameResultBuffers | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const len = colorFrameBytes(params);
  if (len <= 0 || offset < 0 || offset + len > bytes.length) return Promise.resolve(null);
  const copy = bytes.slice(offset, offset + len);
  const id = ++seq;
  return new Promise<ColorFrameResultBuffers | null>((resolve) => {
    pending.set(id, { resolve });
    try {
      w.postMessage({ id, bytes: copy, offset: 0, params });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

export function colorWorkerActive(): boolean {
  return !!worker;
}

export function disposeColorWorker(): void {
  if (worker) { worker.terminate(); worker = null; }
  for (const [, p] of pending) p.resolve(null);
  pending.clear();
}

/** Testler için: worker'ı bırak ve "bozuk" işaretini temizle. */
export function resetColorWorkerForTests(): void {
  disposeColorWorker();
  broken = false;
}

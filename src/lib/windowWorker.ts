/**
 * Pencereleme (LUT uygulama) işini **Web Worker**'a taşıyan ince köprü (v-perf).
 *
 * Neden: 2 MP'lik gri bir kesitte LUT uygulaması ~10–25 ms ana iş parçacığı zamanı
 * yer; komşu kesit ön-işleme (±2 kesit) bunu 4 ile çarpar ve kaydırma sırasında
 * kare düşmesine yol açar. Burada yalnız **piksel→RGBA** dönüşümü worker'da yapılır;
 * `ImageData`/`putImageData` tarayıcı kuralı gereği ana iş parçacığında kalır.
 *
 * Tasarım:
 *  - Worker kaynağı **kendi kendine yeterli** bir metindir (`WINDOW_WORKER_SOURCE`) ve
 *    Blob URL ile kurulur; bundler'a bağımlı değildir. Metin ile `windowToRGBA`
 *    arasındaki eşdeğerlik `tests/window-worker.test.ts` içinde byte-byte doğrulanır
 *    (worker kaynağı `node:vm` ile çalıştırılıp gerçek LUT/palet ile karşılaştırılır).
 *  - Worker yoksa (SSR, test, eski tarayıcı, CSP) çağrı `null` döner ve çağıran
 *    ana iş parçacığı yoluna düşer — davranış değişmez.
 *  - Kuyruk tek worker üzerinden sıralıdır; her istek kimlikle eşlenir, worker
 *    hatası/ölümü bekleyen istekleri reddeder (sessiz asılı kalmaz).
 */
import { GRAY_PALETTE, buildWindowLUT, windowToRGBA } from "./window";

/** Worker kaynağı: `windowToRGBA` ile birebir aynı aritmetik (testle sabitlenir). */
export const WINDOW_WORKER_SOURCE = `self.onmessage = function (e) {
  var d = e.data || {};
  var src = d.pixels, lut = d.lut, lo = d.lo;
  var out = new Uint32Array(src.length);
  var top = lut.length - 1;
  for (var i = 0; i < src.length; i++) {
    var t = (src[i] - lo) | 0;
    if (t < 0) t = 0; else if (t > top) t = top;
    var g = lut[t];
    out[i] = 0xff000000 | (g << 16) | (g << 8) | g;
  }
  self.postMessage({ id: d.id, out: out }, [out.buffer]);
};`;

/** Ana iş parçacığı yolu (worker yoksa/başarısızsa kullanılan yedek). */
export function windowSliceSync(src: ArrayLike<number>, wl: number, ww: number, invert: boolean): Uint32Array {
  const { lut, lo } = buildWindowLUT(wl, ww, invert);
  return windowToRGBA(src, lut, lo);
}

interface Pending {
  resolve: (v: Uint32Array | null) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Pending>();

/** Tarayıcıda bir kez kurulur; kurulamazsa null (ana iş parçacığı yolu). */
function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
  try {
    const blob = new Blob([WINDOW_WORKER_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { id?: number; out?: Uint32Array } | null;
      if (!data || typeof data.id !== "number") return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      p.resolve(data.out instanceof Uint32Array ? data.out : null);
    };
    w.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const [, p] of pending) p.resolve(null); // çağıran yedeğe düşer
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/**
 * Kesiti worker'da pencereler. Worker yoksa **null** döner (çağıran eşzamanlı yola
 * düşmelidir); böylece davranış hiçbir ortamda bozulmaz.
 */
export function windowSliceAsync(src: ArrayLike<number>, wl: number, ww: number, invert: boolean): Promise<Uint32Array | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  // Pikseller kopyalanır (transfer edilmez): seri belleği ana iş parçacığında kalır.
  const pixels = src instanceof Int16Array ? new Int16Array(src) : Float32Array.from(src as ArrayLike<number>);
  const { lut, lo } = buildWindowLUT(wl, ww, invert);
  const id = ++seq;
  return new Promise<Uint32Array | null>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, pixels, lut, lo });
    } catch (e) {
      pending.delete(id);
      resolve(null);
      void e;
    }
  });
}

/** Test/kapatma için: worker'ı bırakır ve bekleyen istekleri yedeğe düşürür. */
export function disposeWindowWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, p] of pending) p.resolve(null);
  pending.clear();
}

/** Testlerin ortamı sıfırlayabilmesi için (worker desteği simülasyonu). */
export function resetWindowWorkerForTests(): void {
  disposeWindowWorker();
  workerBroken = false;
  seq = 0;
}

/** Worker aktif mi (tanılama/test). */
export function windowWorkerActive(): boolean {
  return !!worker;
}

/** Gri palet dışa aktarımı (worker'ın ürettiği RGBA ile aynı bit deseni). */
export function grayPaletteValue(g: number): number {
  return GRAY_PALETTE[Math.max(0, Math.min(255, g))];
}

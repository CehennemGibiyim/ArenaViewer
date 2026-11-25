/**
 * Worker istemcisi (v-perf): `renderWindowWorker` büyük kesitleri arka planda
 * çevirir; worker yoksa, hata verirse veya süre aşımı olursa aynı çerçeve ana
 * iş parçacığında hesaplanır. Böylece görüntü hiçbir durumda boş kalmaz.
 */
import { renderWindowFrame } from "./windowFrame";

type Pixels = Int16Array | Uint16Array | Float32Array;

interface Pending {
  resolve: (rgba: Uint32Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null | undefined;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(message: string) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") { worker = null; return null; }
  try {
    const w = new Worker(new URL("../workers/window.worker.ts", import.meta.url));
    w.onmessage = (e: MessageEvent<{ id: number; rgba: Uint8ClampedArray }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      const rgba = e.data.rgba;
      p.resolve(new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4));
    };
    w.onerror = () => { broken = true; failAll("pencere worker hatası"); w.terminate(); worker = null; };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Worker'ın bu ortamda kullanılabilir olup olmadığı (CSP/ SSR güvenli). */
export function windowWorkerSupported(): boolean {
  try {
    if (broken) return false;
    return getWorker() !== null;
  } catch {
    return false;
  }
}

/**
 * Kesiti worker'da pencereleyip RGBA döndürür. Hata/süre aşımında aynı sonucu
 * ana iş parçacığında hesaplar (söz reddedilmez; çağıran görüntüyü kaybetmez).
 */
export function renderWindowWorker(
  pixels: Pixels,
  wl: number,
  ww: number,
  invert: boolean,
  timeoutMs = 2500,
): Promise<Uint32Array> {
  const w = getWorker();
  if (!w) return Promise.resolve(renderWindowFrame(pixels, wl, ww, invert));
  const id = ++seq;
  // Piksel dizisi transfer edilirse seri verisi sahipsiz kalır: kopyala.
  const copy = pixels.slice() as Pixels;
  return new Promise<Uint32Array>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(renderWindowFrame(pixels, wl, ww, invert));
    }, timeoutMs);
    pending.set(id, {
      resolve: (rgba) => resolve(rgba),
      reject: () => resolve(renderWindowFrame(pixels, wl, ww, invert)),
      timer,
    });
    try {
      w.postMessage({ id, pixels: copy, wl, ww, invert }, [copy.buffer]);
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(renderWindowFrame(pixels, wl, ww, invert));
    }
  });
}

/** Test/teardown için: worker'ı kapatır (paylaşılan tekil). */
export function disposeWindowWorker(): void {
  failAll("worker kapatıldı");
  worker?.terminate();
  worker = undefined;
}

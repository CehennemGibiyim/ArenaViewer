/**
 * Sıkıştırılmış DICOM kareleri için client tarafı Web Worker köprüsü (v-perf).
 *
 * Akış: kapsüllenmiş piksel verisi olan kareler `public/codecs/codecWorker.bundle.js`
 * klasik worker'ında çözülür (`scripts/build-codec-worker.mjs` ile üretilir ve
 * commit edilir — Turbopack/webpack `new Worker(new URL(...))` desenini güvenilir
 * biçimde derlemez, statik dosya her ortamda aynı çalışır). Worker yok/başarısız
 * (SSR, test, CSP, eski tarayıcı, 404) → `null` döner,
 * `codecs.ts::decodeEncapsulatedFrames` eşzamanlı yoluna düşülür; **davranış değişmez**.
 *
 * Dönen çerçeve buffer'ları transfer edilir (kopya maliyeti yok).
 * Eşleşmeyen/hatalı yanıt bekleyen isteği `null` ile çözer (asılı kalmaz).
 */
import {
  decodeEncapsulatedFrames,
  type FrameInfo,
  type RawFrame,
} from "./codecs";
import type { CodecJob, CodecJobResult } from "./codecWorker";
import { deserializeFrame } from "./codecWorker";
import type { DicomDataSet, DicomElement } from "dicom-parser";

interface Pending {
  resolve: (frames: RawFrame[] | null) => void;
}

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof URL === "undefined") return null;
  try {
    const w = new Worker(`${BASE}/codecs/codecWorker.bundle.js`);
    w.onmessage = (ev: MessageEvent<CodecJobResult>) => {
      const data = ev.data;
      if (!data || typeof data.id !== "number") return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ("error" in data) { p.resolve(null); return; }
      try {
        p.resolve(data.frames.map(deserializeFrame));
      } catch {
        p.resolve(null);
      }
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

/** Worker uygun/hazır mı? (yalnız bilgi/test amaçlı) */
export function codecWorkerReady(): boolean {
  return !broken && ensureWorker() !== null;
}

/** Worker'ı dener; başarısızsa `null` döner (bu durumda çağıran eşzamanlı yolu kullanır). */
export async function decodeEncapsulatedFramesAsync(
  ds: DicomDataSet,
  el: DicomElement,
  ts: string,
  info: FrameInfo
): Promise<RawFrame[] | null> {
  const w = ensureWorker();
  if (!w) return null;
  const job: CodecJob = {
    id: ++seq,
    byteArray: ds.byteArray, // postMessage zaten kopya çıkarır (transfer yok — ds ana iş parçacığında kullanılıyor)
    encapsulatedPixelData: !!el.encapsulatedPixelData,
    hadUndefinedLength: !!el.hadUndefinedLength,
    dataOffset: el.dataOffset,
    fragments: el.fragments?.map((f) => ({ offset: f.offset, position: f.position, length: f.length })),
    basicOffsetTable: el.basicOffsetTable ? Array.from(el.basicOffsetTable as ArrayLike<number>) : [],
    ts,
    info,
  };
  return new Promise<RawFrame[] | null>((resolve) => {
    pending.set(job.id, { resolve });
    try {
      w.postMessage(job);
    } catch {
      pending.delete(job.id);
      broken = true;
      resolve(null);
    }
  });
}

/**
 * Worker varsa onunla, yoksa eşzamanlı yolla çözer. Worker hatası/uyumsuzluğu
 * durumunda eşzamanlı yola düşer — görüntü kaybolmaz.
 */
export async function decodeEncapsulated(
  ds: DicomDataSet,
  el: DicomElement,
  ts: string,
  info: FrameInfo
): Promise<RawFrame[]> {
  const frames = await decodeEncapsulatedFramesAsync(ds, el, ts, info);
  if (frames) return frames;
  return decodeEncapsulatedFrames(ds, el, ts, info);
}

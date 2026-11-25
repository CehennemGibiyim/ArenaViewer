/// <reference lib="webworker" />
/**
 * WL/WW worker'ı (v-perf).
 *
 * Ana iş parçacığı 512×512 ve üstü kesitlerde WL/WW sürüklemesi sırasında
 * donar; dönüşüm burada yapılır ve sonuç `ImageData` için hazır `Uint32Array`
 * olarak **sahipliği aktarılarak** (zero-copy) geri gönderilir.
 *
 * Protokol (postMessage):
 *   → { type: "window", id, src: ArrayBuffer, kind: "float32"|"int16"|"uint16", wl, ww, invert }
 *   ← { type: "done", id, pixels: ArrayBuffer, ms }
 *   → { type: "cancel", id }        (yeni sürükleme olayı: eski istek düşer)
 *
 * Tampon aktarımı: `src` worker'a aktarılır; çağıran taraf kesiti yeniden
 * kullanacaksa kopyasını göndermelidir (`postMessage(..., [copy])`).
 */
import { buildWindowLUT, windowToRGBA } from "@/lib/window";
import { transcodeSlices, type SliceArray } from "@/lib/volumePerf";

interface WindowRequest {
  type: "window";
  id: number;
  src: ArrayBuffer;
  kind: "float32" | "int16" | "uint16";
  wl: number;
  ww: number;
  invert: boolean;
}

interface CancelRequest {
  type: "cancel";
  id: number;
}

let cancelled = new Set<number>();
/** Son sürüm kazanır: sürükleme sırasında eski istekler sonuç üretmeden düşer. */
let latestId = 0;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function view(src: ArrayBuffer, kind: WindowRequest["kind"]): SliceArray {
  if (kind === "int16") return new Int16Array(src);
  if (kind === "uint16") return new Uint16Array(src);
  return new Float32Array(src);
}

ctx.onmessage = (e: MessageEvent<WindowRequest | CancelRequest>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== "window") return;
  if (msg.id < latestId) {
    // Daha yeni bir istek var; bu sonucu kimse beklemiyor.
    return;
  }
  latestId = msg.id;

  const t0 = performance.now();
  const pixels = view(msg.src, msg.kind);
  const { lut, lo } = buildWindowLUT(msg.wl, msg.ww, msg.invert);
  const out = windowToRGBA(pixels, lut, lo);
  const ms = performance.now() - t0;

  if (cancelled.has(msg.id) || msg.id < latestId) {
    cancelled.delete(msg.id);
    return;
  }
  ctx.postMessage({ type: "done", id: msg.id, pixels: out.buffer, ms }, [out.buffer]);
};

/** Bir dizi kesiti toplu dönüştürür (kademeli ön getirme sırasında tek mesaj). */
export { transcodeSlices };

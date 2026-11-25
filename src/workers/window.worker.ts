/// <reference lib="webworker" />
/**
 * Pencereleme worker'ı (v-perf): büyük kesitlerin WL/WW → RGBA dönüşümü ana
 * iş parçacığından alınır. Girdi piksel kopyası transfer edilir (seri dizisi
 * sahipliği çağıranda kalır), çıktı RGBA tamponu sıfır kopyayla geri döner.
 */
import { renderWindowFrame } from "../lib/windowFrame";

interface FrameRequest {
  id: number;
  pixels: Int16Array | Uint16Array | Float32Array;
  wl: number;
  ww: number;
  invert: boolean;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<FrameRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { id, pixels, wl, ww, invert } = e.data;
  const u32 = renderWindowFrame(pixels, wl, ww, invert);
  ctx.postMessage({ id, rgba: new Uint8ClampedArray(u32.buffer) }, [u32.buffer]);
};

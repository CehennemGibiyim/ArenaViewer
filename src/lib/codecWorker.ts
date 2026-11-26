/**
 * Sıkıştırılmış DICOM karelerini Web Worker'da çözer (v-perf).
 *
 * `src/lib/codecs.ts::decodeEncapsulatedFrames` ile **aynı** kodu, modül worker
 * içinde çalıştırır (kendi kendine yeterli ayrı bir kopyası yoktur — worker tek
 * bir chunk'ta codecs.ts'i paketler). `src/lib/codecClient.ts` Worker desteği
 * yoksa/oluşturulamazsa/başarısızsa sessizce eşzamanlı yola düşer; davranış
 * değişmez.
 *
 * `self` yalnızca dinleyici kurulurken okunur; `runCodecJob` saf bir async
 * fonksiyon olarak dışa açılır ve testler doğrudan çağrır (node:vm gerekmez —
 * kod kopyası olmadığı için kopya kayması riski yoktur).
 */
import {
  decodeEncapsulatedFrames,
  type FrameInfo,
  type RawFrame,
} from "./codecs";
import {
  littleEndianByteArrayParser,
  bigEndianByteArrayParser,
  type DicomDataSet,
  type DicomElement,
} from "dicom-parser";

export interface CodecJobFragment {
  offset: number;
  position: number;
  length: number;
}

const TS_EXPLICIT_BE = "1.2.840.10008.1.2.2";

export interface CodecJob {
  id: number;
  /** Piksel verisini içeren dosyanın tamamı (worker'da yeniden kullanılır). */
  byteArray: Uint8Array;
  encapsulatedPixelData: boolean;
  hadUndefinedLength: boolean;
  /** Piksel Data elementinin bayt konumu (dicom-parser okuması için gerekli). */
  dataOffset: number;
  fragments?: CodecJobFragment[];
  basicOffsetTable?: number[];
  ts: string;
  info: FrameInfo;
}

export interface CodecJobSuccess {
  id: number;
  frames: { buffer: ArrayBuffer; kind: "u8" | "i16" | "u16"; length: number }[];
}
export interface CodecJobFailure {
  id: number;
  error: string;
}
export type CodecJobResult = CodecJobSuccess | CodecJobFailure;

/** Codec işini çalıştırır; `decodeEncapsulatedFrames` ile aynı sözleşmeyi kullanır. */
export async function runCodecJob(job: CodecJob): Promise<CodecJobResult> {
  try {
    const ds = {
      byteArray: job.byteArray,
      byteArrayParser: job.ts === TS_EXPLICIT_BE ? bigEndianByteArrayParser : littleEndianByteArrayParser,
    } as unknown as DicomDataSet;
    const el = {
      tag: "x7fe00010", // dicom-parser bu tag'i zorunlu kılar
      encapsulatedPixelData: job.encapsulatedPixelData,
      hadUndefinedLength: job.hadUndefinedLength,
      dataOffset: job.dataOffset,
      fragments: job.fragments,
      basicOffsetTable: job.basicOffsetTable ?? [],
    } as unknown as DicomElement;
    const frames = await decodeEncapsulatedFrames(ds, el, job.ts, job.info);
    return { id: job.id, frames: frames.map(serializeFrame) };
  } catch (e) {
    return { id: job.id, error: e instanceof Error ? e.message : String(e) };
  }
}

function serializeFrame(f: RawFrame): { buffer: ArrayBuffer; kind: "u8" | "i16" | "u16"; length: number } {
  const kind = f instanceof Int16Array ? "i16" : f instanceof Uint16Array ? "u16" : "u8";
  // Tam sahiplik: buffer'ı kopyalamadan devret; kısmi görünüm varsa bir kez kopyala.
  const buffer = (f.byteOffset === 0 && f.byteLength === f.buffer.byteLength
    ? f.buffer
    : f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)) as ArrayBuffer;
  return { buffer, kind, length: f.length };
}

export function deserializeFrame(f: { buffer: ArrayBuffer; kind: "u8" | "i16" | "u16"; length: number }): RawFrame {
  if (f.kind === "i16") return new Int16Array(f.buffer, 0, f.length);
  if (f.kind === "u16") return new Uint16Array(f.buffer, 0, f.length);
  return new Uint8Array(f.buffer, 0, f.length);
}

/** Worker global kapsamında `self.onmessage` kurar (ana iş parçacığında çağrılmaz). */
export function installCodecWorker(): void {
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent<CodecJob>) => void) | null;
    postMessage: (message: CodecJobResult, transfer: Transferable[]) => void;
  };
  scope.onmessage = (e: MessageEvent<CodecJob>) => {
    void runCodecJob(e.data).then((res) => {
      const transfer = "frames" in res ? res.frames.map((f) => f.buffer) : [];
      scope.postMessage(res, transfer);
    });
  };
}

if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function" && typeof window === "undefined") {
  installCodecWorker();
}

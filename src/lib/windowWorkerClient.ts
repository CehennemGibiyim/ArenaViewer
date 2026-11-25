/**
 * WL/WW worker istemcisi (v-perf) — ana iş parçacığını boşaltır.
 *
 * Neden ayrı istemci: `Viewport` bir React bileşeni; worker yaşam döngüsünü
 * (oluştur, istek gönder, iptal et, kapat) bileşenden ayırmak test edilebilir
 * kılıyor. Worker yoksa (SSR, eski tarayıcı, CSP engeli) çağrı **eşzamanlı
 * yedeğe** düşer: `windowToRGBA` ana iş parçacığında çalışır, sonuç aynıdır.
 */

import { buildWindowLUT, windowToRGBA } from "./window";
import { canTransfer, type SliceArray } from "./volumePerf";

export type SliceKind = "float32" | "int16" | "uint16";

/** Kesit dizisinin worker protokolündeki türü. */
export function kindOf(s: SliceArray): SliceKind {
  if (s instanceof Int16Array) return "int16";
  if (s instanceof Uint16Array) return "uint16";
  return "float32";
}

export interface WindowRequest {
  pixels: SliceArray;
  wl: number;
  ww: number;
  invert: boolean;
}

export interface WindowResult {
  pixels: Uint32Array;
  /** Hesaplama süresi (ms) — worker'da ölçülür, yedek yolda yerel ölçülür. */
  ms: number;
  /** Sonuç worker'dan mı geldi? (yedek yol → false) */
  viaWorker: boolean;
}

/** Eşzamanlı yedek: worker kullanılamadığında. */
export function windowSync(req: WindowRequest): WindowResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { lut, lo } = buildWindowLUT(req.wl, req.ww, req.invert);
  const out = windowToRGBA(req.pixels, lut, lo);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { pixels: out, ms: t1 - t0, viaWorker: false };
}

type WorkerReply = { type: "done"; id: number; pixels: ArrayBuffer; ms: number };

/**
 * Worker yaşam döngüsü. Tek örnek yeterlidir: dönüşümler sıralıdır ve en son
 * istek kazanır (sürükleme sırasında eski kareler atılır).
 */
export class WindowWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: WindowResult) => void>();
  private lastSent = 0;
  /** Worker kurulamadıysa bir daha denenmez (her kesitte hata gürültüsü olmasın). */
  private disabled = false;
  /** Worker oluşturma fabrikası (test için enjekte edilebilir). */
  constructor(private readonly create: (() => Worker | null) | null = null) {}

  get active(): boolean {
    return this.worker !== null;
  }

  /** Tarayıcıda worker'ı hazırlar; SSR'de null döner. */
  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (this.disabled || typeof window === "undefined") return null;
    try {
      const w =
        this.create?.() ??
        new Worker(new URL("../workers/windowWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg?.type !== "done") return;
        const resolve = this.pending.get(msg.id);
        if (!resolve) return;
        this.pending.delete(msg.id);
        resolve({ pixels: new Uint32Array(msg.pixels), ms: msg.ms, viaWorker: true });
      };
      w.onerror = () => {
        // Worker öldü: bekleyen istekleri eşzamanlı yolla tamamla, bir daha deneme.
        this.disabled = true;
        this.worker = null;
        for (const [id, resolve] of this.pending) {
          this.pending.delete(id);
          resolve({ pixels: new Uint32Array(0), ms: 0, viaWorker: false });
        }
      };
      this.worker = w;
      return w;
    } catch {
      this.disabled = true;
      return null;
    }
  }

  /**
   * Dönüşümü worker'a gönderir. Kesit tamponu **aktarılabilir**se kopyalanır
   * (`slice()`), çünkü çağıran kesiti yeniden kullanacaktır; aktarma sahipliği
   * devreder ve kaynak diziyi kullanılamaz hâle getirirdi.
   */
  async window(req: WindowRequest): Promise<WindowResult> {
    const w = this.ensure();
    if (!w) return windowSync(req);
    const id = this.nextId++;
    const kind = kindOf(req.pixels);
    const copy = req.pixels.slice() as SliceArray;
    const buffer = copy.buffer;
    if (!canTransfer(buffer)) return windowSync(req);
    const result = new Promise<WindowResult>((resolve) => this.pending.set(id, resolve));
    // Önceki isteği iptal et: sürüklemede yalnız son kare gerekir.
    if (this.lastSent) w.postMessage({ type: "cancel", id: this.lastSent });
    this.lastSent = id;
    w.postMessage({ type: "window", id, src: buffer, kind, wl: req.wl, ww: req.ww, invert: req.invert }, [buffer]);
    return result;
  }

  /** Kaynakları bırakır (bileşen kaldırıldığında). */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.lastSent = 0;
  }
}

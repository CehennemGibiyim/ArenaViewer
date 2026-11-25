/**
 * İstemci tarafı kare getirme + önbellek (e-wado-frame).
 *
 * Kullanım amacı: büyük çalışmalarda sunucudan tek seferde tüm instance
 * indirmek yerine, kaydırıcı hareket ettikçe YALNIZ görünen kareleri istemek
 * (kademeli getirme). Önbellek sınırlıdır (LRU benzeri) ve istekler
 * `AbortController` ile iptal edilebilir.
 */

export interface FrameKey {
  studyUid: string;
  seriesUid: string;
  sopUid: string;
}

export interface FrameRequest extends FrameKey {
  /** 1 tabanlı kare numaraları */
  frames: number[];
}

/** Önbellekte tutulacak azami kare sayısı (bellek koruması). */
export const FRAME_CACHE_MAX = 240;

const keyOf = (k: FrameKey, frame: number) => `${k.studyUid}|${k.seriesUid}|${k.sopUid}|${frame}`;

/** Basit LRU kare önbelleği. */
export class FrameCache {
  private map = new Map<string, Uint8Array>();
  constructor(private max = FRAME_CACHE_MAX) {}
  get size() {
    return this.map.size;
  }
  has(k: FrameKey, frame: number) {
    return this.map.has(keyOf(k, frame));
  }
  get(k: FrameKey, frame: number): Uint8Array | undefined {
    const key = keyOf(k, frame);
    const v = this.map.get(key);
    if (v) {
      // Dokunma sırasını güncelle (en son kullanılan sona)
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(k: FrameKey, frame: number, data: Uint8Array) {
    const key = keyOf(k, frame);
    this.map.delete(key);
    this.map.set(key, data);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
}

/** Kare numaralarını gruplara böler (tek istekte en fazla `size`). */
export function chunkFrames(frames: number[], size = 12): number[][] {
  const uniq = [...new Set(frames.filter((f) => Number.isInteger(f) && f > 0))].sort((a, b) => a - b);
  const out: number[][] = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/**
 * Eksik kareleri sunucudan ister. Önbellekte olanlar atlanır.
 * `accept` ile sıkıştırılmış aktarım istenebilir (JPEG/JPEG-LS/JPEG2000).
 */
export async function fetchFrames(
  req: FrameRequest,
  cache: FrameCache,
  opts: { accept?: string; signal?: AbortSignal; baseUrl?: string } = {},
): Promise<{ loaded: number[]; failed: number[] }> {
  const missing = req.frames.filter((f) => !cache.has(req, f));
  const loaded: number[] = [];
  const failed: number[] = [];
  for (const group of chunkFrames(missing)) {
    const q = new URLSearchParams({ seriesUid: req.seriesUid, sopUid: req.sopUid, frames: group.join(",") });
    if (opts.accept) q.set("accept", opts.accept);
    const base = opts.baseUrl ?? "";
    let res: Response;
    try {
      res = await fetch(`${base}/api/pacs/frames?studyUid=${encodeURIComponent(req.studyUid)}&${q}`, { signal: opts.signal });
    } catch {
      failed.push(...group);
      continue;
    }
    if (!res.ok) {
      failed.push(...group);
      continue;
    }
    const body = (await res.json().catch(() => null)) as { frames?: { data?: string }[] } | null;
    const list = body?.frames ?? [];
    group.forEach((f, i) => {
      const data = list[i]?.data;
      if (!data) { failed.push(f); return; }
      const bin = typeof atob === "function" ? atob(data) : Buffer.from(data, "base64").toString("binary");
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      cache.set(req, f, bytes);
      loaded.push(f);
    });
  }
  return { loaded, failed };
}

/** Ön getirme penceresi: geçerli kare ±`radius` (sınırlar içinde). */
export function prefetchWindow(current: number, total: number, radius = 2): number[] {
  const out: number[] = [];
  for (let f = current - radius; f <= current + radius; f++) {
    if (f >= 1 && f <= total) out.push(f);
  }
  return out;
}

/**
 * BulkDataURI yolundan kare çekme (e-wado-frame). PACS kareleri metadata
 * içindeki bulk adreslerinden sunuyorsa `fetchFrames` boş döner; bu yardımcı
 * `/api/pacs/frameplan` ile planı alır, `/api/pacs/bulkdata` ile indirir.
 *
 * Sunucu codec uyarısı dönerse (JPEG 2000 / RLE) veri **yine de** önbelleğe
 * yazılır ve çağırana "çözülemez" bilgisi verilir — sessizce başarı denmez.
 */
export async function fetchFramesViaBulk(
  req: FrameRequest,
  cache: FrameCache,
  opts: { signal?: AbortSignal; baseUrl?: string } = {},
): Promise<{ loaded: number[]; failed: number[]; planNote: string; decodable: boolean }> {
  const base = opts.baseUrl ?? "";
  const planRes = await fetch(`${base}/api/pacs/frameplan?studyUid=${encodeURIComponent(req.studyUid)}&seriesUid=${encodeURIComponent(req.seriesUid)}&sopUid=${encodeURIComponent(req.sopUid)}&frames=${req.frames.join(",")}`, { signal: opts.signal });
  const plan = (await planRes.json().catch(() => null)) as { urls?: { url?: string; frame?: number }[]; note?: string; hint?: { browserDecodable?: boolean } } | null;
  if (!planRes.ok || !plan?.urls?.length) {
    return { loaded: [], failed: [...req.frames], planNote: plan?.note ?? "Bulk plan alınamadı", decodable: false };
  }
  const loaded: number[] = [];
  const failed: number[] = [];
  for (const u of plan.urls) {
    if (!u.url) continue;
    const frame = u.frame ?? (loaded.length + failed.length) + 1;
    let res: Response;
    try {
      res = await fetch(`${base}/api/pacs/bulkdata?studyUid=${encodeURIComponent(req.studyUid)}&uri=${encodeURIComponent(u.url)}`, { signal: opts.signal });
    } catch {
      failed.push(frame);
      continue;
    }
    if (!res.ok) { failed.push(frame); continue; }
    const body = (await res.json().catch(() => null)) as { frames?: { data?: string }[] } | null;
    const data = body?.frames?.[0]?.data;
    if (!data) { failed.push(frame); continue; }
    const bin = typeof atob === "function" ? atob(data) : Buffer.from(data, "base64").toString("binary");
    cache.set(req, frame, Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    loaded.push(frame);
  }
  return { loaded, failed, planNote: plan.note ?? "", decodable: plan.hint?.browserDecodable === true };
}

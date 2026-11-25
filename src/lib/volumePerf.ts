/**
 * Büyük çalışmalarda performans çekirdeği (v-perf) — saf, test edilebilir.
 *
 * Üç sorun ve bu modülün yanıtı:
 *
 *  1. **Bellek:** Her kesit `Float32Array` olarak tutulursa 512×512 bir BT
 *     kesiti ~1 MB, 1000 kesitlik bir çalışma ~1 GB olur. HU değerleri tamsayı
 *     olduğundan `Int16Array` yarısını, `Uint16Array` (rescale sonrası 0–65535)
 *     ise aynı alanı daha verimli kullanır. `transcodeSlices` kayıpsız küçültme
 *     yapar: tüm değerler tamsayı ve ±32767 aralığındaysa `Int16Array`, 0–65535
 *     aralığındaysa `Uint16Array`, aksi hâlde `Float32Array` korunur.
 *
 *  2. **Ana iş parçacığı:** WL/WW değişiminde tüm kesit yeniden işlenir. Kademeli
 *     pencere (`prefetchOrder`) yalnız görünen kesit ve komşularını ısıtır;
 *     uzak kesitler istenene kadar çözülmez (`resolveWindow`).
 *
 *  3. **Kesit çözme maliyeti:** `ChunkedVolume` kesitleri üst üste binmeyen
 *     parçalara böler (`chunk` boyutu) ve yalnız eksik parçayı çözer; böylece
 *     bir kesite atlamak tüm hacmi çözmeyi gerektirmez.
 *
 * WebGL/OffscreenCanvas katmanı (Viewport) bu çekirdeğin ürettiği `ImageData`
 * benzeri u32 tamponu doğrudan dokuya yükler; worker'a taşıma sınırı
 * `canTransfer` ile belirlenir (paylaşılan tampon aktarılabilir mi?).
 */

/** Piksel dizisi türleri: kesit saklama biçimi. */
export type SliceArray = Float32Array | Int16Array | Uint16Array;

export interface TranscodeStats {
  /** Giriş ve çıkış bellek (bayt). */
  beforeBytes: number;
  afterBytes: number;
  /** Kazanç oranı (1 = değişmedi). */
  ratio: number;
  /** Çıkış biçimi. */
  kind: "float32" | "int16" | "uint16";
  /** Kayıpsız mı? (her zaman true; tam sayı olmayan değerlerde float korunur) */
  lossless: boolean;
}

const bytesPer = (a: SliceArray) => a.BYTES_PER_ELEMENT;

/**
 * Kesitleri mümkün olan en küçük kayıpsız türe çevirir.
 * Tüm kesitler aynı biçime getirilir (karışık türler GPU yüklemesini bozar).
 */
export function transcodeSlices(slices: SliceArray[]): { slices: SliceArray[]; stats: TranscodeStats } {
  const beforeBytes = slices.reduce((n, s) => n + s.byteLength, 0);
  if (slices.length === 0) {
    return {
      slices,
      stats: { beforeBytes: 0, afterBytes: 0, ratio: 1, kind: "float32", lossless: true },
    };
  }
  let integral = true;
  let min = Infinity;
  let max = -Infinity;
  for (const s of slices) {
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (integral && !Number.isInteger(v)) integral = false;
    }
  }
  let kind: TranscodeStats["kind"] = "float32";
  if (integral && min >= -32768 && max <= 32767) kind = "int16";
  else if (integral && min >= 0 && max <= 65535) kind = "uint16";

  if (kind === "float32") {
    return {
      slices,
      stats: { beforeBytes, afterBytes: beforeBytes, ratio: 1, kind, lossless: true },
    };
  }
  const out = slices.map((s) => {
    if (kind === "int16" && s instanceof Int16Array) return s;
    if (kind === "uint16" && s instanceof Uint16Array) return s;
    const dst = kind === "int16" ? new Int16Array(s.length) : new Uint16Array(s.length);
    // Doğrudan atama: değerler zaten tamsayı ve aralık içinde (yukarıda doğrulandı).
    dst.set(s as unknown as ArrayLike<number>);
    return dst;
  });
  const afterBytes = out.reduce((n, s) => n + s.byteLength, 0);
  return {
    slices: out,
    stats: { beforeBytes, afterBytes, ratio: beforeBytes === 0 ? 1 : afterBytes / beforeBytes, kind, lossless: true },
  };
}

/** Toplam bellek (bayt) — bellek bütçesi denetimi için. */
export function volumeBytes(slices: SliceArray[]): number {
  return slices.reduce((n, s) => n + s.byteLength, 0);
}

/** Türkçe okunur boyut: "1,2 GB", "340 MB". */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace(".", ",")} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface MemoryPlan {
  /** Bellek bütünüyle sığıyor mu? */
  fits: boolean;
  /** Tahmini bellek (bayt). */
  bytes: number;
  /** Sığmıyorsa önerilen davranış: kademeli yükleme + parça küçültme. */
  advice: string;
  /** Önerilen önbelleğe alınacak kesit sayısı (en az 3). */
  cacheSlices: number;
}

/**
 * Bellek bütçesi: çalışma toplamı bütçeyi aşıyorsa yalnız bir pencere tutulur.
 * `budgetBytes` varsayılan 1,5 GB (tarayıcı sekmesi için güvenli üst sınır).
 */
export function planMemory(slices: number, pixelsPerSlice: number, bytesPerElement: number, budgetBytes = 1.5 * 1024 ** 3): MemoryPlan {
  const per = Math.max(1, pixelsPerSlice * bytesPerElement);
  const bytes = Math.max(0, slices) * per;
  const fits = bytes <= budgetBytes;
  const cacheSlices = Math.max(3, Math.min(64, Math.floor(budgetBytes / per)));
  return {
    fits,
    bytes,
    cacheSlices: fits ? Math.min(cacheSlices, Math.max(1, slices)) : cacheSlices,
    advice: fits
      ? "Çalışma belleğe sığıyor; tüm kesitler önden yüklenebilir."
      : `Çalışma ${formatBytes(bytes)} (bütçe ${formatBytes(budgetBytes)}): yalnız görünen kesit ± komşuları tutulur, diğerleri istek üzerine çözülür.`,
  };
}

/**
 * Kademeli pencere sırası: istenen kesit, sonra ileri/geri dönüşümlü komşular.
 * Ön getirme (prefetch) bu sırayı kullanır; `radius` = ileri ve geri genişlik.
 */
export function prefetchOrder(current: number, total: number, radius = 2): number[] {
  if (total <= 0) return [];
  const c = Math.max(0, Math.min(current, total - 1));
  const out = [c];
  for (let d = 1; d <= radius; d++) {
    // Önce ileri (okuma yönü), sonra geri: radyolog genelde aşağı kaydırır.
    if (c + d < total) out.push(c + d);
    if (c - d >= 0) out.push(c - d);
  }
  return out;
}

/** Aktif pencereyi tutan küçük LRU; `prefetchOrder` sonuçlarıyla beslenir. */
export class SliceWindowCache<T> {
  private map = new Map<number, T>();
  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  has(i: number): boolean {
    return this.map.has(i);
  }

  get(i: number): T | undefined {
    const v = this.map.get(i);
    if (v !== undefined) {
      // Tazele: Map ekleme sırası LRU tahliyesinde kullanılır.
      this.map.delete(i);
      this.map.set(i, v);
    }
    return v;
  }

  set(i: number, v: T): void {
    this.map.delete(i);
    this.map.set(i, v);
    while (this.map.size > this.max) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }

  /** Pencere dışında kalanları atar (kademeli yükleme: uzak kesitler bellekte durmaz). */
  trimTo(keep: number[]): number[] {
    const set = new Set(keep);
    const removed: number[] = [];
    for (const k of [...this.map.keys()]) {
      if (!set.has(k)) {
        this.map.delete(k);
        removed.push(k);
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }
}

export interface ChunkStats {
  /** Kaç parça çözüldü (önbellekte olmayan). */
  resolved: number;
  /** Kaç parça önbellekte hazırdı. */
  hits: number;
  /** Çözülen kesit sayısı (parça boyu × parça). */
  slices: number;
}

/**
 * Parçalı hacim çözücü: kesitleri `chunk` boyutlu bloklara böler ve yalnız
 * eksik blokları çözer. 1000 kesitlik bir BT'de 12. kesite atlamak tüm hacmi
 * değil, 1 bloğu (ör. 32 kesit) çözer.
 */
export class ChunkedVolume<T> {
  private chunks = new Map<number, T[]>();
  private stats: ChunkStats = { resolved: 0, hits: 0, slices: 0 };
  constructor(
    readonly total: number,
    private readonly chunk = 32,
    private readonly decode: (from: number, to: number) => T[] = () => [],
  ) {}

  get chunkCount(): number {
    return Math.ceil(this.total / this.chunk);
  }

  /** Kesiti verir; ait olduğu blok yoksa blok çözülür. */
  get(index: number): T | undefined {
    if (index < 0 || index >= this.total) return undefined;
    const c = Math.floor(index / this.chunk);
    let block = this.chunks.get(c);
    if (!block) {
      const from = c * this.chunk;
      const to = Math.min(this.total, from + this.chunk);
      block = this.decode(from, to);
      this.chunks.set(c, block);
      this.stats.resolved++;
      this.stats.slices += to - from;
    } else {
      this.stats.hits++;
    }
    return block[index - c * this.chunk];
  }

  /** Verilen kesitleri (kademeli pencere) önceden çözer. */
  prefetch(indices: number[]): void {
    for (const i of indices) void this.get(i);
  }

  /** Bellek bütçesi: tutulacak blok sayısı; fazlası atılır (LRU). */
  trimChunks(maxChunks: number): number {
    let removed = 0;
    while (this.chunks.size > maxChunks) {
      const first = this.chunks.keys().next();
      if (first.done) break;
      this.chunks.delete(first.value);
      removed++;
    }
    return removed;
  }

  get loadedChunks(): number {
    return this.chunks.size;
  }

  get statistics(): ChunkStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { resolved: 0, hits: 0, slices: 0 };
  }
}

/**
 * Worker'a aktarım: `ArrayBuffer` sahipliği devredilebilir mi?
 * Paylaşılan (SharedArrayBuffer) veya dışarıdan sahiplenilmiş tamponlar
 * aktarılamaz; bu durumda kopyalama gerekir (ölçüm için `copyBytes`).
 */
export function canTransfer(buf: ArrayBufferLike | undefined | null): boolean {
  if (!buf) return false;
  if (typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer) return false;
  return buf.byteLength > 0;
}

/** Aktarılamayan arabellek için kopya maliyeti (bayt). */
export function copyBytes(buf: ArrayBufferLike | undefined | null): number {
  if (!buf || canTransfer(buf)) return 0;
  return buf.byteLength;
}

/**
 * GPU doku yüklemesi için boyut kuralı: WebGL `MAX_TEXTURE_SIZE` (genelde 16384)
 * aşılırsa görüntü kırpılır/ölçeklenir. Dönen değer, dokunun hedef boyutudur.
 */
export function textureSize(width: number, height: number, maxSize = 16384): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, scaled: false };
  const big = Math.max(width, height);
  if (big <= maxSize) return { width, height, scaled: false };
  const k = maxSize / big;
  return { width: Math.max(1, Math.floor(width * k)), height: Math.max(1, Math.floor(height * k)), scaled: true };
}

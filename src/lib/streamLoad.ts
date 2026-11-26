/**
 * Kademeli (streaming) yükleme zamanlayıcısı (v-perf).
 *
 * Amaç: büyük PACS/sunucu çalışmalarında **tüm** kesitleri bekleyip sonra
 * göstermek yerine, geometrik büyüyen dalgalar hâlinde getirmek ve ilk dalga
 * geldiğinde görüntüyü erken açmak. Bu modül ağ/parse işini yapmaz; yalnız
 * **zamanlama + eşzamanlılık + hata/iptal muhasebesi** yapar, böylece saf
 * fonksiyon olarak test edilebilir.
 *
 * Sözleşme:
 *  - Her dizin **en fazla bir kez** istenir (`fetchOne`).
 *  - Aynı anda uçuştaki istek sayısı `concurrency`'yi geçmez.
 *  - Bir isteğin hatası tüm yüklemeyi düşürmez; dizin `failed` listesine yazılır
 *    (dürüst muhasebe: sessizce yutulan kesit yok).
 *  - `onWave` yalnız dalga sınırlarında çağrılır ve o ana kadar **gelen** öğeleri
 *    dizin sırasıyla verir; iptalde (`signal.aborted`) yeni istek başlatılmaz.
 */
export interface WaveOptions {
  /** İlk dalganın boyutu (erken önizleme için küçük tutulur). */
  first?: number;
  /** Dalga büyüme çarpanı. */
  factor?: number;
  /** Azami dalga sayısı — parse maliyetini sınırlar (prefix tekrar parse edilir). */
  maxWaves?: number;
}

/**
 * Kümülatif dalga eşikleri. Son eleman her zaman `total`'dır (tam yükleme),
 * eşikler kesin artandır ve `total`'ı aşmaz.
 */
export function planWaves(total: number, opts: WaveOptions = {}): number[] {
  const first = Math.max(1, Math.floor(opts.first ?? 12));
  const factor = Math.max(1.2, opts.factor ?? 4);
  const maxWaves = Math.max(1, Math.floor(opts.maxWaves ?? 4));
  if (total <= 0) return [];
  if (total <= first * 2) return [total]; // küçük çalışmada dalga bölmenin faydası yok
  const out: number[] = [];
  let at = first;
  while (out.length < maxWaves - 1 && at < total) {
    out.push(Math.min(total, Math.round(at)));
    at *= factor;
  }
  if (out[out.length - 1] !== total) out.push(total);
  // Kesin artanlık garantisi (yuvarlama çakışmalarını at).
  return out.filter((v, i) => v > 0 && (i === 0 || v > out[i - 1]));
}

export interface WaveContext<T> {
  /** Dizin sırasıyla, o ana kadar gelenler (başarısız dizinler `undefined`). */
  items: (T | undefined)[];
  /** Başarıyla gelen öğe sayısı. */
  loaded: number;
  total: number;
  /** 1 tabanlı dalga numarası. */
  wave: number;
  failed: number[];
}

export interface WaveResult<T> {
  /** Dizin sırasıyla başarılı öğeler (başarısızlar atlanmıştır). */
  ordered: T[];
  /** Dizin sırasıyla tüm yuvalar (başarısızlar `undefined`). */
  items: (T | undefined)[];
  failed: number[];
  /** İptal nedeniyle erken bitip bitmediği. */
  aborted: boolean;
  /** Gerçekten kullanılan eşikler (test/tanılama). */
  waves: number[];
}

export interface LoadOptions<T> extends WaveOptions {
  total: number;
  fetchOne: (index: number) => Promise<T>;
  onWave?: (ctx: WaveContext<T>) => void | Promise<void>;
  signal?: AbortSignal;
  /** Aynı anda uçuştaki istek sayısı (varsayılan 4). */
  concurrency?: number;
}

/**
 * Öğeleri dalgalar hâlinde getirir. Abort'ta **fırlatmaz**: `aborted: true` ile
 * o ana kadar gelenleri döndürür (çağıran `signal.aborted` ile karar verir).
 */
export async function loadInWaves<T>(opts: LoadOptions<T>): Promise<WaveResult<T>> {
  const { total, fetchOne, onWave, signal } = opts;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const items: (T | undefined)[] = new Array(Math.max(0, total));
  const failed: number[] = [];
  const waves = planWaves(total, opts);
  let next = 0;
  let loaded = 0;
  let aborted = false;

  const runOne = async (index: number) => {
    try {
      const v = await fetchOne(index);
      items[index] = v;
      loaded++;
    } catch {
      // Tek kesit hatası yüklemeyi düşürmez; muhasebeye yazılır.
      failed.push(index);
      failed.sort((a, b) => a - b);
    }
  };

  for (let w = 0; w < waves.length; w++) {
    const upto = waves[w];
    // Dalga içinde eşzamanlılık havuzu: her işçi sıradaki dizini alır.
    const workers: Promise<void>[] = [];
    const target = upto;
    const worker = async () => {
      while (next < target) {
        if (signal?.aborted) { aborted = true; return; }
        const idx = next++;
        await runOne(idx);
        if (signal?.aborted) { aborted = true; return; }
      }
    };
    for (let i = 0; i < Math.min(concurrency, Math.max(0, target - next)); i++) workers.push(worker());
    await Promise.all(workers);
    if (signal?.aborted) { aborted = true; break; }
    await onWave?.({ items: items.slice(), loaded, total, wave: w + 1, failed: failed.slice() });
    if (signal?.aborted) { aborted = true; break; }
  }

  const ordered: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    if (v !== undefined) ordered.push(v);
  }
  return { ordered, items, failed, aborted, waves };
}

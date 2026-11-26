/**
 * GPU doku atlası planlayıcısı (v-perf) — çok kesitli/çok kareli serilerde
 * kesit başına ayrı 2B doku oluşturup her kaydırmada yeniden yükleme yerine,
 * **tek bir `TEXTURE_2D_ARRAY`** içinde N katman tutar.
 *
 * Buradaki mantık saf ve test edilebilir: kaç katman ayrılacağı (cihaz sınırı +
 * bellek bütçesi), hangi kesidin hangi katmanda durduğu ve hangi katmanın
 * tahliye edileceği (LRU). GL çağrıları `gpuWindow.ts` içindedir; bu dosya
 * hiçbir GL sembolü kullanmaz.
 */

export interface LayerPlanInput {
  /** Serideki toplam kesit/kare sayısı. */
  sliceCount: number;
  /** Cihazın `MAX_ARRAY_TEXTURE_LAYERS` değeri (dizi desteklenmiyorsa 0/1). */
  maxLayers: number;
  width: number;
  height: number;
  /** Doku başına örnek boyutu (Int16/Uint16 → 2, Float32 → 4). */
  bytesPerTexel: number;
  /** Atlas için ayrılabilecek azami bellek (varsayılan 256 MB). */
  memoryBudgetBytes?: number;
}

export interface LayerPlan {
  /** Kullanılacak katman sayısı (1 → dizi kullanılmaz, mevcut tek doku yolu). */
  layers: number;
  /** Katman başına bellek (bayt). */
  layerBytes: number;
  /** Kararın kısa, dürüst gerekçesi (arayüzde/tanılamada gösterilir). */
  reason: string;
}

export const ATLAS_DEFAULT_BUDGET = 256 * 1024 * 1024;

/**
 * Katman sayısını belirler: cihaz sınırı, seri uzunluğu ve bellek bütçesi.
 * Bellek bütçesi aşılırsa katman sayısı **en az 1** olacak şekilde küçültülür;
 * hiç sığmıyorsa 1 döner (çağıran mevcut tek doku yolunu kullanır).
 */
export function planLayers(input: LayerPlanInput): LayerPlan {
  const w = Math.max(1, Math.floor(input.width));
  const h = Math.max(1, Math.floor(input.height));
  const bpt = input.bytesPerTexel <= 0 ? 2 : input.bytesPerTexel;
  const layerBytes = w * h * bpt;
  const budget = input.memoryBudgetBytes ?? ATLAS_DEFAULT_BUDGET;
  const deviceMax = Math.floor(input.maxLayers);
  if (deviceMax < 2) {
    return { layers: 1, layerBytes, reason: "dizi dokusu desteklenmiyor (tek doku yolu)" };
  }
  const wanted = Math.min(Math.max(1, Math.floor(input.sliceCount)), deviceMax);
  if (wanted < 2) {
    return { layers: 1, layerBytes, reason: "seride tek kesit var (atlas gereksiz)" };
  }
  const byBudget = Math.floor(budget / layerBytes);
  const layers = Math.max(1, Math.min(wanted, byBudget));
  if (layers < 2) {
    return { layers: 1, layerBytes, reason: `bellek bütçesi ${Math.round(budget / 1048576)} MB yetmiyor (tek doku yolu)` };
  }
  if (byBudget < wanted) {
    return {
      layers,
      layerBytes,
      reason: `bellek bütçesi: ${layers}/${wanted} katman (${Math.round((layers * layerBytes) / 1048576)} MB)`,
    };
  }
  if (wanted < input.sliceCount) {
    return { layers, layerBytes, reason: `cihaz sınırı: ${wanted} katman (seride ${input.sliceCount} kesit)` };
  }
  return { layers, layerBytes, reason: `tüm seri sığıyor: ${layers} katman` };
}

/** Katmanın serbest mi, hangi keside ait olduğu bilgisi. */
interface Slot {
  sliceIndex: number | null;
  /** En son kullanılma sayacı (LRU). */
  used: number;
}

export interface AcquireResult {
  slot: number;
  /** Bu katmana yükleme yapılmalı mı? (false → önbellek isabeti) */
  upload: boolean;
  /** Tahliye edilen kesit indeksi (yoksa null). */
  evicted: number | null;
}

/**
 * Kesit → katman eşlemesi (LRU tahliye). Aynı kesit tekrar istendiğinde yükleme
 * **yapılmaz**; atlas dolduğunda en uzun süredir kullanılmayan katman tahliye edilir.
 */
export class AtlasSlots {
  private slots: Slot[];
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private tick = 0;

  constructor(layers: number) {
    const n = Math.max(1, Math.floor(layers));
    this.slots = Array.from({ length: n }, () => ({ sliceIndex: null, used: -1 }));
  }

  get layerCount(): number {
    return this.slots.length;
  }

  get stats(): { hits: number; misses: number; evictions: number } {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions };
  }

  /** Önbellekte hangi kesitler duruyor (test/ tanılama). */
  get resident(): number[] {
    return this.slots.filter((s) => s.sliceIndex !== null).map((s) => s.sliceIndex as number);
  }

  /**
   * Kesit için katman ister. İsabet varsa `upload: false`; yoksa boş katman ya da
   * LRU katman verilir ve `upload: true` döner.
   */
  acquire(sliceIndex: number): AcquireResult {
    this.tick++;
    const hit = this.slots.find((s) => s.sliceIndex === sliceIndex);
    if (hit) {
      hit.used = this.tick;
      this.hits++;
      return { slot: this.slots.indexOf(hit), upload: false, evicted: null };
    }
    this.misses++;
    const free = this.slots.findIndex((s) => s.sliceIndex === null);
    if (free >= 0) {
      this.slots[free] = { sliceIndex, used: this.tick };
      return { slot: free, upload: true, evicted: null };
    }
    // En eski kullanılan katmanı tahliye et.
    let victim = 0;
    for (let i = 1; i < this.slots.length; i++) {
      if (this.slots[i].used < this.slots[victim].used) victim = i;
    }
    const evicted = this.slots[victim].sliceIndex;
    this.slots[victim] = { sliceIndex, used: this.tick };
    this.evictions++;
    return { slot: victim, upload: true, evicted };
  }

  /** Atlası boşalt (bağlam kaybı, seri değişimi). */
  reset(): void {
    for (const s of this.slots) { s.sliceIndex = null; s.used = -1; }
  }
}

/** Doku biçimine göre örnek boyutu. */
export function bytesPerTexelFor(format: "r16ui" | "r16i" | "r32f"): number {
  return format === "r32f" ? 4 : 2;
}

/**
 * `TEXTURE_2D_ARRAY` sarmalayıcısı — yalnız GL çağrıları, karar mantığı yukarıda.
 * `GpuWindower` bunu kullanır; testler sahte (kayıt tutan) bir GL nesnesiyle
 * "gereksiz yükleme yok" sözleşmesini doğrular.
 */
export class AtlasTexture {
  private tex: WebGLTexture | null = null;
  private storage = false;
  private uploads = 0;
  private lastErr = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly layers: number,
    readonly width: number,
    readonly height: number,
    /** Boyutlu iç biçim (R16I, R16UI, R32F). */
    private readonly internalFormat: number,
  ) {}

  get uploadCount(): number {
    return this.uploads;
  }

  get error(): boolean {
    return this.lastErr;
  }

  get texture(): WebGLTexture | null {
    return this.tex;
  }

  /** Dokuyu (katmanlı) ayırır; ikinci çağrıda yeniden ayırmaz. */
  ensure(): boolean {
    if (this.tex && this.storage) return true;
    const gl = this.gl;
    try {
      if (!this.tex) this.tex = gl.createTexture();
      if (!this.tex) return false;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this.internalFormat, this.width, this.height, this.layers);
      this.storage = true;
      if (gl.getError() !== gl.NO_ERROR) { this.lastErr = true; return false; }
      return true;
    } catch {
      this.lastErr = true;
      return false;
    }
  }

  /** Tek katmanı yükler (yalnız önbellek ıskasında çağrılır). */
  upload(slot: number, format: number, type: number, data: ArrayBufferView): boolean {
    if (!this.ensure() || !this.tex) return false;
    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, this.width, this.height, 1, format, type, data);
      this.uploads++;
      if (gl.getError() !== gl.NO_ERROR) { this.lastErr = true; return false; }
      return true;
    } catch {
      this.lastErr = true;
      return false;
    }
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
  }

  dispose(): void {
    if (this.tex) this.gl.deleteTexture(this.tex);
    this.tex = null;
    this.storage = false;
  }
}

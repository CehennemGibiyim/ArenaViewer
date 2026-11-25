/**
 * İkinci ekran yayını (v-multimon) — aynı kaynak, ayrı pencere.
 *
 * İki pencere `BroadcastChannel` ile konuşur (yalnız aynı köken; veri sunucuya
 * gitmez, diske yazılmaz). İkinci pencereyi işletim sistemiyle başka bir
 * monitöre sürüklemek "çoklu monitör" senaryosunu karşılar.
 *
 * Tasarım: **tüm seri değil, yalnız görüntülenen kesit** gönderilir. 1000
 * kesitlik bir BT'yi yapısal kopyayla taşımak yüzlerce MB olurdu; bunun yerine
 * meta bir kez, pikseller kesit değiştikçe gider. Alıcı son N kesiti tutar.
 */

export const MIRROR_CHANNEL = "atikviewer-mirror";
export const MIRROR_PATH = "/ayna";
/** Tek kesit yayın üst sınırı: 16 MP ≈ 64 MB Float32. */
export const MIRROR_MAX_SLICE_PIXELS = 16_000_000;
/** Alıcıda tutulan kesit sayısı (bellek kapısı). */
export const MIRROR_CACHE_MAX = 12;

export interface MirrorState {
  slice: number;
  wl: number;
  ww: number;
  invert: boolean;
  zoom: number;
  pan: { x: number; y: number };
  /** Panelde gösterilen kısa etiket (modalite · açıklama). */
  label?: string;
}

/** Pikselsiz seri künyesi — ikinci pencereye bir kez gider. */
export interface MirrorMeta {
  id: string;
  modality: string;
  description: string;
  width: number;
  height: number;
  pixelSpacing: number;
  pixelSpacingX?: number;
  sliceThickness: number;
  sliceCount: number;
  unit?: string;
  isColor?: boolean;
}

export type MirrorPixels = ArrayLike<number>;

export type MirrorMessage =
  | { type: "series"; series: MirrorMeta; state: MirrorState }
  | { type: "slice"; index: number; pixels: MirrorPixels; rgba?: Uint32Array }
  | { type: "state"; state: MirrorState }
  | { type: "bye" };

/** Seriden yayın künyesi (piksel taşımaz). */
export function metaOf(s: {
  id: string; modality: string; description: string; width: number; height: number;
  pixelSpacing: number; pixelSpacingX?: number; sliceThickness: number;
  slices: unknown[]; unit?: string; isColor?: boolean;
}): MirrorMeta {
  return {
    id: s.id, modality: s.modality, description: s.description,
    width: s.width, height: s.height, pixelSpacing: s.pixelSpacing,
    pixelSpacingX: s.pixelSpacingX, sliceThickness: s.sliceThickness,
    sliceCount: s.slices.length, unit: s.unit, isColor: s.isColor,
  };
}

/** Seri ikinci ekrana yayınlanabilir mi? (kesit başına boyut kapısı) */
export function canMirror(
  series: { width: number; height: number; slices: unknown[] } | null | undefined
): { ok: boolean; reason?: string } {
  if (!series || !series.width || !series.height || !series.slices?.length) {
    return { ok: false, reason: "Yayınlanacak seri yok." };
  }
  const px = series.width * series.height;
  if (px > MIRROR_MAX_SLICE_PIXELS) {
    return { ok: false, reason: `Kesit çok büyük (${Math.round(px / 1e6)} MP > 16 MP); ikinci ekrana yayınlanamaz.` };
  }
  return { ok: true };
}

export function isMirrorState(v: unknown): v is MirrorState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const pan = s.pan as Record<string, unknown> | undefined;
  return (
    typeof s.slice === "number" && Number.isFinite(s.slice) &&
    typeof s.wl === "number" && Number.isFinite(s.wl) &&
    typeof s.ww === "number" && Number.isFinite(s.ww) &&
    typeof s.invert === "boolean" &&
    typeof s.zoom === "number" && Number.isFinite(s.zoom) &&
    !!pan && typeof pan.x === "number" && typeof pan.y === "number"
  );
}

export function isMirrorMeta(v: unknown): v is MirrorMeta {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.width !== "number" || typeof s.height !== "number") return false;
  if (!(s.width > 0) || !(s.height > 0)) return false;
  if (typeof s.sliceCount !== "number" || !(s.sliceCount > 0)) return false;
  return typeof s.id === "string" && typeof s.modality === "string";
}

/** Piksel sayısı künyeyle uyuşuyor mu? (bozuk/yarım mesajı ayıklar) */
export function pixelsMatch(meta: { width: number; height: number }, pixels: unknown): boolean {
  const p = pixels as ArrayLike<number> | null;
  return !!p && typeof p.length === "number" && p.length === meta.width * meta.height;
}

/** Gelen mesajı doğrular; tanınmayan/bozuk mesaj `null` döner. */
export function readMirrorMessage(data: unknown): MirrorMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type === "bye") return { type: "bye" };
  if (m.type === "state" && isMirrorState(m.state)) return { type: "state", state: m.state };
  if (m.type === "series" && isMirrorMeta(m.series) && isMirrorState(m.state)) {
    return { type: "series", series: m.series, state: m.state };
  }
  if (m.type === "slice" && typeof m.index === "number" && Number.isFinite(m.index) && m.pixels) {
    return {
      type: "slice",
      index: m.index,
      pixels: m.pixels as MirrorPixels,
      rgba: m.rgba instanceof Uint32Array ? m.rgba : undefined,
    };
  }
  return null;
}

/**
 * Alıcı önbelleğine kesit koyar ve en eski kayıtları atar.
 * `max` sınırı bellek içindir; aynı kesit yeniden gelirse tazelenir.
 */
export function putSlice(
  cache: Map<number, { pixels: MirrorPixels; rgba?: Uint32Array }>,
  index: number,
  pixels: MirrorPixels,
  rgba?: Uint32Array,
  max = MIRROR_CACHE_MAX
): void {
  cache.delete(index);
  cache.set(index, { pixels, rgba });
  while (cache.size > max) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Alıcı tarafında `SeriesData` benzeri kesit dizisi: eksik kesitler **tek bir
 * paylaşılan sıfır tamponuna** işaret eder (kesit başına bellek ayrılmaz).
 */
export function buildSlices(
  meta: { width: number; height: number; sliceCount: number },
  cache: Map<number, { pixels: MirrorPixels; rgba?: Uint32Array }>
): MirrorPixels[] {
  const zero = new Float32Array(meta.width * meta.height);
  return Array.from({ length: meta.sliceCount }, (_, i) => cache.get(i)?.pixels ?? zero);
}

/** Durum etiketi: "CT · Beyin · Kesit 12/40 · WL 40 / WW 400". */
export function stateLabel(
  state: MirrorState,
  series?: { modality?: string; description?: string } | null,
  sliceCount?: number
): string {
  const head = [series?.modality ?? "", series?.description ?? ""].filter(Boolean).join(" · ");
  const of = sliceCount ? `/${sliceCount}` : "";
  return `${head ? head + " · " : ""}Kesit ${state.slice + 1}${of} · WL ${Math.round(state.wl)} / WW ${Math.round(state.ww)}${state.invert ? " · INV" : ""}`;
}

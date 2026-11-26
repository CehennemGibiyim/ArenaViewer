/**
 * e-stow: seriyi 1 tabanlı kesit aralığıyla keser (PACS'e «seçili parça» gönderimi).
 * Saf işlev; dizinler sınırlanır, f ≤ t korunur, sayısal olmayan girdiler varsayılana düşer.
 * Kesit konumları ve SOP UID'leri de dilimlemede birlikte kesilir ki sıra bozulmasın.
 */
export interface SliceRangeLike {
  slices: ArrayLike<unknown>;
  slicePositions?: number[];
  sopUids?: string[];
}

export function subSeriesForRange<T extends SliceRangeLike>(series: T, from1: number, to1: number): T {
  const total = series.slices.length;
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? Math.trunc(v) : fallback);
  if (total <= 0) {
    // Boş seride «parça» yoktur: seçim değil, saf boş alt-dizi döner (tanımsız kesit üretilmez).
    return { ...series, slices: [] as unknown as T["slices"], slicePositions: [], sopUids: [] };
  }
  const f = Math.max(0, Math.min(total - 1, num(from1, 1) - 1));
  const t = Math.max(f, Math.min(total - 1, num(to1, total) - 1));
  return {
    ...series,
    slices: Array.from({ length: t - f + 1 }, (_, i) => series.slices[f + i]) as unknown as T["slices"],
    slicePositions: series.slicePositions?.slice(f, t + 1),
    sopUids: series.sopUids?.slice(f, t + 1),
  };
}

/** Aralık geçerliliği: 1 tabanlı kapalı aralık, 1 ≤ from ≤ to ≤ toplam. */
export function rangeLength(from1: number, to1: number, total: number): number {
  if (total <= 0) return 0;
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? Math.trunc(v) : fallback);
  const f = Math.max(0, Math.min(total - 1, num(from1, 1) - 1));
  const t = Math.max(f, Math.min(total - 1, num(to1, total) - 1));
  return t - f + 1;
}

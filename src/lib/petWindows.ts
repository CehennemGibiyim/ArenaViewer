/**
 * PET SUV pencere ön ayarları.
 *
 * PET görüntüsünde pencere kullanıcı için **SUV** biriminde anlamlıdır (0–5 gibi),
 * görüntüleyicideki WL/WW ise modality biriminde (Bq/ml) tutulur. Bu modül SUV
 * aralığını modality penceresine çevirir: `SUV = pikselDeğeri × factor`
 * (`suvFactor`, `src/lib/suv.ts`) olduğundan aralık factor'e bölünür.
 *
 * Sınırlar:
 *  - Factor yoksa (doz/zaman/boy bilgisi eksik) SUV penceresi hesaplanamaz; çağıran
 *    taraf ön ayarları hiç göstermez.
 *  - Bu bir *görüntüleme* yardımıdır; eşik tabanlı otomatik lezyon seçimi değildir.
 */

export interface PetSuvPreset {
  name: string;
  suvMin: number;
  suvMax: number;
  note: string;
}

/** Klinik pratikte sık kullanılan sabit SUV aralıkları (0 tabanlı). */
export const PET_SUV_PRESETS: PetSuvPreset[] = [
  { name: "PET SUV 0–2,5", suvMin: 0, suvMax: 2.5, note: "kan havuzu / düşük tutulum" },
  { name: "PET SUV 0–5", suvMin: 0, suvMax: 5, note: "karaciğer üstü eşik (yaygın)" },
  { name: "PET SUV 0–10", suvMin: 0, suvMax: 10, note: "yüksek tutulum" },
  { name: "PET SUV 0–15", suvMin: 0, suvMax: 15, note: "çok yüksek tutulum (lenfoma vb.)" },
];

/**
 * SUV aralığı → modality biriminde WL/WW.
 * Factor geçersizse `null` (pencere uygulanmaz).
 */
export function suvWindowToModality(
  suvMin: number,
  suvMax: number,
  factor: number | null | undefined,
): { wl: number; ww: number } | null {
  if (!factor || !Number.isFinite(factor) || factor <= 0) return null;
  if (!Number.isFinite(suvMin) || !Number.isFinite(suvMax)) return null;
  const lo = Math.min(suvMin, suvMax);
  const hi = Math.max(suvMin, suvMax);
  if (hi - lo <= 0) return null;
  const wl = (lo + hi) / 2 / factor;
  const ww = Math.max(1, (hi - lo) / factor);
  return { wl: Math.round(wl * 100) / 100, ww: Math.round(ww * 100) / 100 };
}

/** Seride SUV factor varsa hazır pencere listesi (yoksa boş dizi). */
export function suvPresetsForSeries(factor: number | null | undefined): { name: string; wl: number; ww: number }[] {
  const out: { name: string; wl: number; ww: number }[] = [];
  for (const p of PET_SUV_PRESETS) {
    const w = suvWindowToModality(p.suvMin, p.suvMax, factor);
    if (w) out.push({ name: p.name, ...w });
  }
  return out;
}

/** Modality değeri → SUV (factor yoksa null). Ölçüm etiketleriyle aynı sözleşme. */
export function modalityToSuv(value: number, factor: number | null | undefined): number | null {
  if (!factor || !Number.isFinite(factor) || factor <= 0) return null;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * factor * 100) / 100;
}

/** Modality penceresinin SUV karşılığı (kullanıcıya "hangi SUV aralığı" bilgisi). */
export function modalityWindowToSuv(
  wl: number,
  ww: number,
  factor: number | null | undefined,
): { suvMin: number; suvMax: number } | null {
  if (!factor || !Number.isFinite(factor) || factor <= 0) return null;
  if (!Number.isFinite(wl) || !Number.isFinite(ww)) return null;
  const half = Math.max(1, ww) / 2;
  const suvMin = Math.max(0, (wl - half) * factor);
  const suvMax = (wl + half) * factor;
  return { suvMin: Math.round(suvMin * 100) / 100, suvMax: Math.round(suvMax * 100) / 100 };
}

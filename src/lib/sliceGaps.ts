/**
 * Kesit aralığı denetimi (f-series).
 *
 * Neden: seri yüklenirken yalnız "aralık düzensiz" uyarısı veriliyordu; kaç
 * kesitin **eksik** olduğu ve aynı konumda **yinelenen** kesit olup olmadığı
 * söylenmiyordu. Bu modül konum listesinden (ImagePositionPatient izdüşümü ya
 * da InstanceNumber) beklenen kesit sayısını, eksik sayısını ve çiftleri
 * deterministik olarak hesaplar.
 *
 * Sınırlar:
 *  - Yalnız konum bilgisi olan serilerde çalışır (konum yoksa null döner).
 *  - "Eksik" sayısı medyan aralığa göre TAHMİNDİR; hasta hareketi, gelgit
 *    çekimleri veya değişken aralıklı (ör. spiral) serilerde yanılabilir.
 *  - Eksik kesitler burada DOLDURULMAZ; yalnız bildirilir.
 */

export interface SliceGapReport {
  /** Değerlendirilen kesit sayısı. */
  total: number;
  /** Medyan kesit aralığı (mm; konum biriminde). */
  spacing: number;
  /** İlk–son konum aralığından beklenen kesit sayısı. */
  expected: number;
  /** Tahmini eksik kesit sayısı (aralık boşluklarının toplamı). */
  missing: number;
  /** Aynı konumda yinelenen kesit sayısı. */
  duplicates: number;
  /** Toleransı aşan düzensiz aralık sayısı. */
  irregular: number;
  /** Kısa Türkçe özet (arayüz uyarısı için). */
  message: string;
}

const EPS = 0.01;

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Konum listesinden kesit aralığı denetimi. Sıra önemsizdir (kopyalanıp sıralanır).
 * `tolerance` medyan aralığa göre göreli sapma eşiğidir (varsayılan 0,25).
 */
export function analyzeSliceGaps(positions: number[], tolerance = 0.25): SliceGapReport | null {
  const sorted = positions.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  if (sorted.length < 3) return null;

  let duplicates = 0;
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (Math.abs(d) <= EPS) duplicates += 1;
    else diffs.push(d);
  }
  if (diffs.length === 0) return null;

  const spacing = median(diffs);
  if (!(spacing > 0)) return null;

  let irregular = 0;
  let missing = 0;
  for (const d of diffs) {
    if (Math.abs(d - spacing) <= spacing * tolerance) continue;
    irregular += 1;
    const steps = Math.round(d / spacing);
    if (steps > 1) missing += steps - 1;
  }

  const expected = Math.round((sorted[sorted.length - 1] - sorted[0]) / spacing) + 1;

  const parts: string[] = [];
  parts.push(`${sorted.length} kesit (beklenen ${expected})`);
  if (missing > 0) parts.push(`≈${missing} eksik`);
  if (duplicates > 0) parts.push(`${duplicates} yinelenen`);
  if (irregular > 0 && missing === 0) parts.push(`${irregular} düzensiz aralık`);
  if (missing === 0 && duplicates === 0 && irregular === 0) parts.push("aralık düzenli");

  return {
    total: sorted.length,
    spacing: Math.round(spacing * 100) / 100,
    expected,
    missing,
    duplicates,
    irregular,
    message: `${parts.join(" · ")} (medyan aralık ${Math.round(spacing * 100) / 100})`,
  };
}

/** Uyarı üretmeye değer mi? (eksik/çift/düzensiz varsa) */
export function hasSliceProblem(r: SliceGapReport | null): boolean {
  return r !== null && (r.missing > 0 || r.duplicates > 0 || r.irregular > 0);
}

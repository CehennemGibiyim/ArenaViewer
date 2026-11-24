/**
 * İş akışı istatistikleri (F4): rapor turnaround süresi (TAT) ve durum dağılımı.
 *
 * Yalnızca hesaplama + biçimlendirme; veritabanı erişimi yoktur (test edilebilir).
 * TAT = onaylanma anı − rapor oluşturulma anı. Negatif/eksik ölçümler dışlanır.
 */

export interface ReportStatRow {
  status: string;
  modality: string;
  createdAt: string | Date | null;
  approvedAt: string | Date | null;
  /** Onaylayan hekimin görünen adı */
  approvedBy: string;
}

export interface RadiologistStat {
  name: string;
  approved: number;
  medianHours: number | null;
  p90Hours: number | null;
}

export interface WorkflowStats {
  total: number;
  byStatus: Record<string, number>;
  byModality: Record<string, number>;
  /** Onaylanmış rapor sayısı */
  approved: number;
  /** Onaylananların TAT'ı (saat) */
  medianHours: number | null;
  p90Hours: number | null;
  /** Ortalama TAT (saat) */
  meanHours: number | null;
  /** Taslak raporu olarak bekleyen toplam (gün bazında eski olan ayrıca listelenir) */
  pendingDrafts: number;
  /** Oluşturulma üzerinden en az X gündür bekleyen taslak */
  staleDrafts: { olderDays: number; count: number };
  perRadiologist: RadiologistStat[];
}

const HOUR = 3_600_000;

/** İki zaman damgası arasındaki saat farkı; geçersiz/negatifse null. */
export function turnaroundHours(createdAt: string | Date | null, approvedAt: string | Date | null): number | null {
  if (!createdAt || !approvedAt) return null;
  const c = new Date(createdAt).getTime();
  const a = new Date(approvedAt).getTime();
  if (!Number.isFinite(c) || !Number.isFinite(a)) return null;
  const h = (a - c) / HOUR;
  return h >= 0 ? h : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 90. yüzdelik dilim (klinik TAT raporlarında kullanılan üst kuşak). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** Toplu rapor satırlarından istatistik üretir. */
export function summarizeStats(rows: ReportStatRow[], now: Date = new Date(), staleDays = 3): WorkflowStats {
  const byStatus: Record<string, number> = {};
  const byModality: Record<string, number> = {};
  const tatAll: number[] = [];
  const byRad = new Map<string, { approved: number; hours: number[] }>();
  let pendingDrafts = 0;
  let stale = 0;
  const staleMs = staleDays * 24 * HOUR;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const mod = r.modality || "?";
    byModality[mod] = (byModality[mod] ?? 0) + 1;

    if (r.status === "onaylandi") {
      const h = turnaroundHours(r.createdAt, r.approvedAt);
      if (h !== null) {
        tatAll.push(h);
        const name = r.approvedBy?.trim() || "(isimsiz)";
        const cur = byRad.get(name) ?? { approved: 0, hours: [] };
        cur.approved++;
        cur.hours.push(h);
        byRad.set(name, cur);
      }
    }
    if (r.status === "taslak") {
      pendingDrafts++;
      const c = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
      if (Number.isFinite(c) && now.getTime() - c >= staleMs) stale++;
    }
  }

  const mean = tatAll.length ? tatAll.reduce((a, b) => a + b, 0) / tatAll.length : null;

  return {
    total: rows.length,
    byStatus,
    byModality,
    approved: tatAll.length,
    medianHours: round(median(tatAll)),
    p90Hours: round(percentile(tatAll, 90)),
    meanHours: round(mean),
    pendingDrafts,
    staleDrafts: { olderDays: staleDays, count: stale },
    perRadiologist: [...byRad.entries()]
      .map(([name, v]) => ({ name, approved: v.approved, medianHours: round(median(v.hours)), p90Hours: round(percentile(v.hours, 90)) }))
      .sort((a, b) => b.approved - a.approved),
  };
}

/** Saati okunabilir biçime çevirir (örn. "4,5 sa"). */
export function formatHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} dk`;
  if (h < 48) return `${(Math.round(h * 10) / 10).toLocaleString("tr-TR")} sa`;
  return `${(Math.round(h / 24)).toLocaleString("tr-TR")} gün`;
}

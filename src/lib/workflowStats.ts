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

// ───────── Haftalık trend ve hedef TAT (f-tat) ─────────

export interface WeekBucket {
  /** Haftanın başlangıcı (yyyy-mm-dd, pazartesi) */
  weekStart: string;
  label: string;
  approved: number;
  medianHours: number | null;
  p90Hours: number | null;
}

/** Verilen tarihin hafta başlangıcı (yyyy-mm-dd, pazartesi). */
export function weekStartOf(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // pazartesi = 0
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}`;
};

/**
 * Son `weeks` hafta için onaylanan rapor TAT trendi (eskiden yeniye).
 * `modality` verilirse yalnız o modalite sayılır. Boş haftalar da döner
 * (medianHours null) ki grafik kesintisiz olsun.
 */
export function weeklyTrend(rows: ReportStatRow[], weeks = 8, now: Date = new Date(), modality?: string): WeekBucket[] {
  const n = Math.max(1, Math.min(52, Math.round(weeks)));
  const buckets = new Map<string, number[]>();
  const starts: string[] = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() - i * 7);
    const wk = weekStartOf(d);
    starts.push(wk);
    if (!buckets.has(wk)) buckets.set(wk, []);
  }
  for (const r of rows) {
    if (r.status !== "onaylandi") continue;
    if (modality && (r.modality || "?") !== modality) continue;
    const h = turnaroundHours(r.createdAt, r.approvedAt);
    if (h === null) continue;
    const ref = r.approvedAt ? new Date(r.approvedAt) : null;
    if (!ref || !Number.isFinite(ref.getTime())) continue;
    const wk = weekStartOf(ref);
    const list = buckets.get(wk);
    if (list) list.push(h);
  }
  const uniq = [...new Set(starts)].sort();
  return uniq.map((wk) => {
    const hours = buckets.get(wk) ?? [];
    return {
      weekStart: wk,
      label: shortDate(wk),
      approved: hours.length,
      medianHours: round(median(hours)),
      p90Hours: round(percentile(hours, 90)),
    };
  });
}

export type TatStatus = "hedef-icinde" | "sinirda" | "hedef-disi" | "bilinmiyor";

export interface TatTargetResult {
  status: TatStatus;
  targetHours: number;
  /** median / target (hedefe oran) */
  ratio: number | null;
  note: string;
}

/**
 * Medyan TAT'ı hedefe göre sınıflar: ≤hedef → içinde, ≤1,25×hedef → sınırda,
 * üstü → hedef dışı. Ölçüm yoksa "bilinmiyor".
 */
export function tatTarget(medianHours: number | null, targetHours = 24): TatTargetResult {
  const target = Number.isFinite(targetHours) && targetHours > 0 ? targetHours : 24;
  if (medianHours === null || !Number.isFinite(medianHours)) {
    return { status: "bilinmiyor", targetHours: target, ratio: null, note: "Onaylanmış rapor yok; hedef karşılaştırması yapılamadı." };
  }
  const ratio = medianHours / target;
  if (ratio <= 1) return { status: "hedef-icinde", targetHours: target, ratio, note: `Medyan TAT hedefin içinde (${formatHours(medianHours)} ≤ ${formatHours(target)}).` };
  if (ratio <= 1.25) return { status: "sinirda", targetHours: target, ratio, note: `Medyan TAT hedefin %${Math.round((ratio - 1) * 100)} üzerinde; sınır bölgesi.` };
  return { status: "hedef-disi", targetHours: target, ratio, note: `Medyan TAT hedefin %${Math.round((ratio - 1) * 100)} üzerinde (${formatHours(medianHours)} > ${formatHours(target)}).` };
}

/**
 * Yönetici için uyarı satırları: genel hedef durumu, haftalık keskin artış ve
 * hedefi aşan son haftalar. Yalnız ölçüm varsa üretilir.
 */
export function tatAlerts(weekly: readonly WeekBucket[], target: TatTargetResult, staleCount = 0): string[] {
  const out: string[] = [];
  if (target.status === "hedef-disi" || target.status === "sinirda") out.push(target.note);
  const measured = weekly.filter((w) => w.medianHours !== null);
  const worst = measured.slice().sort((a, b) => (b.medianHours ?? 0) - (a.medianHours ?? 0))[0];
  if (worst && worst.medianHours !== null && worst.medianHours > target.targetHours) {
    out.push(`${worst.label} haftası hedefi aştı (${formatHours(worst.medianHours)}, ${worst.approved} rapor).`);
  }
  if (measured.length >= 2) {
    const last = measured[measured.length - 1];
    const prev = measured[measured.length - 2];
    if (last.medianHours !== null && prev.medianHours !== null && prev.medianHours > 0) {
      const change = last.medianHours / prev.medianHours - 1;
      if (change >= 0.25) out.push(`Son hafta önceki haftaya göre %${Math.round(change * 100)} daha yavaş.`);
    }
  }
  if (staleCount > 0) out.push(`${staleCount} taslak uzun süredir onay bekliyor (eşik: ayarlardaki bayat taslak günü).`);
  return out;
}

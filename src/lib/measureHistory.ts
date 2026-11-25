/**
 * Ölçüm geçmişi (c-measure-history): sunucuda saklanan yapılandırılmış ölçüm
 * kayıtlarını lezyon bazlı zaman serilerine çevirir.
 *
 * Bu dosya saf fonksiyonlardır (DB/HTTP yok): API rotası, panel ve testler aynı
 * mantığı paylaşır. Kayıt kimliği hasta + çalışma tarihi + lezyon adıdır; aynı
 * gün aynı lezyon için yalnız son ölçüm geçerlidir.
 */

/** Sunucuya yazılan tek ölçüm (mm; HU/SUV isteğe bağlı). */
export interface MeasurementRecord {
  patientId: string;
  patientName?: string;
  /** ISO tarih (yyyy-mm-dd). */
  studyDate: string;
  label: string;
  anatomy?: string;
  kind?: string;
  longMm: number;
  hu?: number | null;
  suv?: number | null;
}

/** Zaman serisindeki tek nokta. */
export interface TrendPoint {
  date: string;
  longMm: number;
  hu: number | null;
  suv: number | null;
}

/** Lezyon bazlı seri: noktalar tarihe göre artan. */
export interface LesionSeries {
  key: string;
  label: string;
  anatomy: string;
  kind: string;
  points: TrendPoint[];
  /** Son − ilk çap (mm). */
  deltaMm: number | null;
  /** İlk ölçüme göre yüzde değişim; ilk 0 ise null. */
  pctChange: number | null;
  /** HU değişimi (varsa). */
  huDelta: number | null;
  /** İlk ve son ölçüm arasındaki gün sayısı. */
  spanDays: number | null;
}

const trim = (s: string | undefined | null) => (s ?? "").trim();

/** Lezyon kimliği: aynı ad + bölge aynı seriye düşer (büyük/küçük harf duyarsız). */
export function seriesKey(r: { label: string; anatomy?: string }): string {
  return `${trim(r.label).toLocaleLowerCase("tr-TR")}|${trim(r.anatomy).toLocaleLowerCase("tr-TR")}`;
}

const msOf = (iso: string) => {
  const t = Date.parse(`${trim(iso)}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
};

const dayDiff = (a: string, b: string) => {
  const x = msOf(a);
  const y = msOf(b);
  return x === null || y === null ? null : Math.round((y - x) / 86400000);
};

/**
 * Kayıtları lezyon serilerine çevirir. Aynı seri + aynı tarih için son kayıt
 * kazanır (yeniden gönderim mükerrer nokta üretmez). Seriler son çapa göre
 * büyükten küçüğe sıralanır; bozuk kayıtlar (çap yok/negatif, tarih yok) atılır.
 */
export function buildSeries(records: readonly MeasurementRecord[]): LesionSeries[] {
  const buckets = new Map<string, LesionSeries>();
  for (const r of records) {
    const date = trim(r.studyDate).slice(0, 10);
    if (!date || msOf(date) === null) continue;
    if (!Number.isFinite(r.longMm) || r.longMm <= 0) continue;
    const key = seriesKey(r);
    let s = buckets.get(key);
    if (!s) {
      s = {
        key,
        label: trim(r.label) || "lezyon",
        anatomy: trim(r.anatomy),
        kind: trim(r.kind),
        points: [],
        deltaMm: null,
        pctChange: null,
        huDelta: null,
        spanDays: null,
      };
      buckets.set(key, s);
    }
    const point: TrendPoint = {
      date,
      longMm: Number(r.longMm),
      hu: r.hu !== undefined && r.hu !== null && Number.isFinite(r.hu) ? Number(r.hu) : null,
      suv: r.suv !== undefined && r.suv !== null && Number.isFinite(r.suv) ? Number(r.suv) : null,
    };
    const existing = s.points.findIndex((p) => p.date === date);
    if (existing >= 0) s.points[existing] = point;
    else s.points.push(point);
  }
  const out = [...buckets.values()];
  for (const s of out) {
    s.points.sort((a, b) => a.date.localeCompare(b.date));
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (s.points.length > 1) {
      s.deltaMm = Number((last.longMm - first.longMm).toFixed(1));
      s.pctChange = first.longMm > 0 ? Number((((last.longMm - first.longMm) / first.longMm) * 100).toFixed(0)) : null;
      s.spanDays = dayDiff(first.date, last.date);
    }
    if (first.hu !== null && last.hu !== null) s.huDelta = Number((last.hu - first.hu).toFixed(1));
  }
  out.sort((a, b) => (b.points[b.points.length - 1]?.longMm ?? 0) - (a.points[a.points.length - 1]?.longMm ?? 0));
  return out;
}

/**
 * Seri için SVG `points` dizisi ("x,y x,y …"). Değerler w×h kutusuna sığdırılır;
 * tüm çaplar eşitse dikey orta hatta çizgi olur. 2'den az nokta → "".
 */
export function sparkPoints(points: readonly TrendPoint[], w = 120, h = 28, pad = 2): string {
  if (points.length < 2) return "";
  const ts = points.map((p) => msOf(p.date) ?? 0);
  const vs = points.map((p) => p.longMm);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const iw = Math.max(1, w - 2 * pad);
  const ih = Math.max(1, h - 2 * pad);
  return points
    .map((p, i) => {
      const x = tMax === tMin ? pad + iw / 2 : pad + ((ts[i] - tMin) / (tMax - tMin)) * iw;
      const y = vMax === vMin ? pad + ih / 2 : pad + ih - ((vs[i] - vMin) / (vMax - vMin)) * ih;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Geçmiş tablosu için satırlar (CSV ve ekran aynı sırayı kullanır). */
export function historyRows(series: readonly LesionSeries[]): string[][] {
  const rows: string[][] = [];
  for (const s of series) {
    for (const p of s.points) {
      rows.push([
        s.label,
        s.anatomy,
        s.kind,
        p.date,
        p.longMm ? p.longMm.toFixed(1) : "",
        p.hu === null ? "" : String(p.hu),
        p.suv === null ? "" : String(p.suv),
      ]);
    }
  }
  return rows;
}

/** UTF-8 CSV gövdesi (BOM çağıran tarafta eklenir). */
export function historyCsv(series: readonly LesionSeries[]): string {
  const head = ["Lezyon", "Bölge", "Tip", "Tarih", "Çap (mm)", "HU", "SUV"];
  return [head, ...historyRows(series)]
    .map((r) => r.map((c) => (/[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";"))
    .join("\n");
}

/** Seri özeti: panel başlığındaki tek satırlık metin. */
export function seriesSummary(s: LesionSeries): string {
  if (s.points.length === 0) return `${s.label}: ölçüm yok`;
  const last = s.points[s.points.length - 1];
  const parts = [`${last.longMm.toFixed(1)} mm`];
  if (s.deltaMm !== null && s.pctChange !== null) parts.push(`${s.deltaMm >= 0 ? "+" : ""}${s.deltaMm.toFixed(1)} mm (%${s.pctChange >= 0 ? "+" : ""}${s.pctChange})`);
  parts.push(`${s.points.length} ölçüm`);
  return `${s.label}${s.anatomy ? ` · ${s.anatomy}` : ""}: ${parts.join(" · ")}`;
}

/**
 * Ölçüm geçmişi ve trend (c-measure-history).
 *
 * Amaç: aynı hastanın farklı çalışmalarındaki ölçümleri (çap, hacim, HU, SUV)
 * yapılandırılmış kayıt olarak sunucuda biriktirmek ve zaman serisi olarak
 * göstermek. Bu dosya saf hesabı taşır (veritabanı/tarayıcı yok): testler
 * dönüşüm, yüzde değişim ve ikilenme süresini doğrular.
 *
 * Önemli sınırlar:
 * - Değer ÜRETİLMEZ: yalnız mevcut ekran ölçümlerinden okunur.
 * - Etiketler kullanıcı adı ya da AI tahmini değildir; ölçüm türü + isteğe
 *   bağlı kullanıcı etiketi kullanılır. Aynı etiket = aynı seri varsayımıdır.
 * - Hasta kimliği (patientId) sunucuda zaten tutulan kayıtla aynıdır; panel
 *   yalnız seçili hastanın satırlarını ister.
 */

import { dist, polygonArea } from "./geometry";
import { ellipsoidD3, ellipsoidVolumeMl } from "./geometry";
import type { Annotation, SeriesData } from "./types";

/** Sunucudaki `measurement_history` satırının istemci gösterimi. */
export interface HistoryRow {
  patientId: string;
  studyUid: string;
  /** YYYY-MM-DD; bilinmiyorsa boş (trendde sona atılır). */
  studyDate: string;
  seriesKey: string;
  modality: string;
  /** Seri içindeki ölçüm türü/etiketi (ör. "Uzunluk", "Nodül A hacmi"). */
  label: string;
  kind: string;
  value: number;
  unit: "mm" | "mL" | "mm2" | "HU" | "SUV";
  slice: number;
  createdAt?: string;
}

export interface TrendPoint {
  value: number;
  studyDate: string;
  studyUid: string;
  deltaAbs: number | null;
  deltaPct: number | null;
}

export interface TrendSeries {
  label: string;
  unit: HistoryRow["unit"];
  points: TrendPoint[];
  /** Son ile ilk ölçüm arası yüzde değişim (nokta < 2 ise null). */
  changePct: number | null;
  /** Yalnızca büyüyen ve iki pozitif noktası olan serilerde (gün). */
  doublingDays: number | null;
  direction: "artis" | "azalma" | "stabil" | "belirsiz";
  /** En güncel ölçüm (tablo/rozet için). */
  latest: TrendPoint | null;
}

/** Geometri yardımcıları: elips alanı (mm²) — piksel uzayında. */
function ellipseAreaPx(dx: number, dy: number): number {
  return (Math.PI * Math.abs(dx) * Math.abs(dy)) / 4;
}

export interface RowsInput {
  annotations: Annotation[];
  series: Pick<SeriesData, "patientId" | "studyUid" | "studyDate" | "id" | "modality">;
  pxMm: number;
  /** PET ise SUV ölçek çarpanı; yoksa HU satırı yazılmaz. */
  suvFactor?: number | null;
  /** Kullanıcı etiketleri: annotation.id → etiket (ör. "Nodül A"). */
  labels?: Record<string, string>;
}

/**
 * Ekran anotasyonlarını geçmiş satırlarına çevirir.
 *
 * Her anotasyon için en fazla iki satır: boyut (mm / mm² / mL) ve varsa
 * ortalama yoğunluk (HU veya SUV). Boş/geçersiz ölçüm atlanır; sıfır değer
 * yazılmaz (trendde yanıltıcı sıçrama olmasın).
 */
export function measurementsToRows(input: RowsInput): HistoryRow[] {
  const { annotations, series, pxMm, suvFactor, labels } = input;
  const px = pxMm > 0 ? pxMm : 1;
  const base = {
    patientId: (series.patientId ?? "").trim(),
    studyUid: series.studyUid ?? "",
    studyDate: (series.studyDate ?? "").slice(0, 10),
    seriesKey: series.id,
    modality: series.modality ?? "",
  };
  if (!base.patientId) return [];

  const rows: HistoryRow[] = [];
  const push = (a: Annotation, label: string, kind: string, value: number, unit: HistoryRow["unit"]) => {
    if (!Number.isFinite(value) || value <= 0) return;
    rows.push({ ...base, label, kind, value, unit, slice: a.slice, createdAt: new Date().toISOString() });
  };

  for (const a of annotations) {
    if (a.kind === "arrow" || a.kind === "angle" || a.kind === "cobb") continue;
    const tag = (labels?.[a.id] ?? "").trim();
    const suffix = tag ? ` · ${tag}` : "";

    if (a.kind === "length" && a.points.length >= 2) {
      push(a, `Uzunluk${suffix}`, "length", dist(a.points[0], a.points[1]) * px, "mm");
    } else if (a.kind === "ellipsoid" && a.points.length >= 2) {
      const d1 = Math.abs(a.points[1].x - a.points[0].x) * px;
      const d2 = Math.abs(a.points[1].y - a.points[0].y) * px;
      const d3 = ellipsoidD3(a, d1, d2); // a.text mm cinsindendir (bkz. geometry)
      push(a, `Elipsoid hacim${suffix}`, "volume", ellipsoidVolumeMl(d1, d2, d3), "mL");
    } else if (a.kind === "ellipse" && a.points.length >= 2) {
      const dx = (a.points[1].x - a.points[0].x) * px;
      const dy = (a.points[1].y - a.points[0].y) * px;
      push(a, `Elips alan${suffix}`, "area", ellipseAreaPx(dx, dy), "mm2");
    } else if (a.kind === "rect" && a.points.length >= 2) {
      push(a, `Dikdörtgen alan${suffix}`, "area",
        Math.abs(a.points[1].x - a.points[0].x) * px * (Math.abs(a.points[1].y - a.points[0].y) * px), "mm2");
    } else if (a.kind === "polygon" && a.points.length >= 3) {
      push(a, `Çokgen alan${suffix}`, "area", polygonArea(a.points) * px * px, "mm2");
    }

    const st = a.stats;
    if (st && Number.isFinite(st.mean)) {
      if (suvFactor && suvFactor > 0) push(a, `Ortalama SUV${suffix}`, "suv", st.mean * suvFactor, "SUV");
      else push(a, `Ortalama HU${suffix}`, "hu", st.mean, "HU");
    }
  }
  return rows;
}

const DAY = 86_400_000;

/** Tarih + oluşturma zamanına göre kronolojik anahtar (boş tarih sona). */
function sortKey(r: HistoryRow): number {
  const d = Date.parse(`${r.studyDate}T00:00:00Z`);
  const c = r.createdAt ? Date.parse(r.createdAt) : 0;
  return (Number.isFinite(d) ? d : Number.MAX_SAFE_INTEGER) + (Number.isFinite(c) ? Math.min(c, 1e12) % DAY : 0);
}

function daysBetween(a: string, b: string): number | null {
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.round((t2 - t1) / DAY);
}

/**
 * Satırları etikete göre zaman serilerine çevirir.
 *
 * `deltaPct` önceki noktaya göredir. Yön eşiği %5: küçük oynamalar "stabil"
 * sayılır (ölçüm gürültüsünü trend sanmamak için). İkilenme süresi yalnızca
 * artan, iki uç değeri de pozitif ve tarihleri farklı serilerde hesaplanır:
 * t½ = ln2 · Δt / ln(v2/v1).
 */
export function buildTrends(rows: HistoryRow[]): TrendSeries[] {
  const groups = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    if (!Number.isFinite(r.value) || r.value <= 0) continue;
    const key = `${r.label}|${r.unit}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out: TrendSeries[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => sortKey(a) - sortKey(b));
    const points: TrendPoint[] = list.map((r, i) => {
      const prev = i > 0 ? list[i - 1].value : null;
      const deltaAbs = prev === null ? null : r.value - prev;
      const deltaPct = prev === null || prev === 0 ? null : ((r.value - prev) / prev) * 100;
      return { value: r.value, studyDate: r.studyDate, studyUid: r.studyUid, deltaAbs, deltaPct };
    });
    const first = points[0];
    const last = points[points.length - 1];
    const changePct = points.length < 2 || first.value === 0 ? null : ((last.value - first.value) / first.value) * 100;

    let direction: TrendSeries["direction"] = "belirsiz";
    if (changePct !== null) direction = changePct > 5 ? "artis" : changePct < -5 ? "azalma" : "stabil";

    // İkilenme yalnız anlamlı büyümede (%5 üstü artış) ve iki tarih varsa hesaplanır;
    // küçük oynamalardan türetilen "ikilenme süresi" klinik gürültüyü trend gibi gösterirdi.
    let doublingDays: number | null = null;
    if (direction === "artis" && points.length >= 2) {
      const dt = daysBetween(first.studyDate, last.studyDate);
      if (dt && dt > 0) {
        doublingDays = Math.round((Math.log(2) * dt) / Math.log(last.value / first.value));
      }
    }

    const [label, unit] = key.split("|");
    out.push({ label, unit: unit as HistoryRow["unit"], points, changePct, doublingDays, direction, latest: last ?? null });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, "tr"));
  return out;
}

const DIRECTION_TR: Record<TrendSeries["direction"], string> = {
  artis: "artıyor", azalma: "azalıyor", stabil: "stabil", belirsiz: "tek ölçüm",
};

/** Panel/rapor için tek satır özet (uydurma yorum yok, yalnız ölçüm matematiği). */
export function trendSummary(t: TrendSeries): string {
  if (!t.latest) return `${t.label}: ölçüm yok`;
  const unit = t.unit === "mm2" ? "mm²" : t.unit;
  const val = `${t.latest.value.toFixed(t.unit === "HU" || t.unit === "SUV" ? 1 : 2)} ${unit}`;
  if (t.points.length < 2) return `${t.label}: ${val} (${DIRECTION_TR.belirsiz})`;
  const pct = t.changePct === null ? "" : ` · ilk ölçüme göre %${t.changePct > 0 ? "+" : ""}${t.changePct.toFixed(1)}`;
  const dbl = t.doublingDays ? ` · ikilenme ~${t.doublingDays} gün` : "";
  return `${t.label}: ${val} · ${DIRECTION_TR[t.direction]}${pct}${dbl}`;
}

/** Grafik için 0–1 normalize koordinatlar (SVG polyline). */
export function sparkline(points: TrendPoint[], width = 120, height = 28, pad = 3): string {
  if (points.length === 0) return "";
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  return points.map((p, i) => {
    const x = points.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (points.length - 1);
    const y = height - pad - ((p.value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

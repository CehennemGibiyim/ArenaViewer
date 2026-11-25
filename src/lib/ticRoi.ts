/**
 * ROI tabanlı TIC (time–intensity curve) — `v-fusion` tamamlayıcısı.
 *
 * Dinamik/DCE çalışmalarda aynı bölge birden çok seride (fazda) görüntülenir.
 * Hekimin çizdiği ROI (dikdörtgen/elips/poligon) **her fazda aynı anatomik
 * keside** yeniden uygulanır, ROI ortalama yoğunluğu zaman eksenine dizilir ve
 * `nuclear.ts → ticCurve` ile wash-out / plato / progresif olarak sınıflanır.
 *
 * Dürüst sınırlar:
 *  - Yalnız aynı Frame of Reference ve paralel düzlemdeki seriler eşlenir;
 *    farklı geometri (farklı çekim/pozisyon) sessizce **dışlanır** ve sayısı
 *    kullanıcıya bildirilir.
 *  - Zaman ekseni Series Time / Acquisition Time farkıdır; etiket yoksa eksen
 *    "faz sırası" olur ve eğri sınıflanmaz (yalnız şekil gösterilir).
 *  - Sonuç tanı aracı değildir; eşikler (wash-out ≥ %15) literatürde yaygın
 *    kullanılan değerlerdir, kurum protokolüne göre değişir.
 */
import type { Annotation, SeriesData } from "./types";
import { ellipseTest, pointInPolygon, regionStats, mapSliceByPosition, type Pt } from "./geometry";
import { parallelSeries } from "./planes";
import { ticCurve, type TicResult } from "./nuclear";

export interface TicPhase {
  seriesId: string;
  label: string;
  modality: string;
  /** Bu seride ROI'nin uygulandığı kesit indeksi */
  sliceIndex: number;
  /** ROI ortalama piksel değeri (serinin kendi biriminde) */
  mean: number;
  /** Seri zamanı (gün başlangıcından saniye) — yoksa null */
  timeSec: number | null;
}

/** ROI geometrisi: kutu + içinde kalma testi. Desteklenmeyen türde null. */
export function roiGeometry(ann: Annotation): { box: { x0: number; y0: number; x1: number; y1: number }; inside: (x: number, y: number) => boolean } | null {
  if (!ann.points || ann.points.length < 2) return null;
  const xs = ann.points.map((p) => p.x);
  const ys = ann.points.map((p) => p.y);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  if (ann.kind === "rect") return { box, inside: () => true };
  if (ann.kind === "ellipse") {
    const [a, b] = ann.points;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    return { box, inside: ellipseTest(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2) };
  }
  if (ann.kind === "polygon" && ann.points.length >= 3) {
    const pts: Pt[] = ann.points;
    return { box, inside: (x, y) => pointInPolygon(x, y, pts) };
  }
  return null;
}

/** TIC için kullanılabilir ROI anotasyonları (o kesitte). */
export function ticRoiCandidates(annotations: readonly Annotation[], slice: number): Annotation[] {
  return annotations.filter((a) => a.slice === slice && !!roiGeometry(a));
}

/**
 * Bir serinin ROI'ye karşılık gelen kesidi ve ortalama değeri.
 * Geometri uyuşmuyorsa null.
 */
export function phaseFor(primary: SeriesData, slice: number, ann: Annotation, s: SeriesData): TicPhase | null {
  if (!s.slices?.length || s.isColor || s.specialType) return null;
  if (s.id !== primary.id) {
    if (!parallelSeries(primary, s)) return null;
    if (primary.frameOfRef && s.frameOfRef && primary.frameOfRef !== s.frameOfRef) return null;
  }
  const geo = roiGeometry(ann);
  if (!geo) return null;
  const idx = s.id === primary.id ? Math.min(slice, s.slices.length - 1) : mapSliceByPosition(primary, slice, s);
  const st = regionStats(s, idx, geo.box, geo.inside);
  if (!st) return null;
  return {
    seriesId: s.id,
    label: s.description || s.modality,
    modality: s.modality,
    sliceIndex: idx,
    mean: st.mean,
    timeSec: typeof s.seriesTime === "number" && Number.isFinite(s.seriesTime) ? s.seriesTime : null,
  };
}

/** Tüm uygun seriler için fazları üretir (zaman varsa sıralı). */
export function buildTicPhases(primary: SeriesData, slice: number, ann: Annotation, all: readonly SeriesData[]): TicPhase[] {
  const phases: TicPhase[] = [];
  const seen = new Set<string>();
  for (const s of [primary, ...all]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const p = phaseFor(primary, slice, ann, s);
    if (p) phases.push(p);
  }
  const timed = phases.filter((p) => p.timeSec !== null);
  if (timed.length === phases.length) phases.sort((a, b) => (a.timeSec as number) - (b.timeSec as number));
  else phases.sort((a, b) => a.sliceIndex - b.sliceIndex);
  return phases;
}

export interface TicAnalysis {
  phases: TicPhase[];
  /** Zaman ekseni: "sn" (gerçek zaman) ya da "faz" (etiket yok) */
  axis: "sn" | "faz";
  times: number[];
  values: number[];
  curve: TicResult;
  baseline: number;
  peak: number;
  /** Zirveye göre yüzde artış (ilk fazdan) */
  enhancementPct: number | null;
  /** ROI eşleşmeyen / dışlanan seri sayısı (bilgi amaçlı) */
  excluded: number;
  note: string;
  csv: string;
}

const NOTE = "TIC sınıflaması ölçüm yardımcısıdır; tanı ve klinik karar hekime aittir. Eşikler (wash-out ≥ %15) kurum protokolüne göre değişir.";

/** Fazları analiz eder. Zaman etiketi yoksa eksen "faz" olur ve sınıflama yapılmaz. */
export function analyzeRoiTic(phases: readonly TicPhase[], all?: readonly SeriesData[]): TicAnalysis {
  const list = [...phases];
  const timed = list.filter((p) => p.timeSec !== null);
  const axis: "sn" | "faz" = list.length >= 2 && timed.length === list.length ? "sn" : "faz";
  const t0 = axis === "sn" ? Math.min(...timed.map((p) => p.timeSec as number)) : 0;
  const times = list.map((p, i) => (axis === "sn" ? Math.round(((p.timeSec as number) - t0) * 10) / 10 : i));
  const values = list.map((p) => Math.round(p.mean * 100) / 100);
  const baseline = values[0] ?? 0;
  const peak = values.length ? Math.max(...values) : 0;
  const enhancementPct = baseline > 0 ? Math.round(((peak - baseline) / baseline) * 1000) / 10 : null;

  let curve: TicResult;
  if (axis === "faz") {
    curve = {
      pattern: "yetersiz",
      peakValue: peak,
      peakTimeSec: 0,
      washIn: null,
      washOutPct: null,
      advice: "Seri zamanı (Series/Acquisition Time) yok; eğri yalnız faz sırasına göre çizildi. Sınıflama için zaman bilgisi gerekir.",
    };
  } else {
    curve = ticCurve(times, values);
    // Zirve son fazda: wash-out hesaplanamaz ama eğri **progresif** (Tip 1) kabul edilir
    // (nükleer TIC'te "yetersiz" döner; dinamik kontrast dinamiğinde bu bir eğri tipidir).
    if (curve.pattern === "yetersiz" && curve.washOutPct === null && values.length >= 3 && values[values.length - 1] >= peak - 1e-9) {
      curve = {
        ...curve,
        pattern: "progressif",
        advice: "Zirve son fazda: belirgin wash-out yok, artan (progresif / Tip 1) kinetik. Benign süreçlerde sık; klinik korelasyon gerekir.",
      };
    }
  }

  const excluded = all ? Math.max(0, all.filter((s) => !list.some((p) => p.seriesId === s.id)).length) : 0;
  const note = list.length < 3
    ? `${NOTE} En az 3 faz gerekir (şu an ${list.length}).`
    : NOTE;
  const csv = [
    "faz;seri;modalite;kesit;zaman_sn;ortalama",
    ...list.map((p, i) => [i + 1, p.label, p.modality, p.sliceIndex, axis === "sn" ? times[i] : "", p.mean.toFixed(2)].join(";")),
  ].join("\n");
  return { phases: list, axis, times, values, curve, baseline, peak, enhancementPct, excluded, note, csv };
}

/** Kullanıcıya gösterilecek tek satır özet (akışa/panoya). */
export function ticSummaryLine(a: TicAnalysis): string {
  const p = a.curve;
  const pat = p.pattern === "yetersiz" ? "yetersiz" : p.pattern === "washout" ? "wash-out (Tip 3)" : p.pattern === "plateau" ? "plato (Tip 2)" : "progresif (Tip 1)";
  const wo = p.washOutPct === null ? "—" : `${p.washOutPct.toFixed(1)}%`;
  const enh = a.enhancementPct === null ? "—" : `${a.enhancementPct.toFixed(1)}%`;
  return `TIC: ${pat} · zirve ${a.peak.toFixed(2)} · wash-out ${wo} · zirveye artış ${enh} · ${a.phases.length} faz (${a.axis === "sn" ? "zaman ekseni" : "faz ekseni"})`;
}

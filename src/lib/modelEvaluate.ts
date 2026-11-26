/**
 * Model değerlendirme çekirdeği (h-model-eval).
 *
 * Amaç: kayıt defterindeki bir model sürümü için **toplu skorlanan örneklerden**
 * (model her örnek için 0–1 skor üretir; referans doğru = 1/0) doğruluk
 * tablosunu deterministik biçimde çıkarmak: ROC-AUC (sıralama istatistiği,
 * bağlar ortalama sıra), duyarlılık/özgüllük/PPV/NPV/F1 (eşik tablosu),
 * Brier skoru ve beklenti kalibrasyon hatası (ECE, `modelOps.ts`).
 *
 * SINIRLILIK (dürüst kapsam):
 * - Çıkarım bu modülde ÇALIŞMAZ; skorlar çağıranın (batch işi, Workstation,
 *   ai-worker doğrulama betiği) ürettiği liste olarak alınır. Yani bu bir
 *   "batch infer" yürütücüsü değil, toplu değerlendirme API'sinin hesabıdır.
 * - Verilen skorlar klinik olasılık değildir; metrikler yalnızca verilen
 *   örneklem için geçerlidir, dış doğrulama YERİNE GEÇMEZ.
 * - n < MIN_CASES ise kart/not güncellemesine izin verilmez (uyarı döner).
 * - Tek sınıf varsa AUROC tanımsız (null) döner; çökme olmaz.
 */
import { calibrationBins, expectedCalibrationError, type CalibrationBin } from "./modelOps";

export const EVAL_MIN_CASES = 20;
export const EVAL_MAX_CASES = 5000;

export interface EvalCase {
  /** İsteğe bağlı örnek kimliği (denetim/hata ayıklama). */
  id?: string;
  /** Model skoru (0–1; uçlar dahil). */
  score: number;
  /** Referans doğru: 1 = pozitif, 0 = negatif. */
  label: 0 | 1;
}

export interface Confusion {
  tp: number; fp: number; tn: number; fn: number;
  threshold: number;
}

export interface ThresholdMetrics extends Confusion {
  accuracy: number | null;
  sensitivity: number | null;
  specificity: number | null;
  ppv: number | null;
  npv: number | null;
  f1: number | null;
}

export interface EvalReport {
  n: number;
  positives: number;
  negatives: number;
  /** ROC-AUC; tek sınıfsa null. */
  auc: number | null;
  /** Brier skoru (ortalama kare hata); n=0 ise null. */
  brier: number | null;
  /** Beklenti kalibrasyon hatası (10 bin); n=0 ise null. */
  ece: number | null;
  /** Anahtar eşiklerdeki metrikler (0.3 / 0.5 / 0.7). */
  at: ThresholdMetrics[];
  /** En iyi F1'i veren eşik (eşik tablosundan; eşitlikler düşük eşiği seçer). */
  bestF1: ThresholdMetrics | null;
  /** n < EVAL_MIN_CASES ise doldurulur. */
  warning: string | null;
  /** Kalibrasyon bölmeleri (10). */
  calibration: CalibrationBin[];
}

/** Skor/etiket listesini doğrular ve normalize eder; hatalı satır index'iyle reddedilir. */
export function parseEvalCases(input: unknown): { ok: true; cases: EvalCase[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "cases dizi olmalı." };
  if (input.length === 0) return { ok: false, error: "En az 1 örnek gerekli." };
  if (input.length > EVAL_MAX_CASES) return { ok: false, error: `En fazla ${EVAL_MAX_CASES} örnek değerlendirilebilir.` };
  const out: EvalCase[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { ok: false, error: `Örnek ${i}: nesne olmalı.` };
    const score = typeof raw.score === "number" ? raw.score : Number(raw.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      return { ok: false, error: `Örnek ${i}: score 0–1 arasında sayı olmalı.` };
    }
    const lbl = raw.label;
    const label = lbl === 1 || lbl === "1" || lbl === true ? 1 : lbl === 0 || lbl === "0" || lbl === false ? 0 : NaN;
    if (!Number.isFinite(label)) return { ok: false, error: `Örnek ${i}: label yalnız 0/1 olabilir.` };
    const id = typeof raw.id === "string" ? raw.id.slice(0, 80) : undefined;
    out.push({ id, score, label: label as 0 | 1 });
  }
  return { ok: true, cases: out };
}

export function confusionAt(cases: EvalCase[], threshold: number): Confusion {
  const t = Math.max(0, Math.min(1, threshold));
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const c of cases) {
    const pos = c.score >= t;
    if (pos && c.label === 1) tp++;
    else if (pos && c.label === 0) fp++;
    else if (!pos && c.label === 0) tn++;
    else fn++;
  }
  return { tp, fp, tn, fn, threshold: t };
}

const div = (a: number, b: number) => (b === 0 ? null : a / b);

export function metricsAt(cases: EvalCase[], threshold: number): ThresholdMetrics {
  const c = confusionAt(cases, threshold);
  const { tp, fp, tn, fn } = c;
  const sensitivity = div(tp, tp + fn);
  const specificity = div(tn, tn + fp);
  const ppv = div(tp, tp + fp);
  const npv = div(tn, tn + fn);
  const accuracy = div(tp + tn, tp + fp + tn + fn);
  const precision = ppv;
  const recall = sensitivity;
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...c, accuracy, sensitivity, specificity, ppv, npv, f1 };
}

/**
 * ROC-AUC — Mann-Whitney sıralama istatistiği. Bağlar (eşit skorlar) ortalama
 * sıra alır; tek sınıf varsa null.
 */
export function rocAuc(cases: EvalCase[]): number | null {
  const pos = cases.filter((c) => c.label === 1).length;
  const neg = cases.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...cases].sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgRank = (i + j) / 2 + 1; // 1-tabanlı ortalama sıra
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < sorted.length; k++) if (sorted[k].label === 1) rankSumPos += ranks[k];
  const u = rankSumPos - (pos * (pos + 1)) / 2;
  return u / (pos * neg);
}

export function brierScore(cases: EvalCase[]): number | null {
  if (cases.length === 0) return null;
  let sum = 0;
  for (const c of cases) sum += (c.score - c.label) ** 2;
  return sum / cases.length;
}

export const EVAL_SWEEP = [0.3, 0.5, 0.7] as const;

/** Tam değerlendirme raporu üretir. `cases` boş dizi olamaz (çağıran doğrular). */
export function evaluateBatch(cases: EvalCase[]): EvalReport {
  const n = cases.length;
  const positives = cases.reduce((a, c) => a + (c.label === 1 ? 1 : 0), 0);
  const negatives = n - positives;
  const at = EVAL_SWEEP.map((t) => metricsAt(cases, t));
  const f1s = at.map((m) => m.f1);
  let bestF1: ThresholdMetrics | null = null;
  for (let i = 0; i < at.length; i++) {
    if (f1s[i] === null) continue;
    if (!bestF1 || (f1s[i] as number) > (bestF1.f1 as number)) bestF1 = at[i];
  }
  const calibration = calibrationBins(cases.map((c) => ({ score: c.score, approved: c.label === 1 })), 10);
  const ece = expectedCalibrationError(calibration);
  return {
    n,
    positives,
    negatives,
    auc: rocAuc(cases),
    brier: brierScore(cases),
    ece,
    at,
    bestF1,
    warning: n < EVAL_MIN_CASES ? `Örneklem küçük (n=${n}; önerilen ≥ ${EVAL_MIN_CASES}) — metrikler kararsız olabilir.` : null,
    calibration,
  };
}

const fmt = (v: number | null, digits = 3) => (v === null ? "yok" : v.toFixed(digits));

/** Model kartına/denetim kaydına yazılacak tek satırlık özet. */
export function formatMetricSummary(report: EvalReport): string {
  const at05 = report.at.find((m) => m.threshold === 0.5) ?? report.at[1];
  return (
    `n=${report.n} (P=${report.positives}/N=${report.negatives}) · AUC=${fmt(report.auc)} · Brier=${fmt(report.brier)} · ECE=${fmt(report.ece)} · ` +
    `@0.5: duyarlılık=${fmt(at05.sensitivity)} özgüllük=${fmt(at05.specificity)} PPV=${fmt(at05.ppv)} F1=${fmt(at05.f1)}` +
    (report.warning ? ` · UYARI: ${report.warning}` : "")
  );
}

/**
 * Kayıt defteri notuna eklenecek EVAL satırını üretir. Öncelik: mevcut notu
 * olabildiğince KORUMAK; not uzadığında en yeni EVAL satırı asla kesilmez,
 * eski notun başı kırpılır (başına "…" konur). Toplam ≤ 500 karakter.
 */
export function appendEvalToNotes(notes: string, report: EvalReport, dateISO: string): string {
  const CAP = 500;
  const trimmed = (notes ?? "").trim();
  const sep = trimmed ? " | " : "";
  const full = `[EVAL ${dateISO}] ${formatMetricSummary(report)}`;
  const short = `[EVAL ${dateISO}] n=${report.n} AUC=${fmt(report.auc)} ECE=${fmt(report.ece)}`;
  for (const line of [full, short]) {
    if (trimmed.length + sep.length + line.length <= CAP) return `${trimmed}${sep}${line}`;
  }
  const line = short;
  const keep = Math.max(0, CAP - sep.length - line.length);
  const keptNotes = keep > 1 ? `…${trimmed.slice(trimmed.length - (keep - 1))}` : "";
  return `${keptNotes}${sep}${line}`.slice(0, CAP);
}

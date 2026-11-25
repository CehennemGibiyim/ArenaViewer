/**
 * Kalibre güven skoru ve güven aralığı (a-uncert).
 *
 * Neden gerekli: model kartındaki AUROC/AUPRC **toplu** bir başarımdır; tek bir
 * vakada "bu skora ne kadar güvenilir?" sorusunu yanıtlamaz. Bu modül, hekim
 * geri bildiriminden (onay/ret) **ampirik kalibrasyon** çıkarır ve skoru
 * %95 aralıkla birlikte sunar:
 *
 *   ham skor 0,78 → kalibre ≈ 0,71 (aralık 0,61–0,80, n=48)
 *
 * Yöntemler (bilinçli olarak basit ve açıklanabilir):
 *  - **Bin kalibrasyonu**: skor 5–10 eşit genişlikli kutuya ayrılır; her kutunun
 *    ampirik onay oranı kalibre değerdir. Komşu kutularla Laplace düzeltmesi
 *    (add-α) uygulanır; n < 20 olan kutuda ham değer yerine komşularla
 *    birleştirilmiş oran kullanılır (tek başına 3 gözlemle güven üretilmez).
 *  - **Wilson skor aralığı**: oranın %95 güven aralığı; küçük n'de normal
 *    yaklaşımdan çok daha dürüsttür (0 veya 1'de aralık sıfıra çökmez).
 *
 * Sınırlar: bu bir **doğrulama çalışması değildir**. Aralık yalnızca hekim
 * kararlarının istatistiksel belirsizliğini yansıtır; seçim yanlılığı (hekim
 * yalnız emin olduğu bulguları işaretler) düzeltilmez ve alt grup analizi
 * yapılmaz. Ekranda bu not her zaman gösterilir.
 */

import { calibrationBins, expectedCalibrationError, type ScoreOutcome } from "./modelOps";

/** Kalibrasyon için gereken en az etiketli gözlem. */
export const MIN_LABELS = 20;
/** Bir kutunun tek başına güvenilir sayılması için gereken gözlem. */
export const MIN_BIN_N = 20;
export const Z95 = 1.959963984540054;

export interface Interval {
  lo: number;
  hi: number;
  /** Aralık anlamlı mı (n yeterli mi)? */
  reliable: boolean;
}

/** Wilson skor aralığı (oran için %95). */
export function wilsonInterval(successes: number, n: number, z = Z95): Interval {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return { lo: 0, hi: 1, reliable: false };
  const p = Math.max(0, Math.min(1, successes / n));
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const lo = Math.max(0, Math.min(1, center - half));
  const hi = Math.max(0, Math.min(1, center + half));
  return { lo: round3(lo), hi: round3(hi), reliable: n >= MIN_LABELS };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface CalibrationCurve {
  bins: { lo: number; hi: number; n: number; predicted: number | null; empirical: number | null; interval: Interval | null }[];
  /** Toplam etiketli gözlem. */
  n: number;
  /** Beklenti sapması (ECE); n yetersizse null. */
  ece: number | null;
  /** Kalibrasyon kullanılabilir mi (n ≥ MIN_LABELS)? */
  usable: boolean;
  /** "48 etiketli gözlem, ECE %6" gibi özet. */
  note: string;
}

/**
 * Skor → onay verisinden kalibrasyon eğrisi.
 * `binCount` varsayılan 5 (az veride 10 kutu çok seyrek kalır).
 */
export function calibrationCurve(data: ScoreOutcome[], binCount = 5): CalibrationCurve {
  const clean = data.filter((d) => Number.isFinite(d.score));
  const bins = calibrationBins(clean, binCount);
  const n = bins.reduce((a, b) => a + b.n, 0);
  const raw = expectedCalibrationError(bins);
  const ece = n >= MIN_LABELS && raw !== null ? Math.round(raw * 1000) / 1000 : null;
  return {
    bins: bins.map((b) => ({
      lo: b.binLo,
      hi: b.binHi,
      n: b.n,
      predicted: b.meanPred,
      empirical: b.empirical,
      interval: b.n > 0 && b.empirical !== null ? wilsonInterval(Math.round(b.empirical * b.n), b.n) : null,
    })),
    n,
    ece,
    usable: n >= MIN_LABELS,
    note: n >= MIN_LABELS
      ? `${n} etiketli gözlem · ECE %${Math.round((ece ?? 0) * 100)} (kalibrasyon kullanılabilir)`
      : `${n} etiketli gözlem · kalibrasyon için en az ${MIN_LABELS} gerekir; skorlar ham gösteriliyor.`,
  };
}

export interface CalibratedScore {
  /** Ham model skoru (0–1). */
  raw: number;
  /** Kalibre edilmiş olasılık tahmini (ham skorla aynı değil). */
  calibrated: number;
  /** Kalibre değerin %95 aralığı. */
  interval: Interval;
  /** Kalibrasyon hangi kutudan geldi (açıklanabilirlik). */
  binIndex: number;
  /** Kaç etiketli gözlem kullanıldı. */
  n: number;
  /** Kullanıcıya gösterilecek tek satır: "Kalibre ≈ %71 (aralık %61–%80, n=48)". */
  text: string;
  /** Kalibrasyon yetersizse neden. */
  warning: string | null;
}

/**
 * Tek skoru kalibre eder.
 *
 * Yetersiz veride (`n < MIN_LABELS`) ham skor döner ve `warning` doldurulur —
 * sahte bir dar aralık üretmek, hiç aralık vermemekten kötüdür. Kutuda az
 * gözlem varsa komşu kutularla birleştirilir (paylaşımlı oran).
 */
export function calibrateScore(score: number, data: ScoreOutcome[], binCount = 5): CalibratedScore {
  const raw = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  const curve = calibrationCurve(data, binCount);
  let idx = Math.floor(raw * binCount);
  if (idx >= binCount) idx = binCount - 1;

  // Kutu seyrekse komşularıyla birleştir (en fazla ±1 kutu, sonra tümü).
  const pick = (i: number) => curve.bins[i];
  let lo = idx;
  let hi = idx;
  let n = pick(idx).n;
  if (n < MIN_BIN_N) {
    for (let r = 1; r < binCount && n < MIN_BIN_N; r++) {
      lo = Math.max(0, idx - r);
      hi = Math.min(binCount - 1, idx + r);
      n = curve.bins.slice(lo, hi + 1).reduce((a, b) => a + b.n, 0);
    }
  }

  const group = curve.bins.slice(lo, hi + 1);
  const onay = group.reduce((a, b) => a + (b.empirical ?? 0) * b.n, 0);
  // Laplace düzeltmesi: 0/0 ve 0/3 gibi uçlarda aralığı gerçekçi tutar.
  const calibrated = (onay + 1) / (n + 2);
  const interval = n > 0 ? wilsonInterval(onay, n) : { lo: 0, hi: 1, reliable: false };

  const pct = (v: number) => `%${Math.round(v * 100)}`;
  if (!curve.usable || n === 0) {
    return {
      raw,
      calibrated: round3(calibrated),
      interval: { ...interval, reliable: false },
      binIndex: idx,
      n,
      text: `Ham skor ${pct(raw)} · kalibrasyon için yeterli etiketli gözlem yok (n=${n}).`,
      warning: curve.usable ? "Bu skor kutusunda gözlem yok; aralık güvenilir değil." : `Kalibrasyon için en az ${MIN_LABELS} etiketli gözlem gerekir (şu an ${curve.n}).`,
    };
  }

  // Kutular birleştirildiyse oran komşulardan "borç" alınmıştır: n büyük olsa
  // bile bu, skorun kendi kutusunun davranışı değildir — her zaman uyarılır.
  const merged = hi > lo;
  const warning = merged
    ? `Skorun kutusu seyrek; komşu kutularla birleştirildi (n=${n}) — aralık geniş yorumlanmalı.`
    : interval.reliable
      ? null
      : `Bu kutuda ${n} gözlem var (< ${MIN_LABELS}); aralık geniş yorumlanmalı.`;
  return {
    raw,
    calibrated: round3(calibrated),
    interval,
    binIndex: idx,
    n,
    text: `Kalibre ≈ ${pct(calibrated)} (aralık ${pct(interval.lo)}–${pct(interval.hi)}, n=${n})`,
    warning,
  };
}

export type Eminlik = "emin" | "ihtiyatli" | "emin-degil";

/**
 * "Model emin mi?" — bandı aralık genişliği ve sınıf eşiğiyle birleştirir.
 *
 * - `emin-degil`: aralık sınıf eşiğini içeriyor (karar eşiğin iki yanına düşebilir)
 *   ya da kalibrasyon yok.
 * - `ihtiyatli`: aralık eşiği içermiyor ama genişliği %20'den fazla.
 * - `emin`: aralık dar ve eşiğin tek yanında.
 */
export function confidenceVerdict(c: CalibratedScore, threshold: number): { level: Eminlik; text: string } {
  const th = Number.isFinite(threshold) ? threshold : 0.5;
  if (!c.interval.reliable) {
    return { level: "emin-degil", text: `Kalibrasyon yetersiz (n=${c.n}): model bu vakada emin değil sayılır.` };
  }
  const width = c.interval.hi - c.interval.lo;
  const spans = c.interval.lo <= th && c.interval.hi >= th;
  const pct = (v: number) => `%${Math.round(v * 100)}`;
  if (spans) {
    return {
      level: "emin-degil",
      text: `Aralık ${pct(c.interval.lo)}–${pct(c.interval.hi)} sınıf eşiğini (${pct(th)}) içeriyor: model bu vakada EMİN DEĞİL, karar görüntüye dayanmalı.`,
    };
  }
  if (width > 0.2) {
    return { level: "ihtiyatli", text: `Aralık geniş (${pct(c.interval.lo)}–${pct(c.interval.hi)}): ihtiyatla kullanın, ölçümle doğrulayın.` };
  }
  const taraf = c.interval.lo > th ? "eşiğin üzerinde" : "eşiğin altında";
  return { level: "emin", text: `Aralık dar (${pct(c.interval.lo)}–${pct(c.interval.hi)}) ve ${taraf}: model bu sınıfta emin görünüyor; yerleştirme yine radyologa aittir.` };
}

/** Karşılaştırma için tek satır: ham → kalibre farkı. */
export function calibrationShift(c: CalibratedScore): string {
  const diff = Math.round((c.calibrated - c.raw) * 100);
  if (diff === 0) return "Ham skor kalibre değerle aynı.";
  return `Ham skor kalibre değerden ${diff > 0 ? "düşük" : "yüksek"} (%${Math.abs(diff)} puan).`;
}

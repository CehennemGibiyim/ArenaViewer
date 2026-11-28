/**
 * Güven kalibrasyonu (a-uncert) — hekim geri bildiriminden **düzeltilmiş skor**.
 *
 * Neden: model skoru (0–1) kalibre olasılık DEĞİLDİR. "Skor %85" dediğinde
 * gerçekte bu bulguların %85'i doğru çıkmıyorsa, ekrandaki güven yüzdesi
 * yanıltıcıdır. `uncertainty.ts` yalnız skorun eşiğe uzaklığını bantlar; bu modül
 * hekim onay/ret kararlarından **ampirik kalibrasyon** öğrenir.
 *
 * Yöntem: **ısotonik regresyon (PAV — pool adjacent violators)**. Eşit aralıklı
 * bölmeler yerine komşu ihlalleri birleştirir; tekdüze (monoton) ve deterministik
 * bir eşleme üretir. Bölme tabanlı eğri (0,1/5,2/5…) küçük örnekte testere dişi
 * yapar ve "skor arttıkça güven artar" garantisi vermez.
 *
 * ── Dürüst kapsam ───────────────────────────────────────────────────────────
 * 1. Etiket **hekim kararıdır** (onay = 1, ret = 0). Altın standart yoktur; bu
 *    yüzden sonuç "modelin klinik doğruluğu" değil, **hekimle uyum kalibrasyonu**dur.
 * 2. Düzenlenen bulgu (içerik hekimce düzeltildi) **dışarıda bırakılır**: bulgunun
 *    varlığı kabul edilmiş ama yeri/ölçüsü değişmiştir → etiket belirsizdir.
 * 3. Kalibrasyon **eşiği değiştirmez**; skoru yeniden yorumlar. Kalibre skorun
 *    eşiği geçip geçmediği kararı değiştirebilir — bu yüzden karar yolu ayrı bir
 *    fonksiyondadır ve çağıran açıkça seçer.
 * 4. Yetersiz veride (`n < CALIB_MIN_CASES`) eşleme **üretilmez**; skor olduğu gibi
 *    kalır ve "kalibre değil" bilgisi korunur. Sessizce düzeltilmiş gibi gösterilmez.
 * 5. Örneklem-içi kalibrasyondur (eğitim = ölçüm verisi). Dış doğrulama değildir;
 *    bu yüzden `inSample: true` alanı taşınır ve arayüz bunu yazar.
 */

/** Kalibrasyon eşlemesi için en az etiketli bulgu. */
export const CALIB_MIN_CASES = 30;
/** Çok fazla noktada eşleme üretmemek için üst sınır. */
export const CALIB_MAX_CASES = 20_000;
/** Eşleme tablosunda tutulacak en fazla blok. */
export const CALIB_MAX_BLOCKS = 64;

export interface CalibCase {
  /** Model skoru (0–1) */
  score: number;
  /** Etiket: hekim onayı. null → etiket yok (düzenlenen/bekleyen) → dışarıda. */
  label: 0 | 1 | null;
}

export interface CalibBlock {
  /** Bu bloğa giren skor aralığı */
  lo: number;
  hi: number;
  n: number;
  /** Kalibre olasılık = bloktaki onay oranı */
  p: number;
}

export interface Calibration {
  kind: "isotonic";
  blocks: CalibBlock[];
  n: number;
  /** Eşleme üretildi mi (n ≥ CALIB_MIN_CASES ve en az 2 blok) */
  ok: boolean;
  reason: string;
  /** Örneklem-içi (eğitim = ölçüm) — dış doğrulama yapılmadı */
  inSample: true;
  /** Ortalama |kalibre − ham| — "ne kadar düzeltiyoruz" göstergesi */
  meanShift: number | null;
}

export const EMPTY_CALIBRATION: Calibration = {
  kind: "isotonic", blocks: [], n: 0, ok: false,
  reason: "Kalibrasyon için yeterli etiketli bulgu yok.", inSample: true, meanShift: null,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Isotonik regresyon (PAV). Girdi skora göre sıralanır; aynı skorlar tek grupta
 * toplanır (sıra bağımlılığı olmaz → deterministik).
 */
export function fitIsotonic(cases: CalibCase[]): Calibration {
  const labeled = cases.filter((c) => c.label === 0 || c.label === 1);
  const n = labeled.length;
  if (n === 0) return { ...EMPTY_CALIBRATION, reason: "Etiketli bulgu yok." };
  if (n < CALIB_MIN_CASES) {
    return { ...EMPTY_CALIBRATION, n, reason: `Kalibrasyon için en az ${CALIB_MIN_CASES} etiketli bulgu gerekir (şu an ${n}).` };
  }
  // 1) skora göre sırala, aynı skoru birleştir
  const sorted = [...labeled].sort((a, b) => a.score - b.score);
  type Grp = { lo: number; hi: number; n: number; pos: number };
  const grps: Grp[] = [];
  for (const c of sorted) {
    const s = clamp01(c.score);
    const last = grps[grps.length - 1];
    if (last && last.lo === s && last.hi === s) {
      last.n++; last.pos += c.label as number;
    } else {
      grps.push({ lo: s, hi: s, n: 1, pos: c.label as number });
    }
  }
  // 2) PAV: monotonluk ihlalini birleştir
  const blocks: Grp[] = [];
  for (const g of grps) {
    blocks.push({ ...g });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.pos / a.n <= b.pos / b.n) break;
      blocks.pop(); blocks.pop();
      blocks.push({ lo: a.lo, hi: b.hi, n: a.n + b.n, pos: a.pos + b.pos });
    }
  }
  const out: CalibBlock[] = blocks.slice(0, CALIB_MAX_BLOCKS).map((b) => ({
    lo: b.lo, hi: b.hi, n: b.n, p: b.pos / b.n,
  }));
  const ok = out.length >= 2 && n >= CALIB_MIN_CASES;
  const shifted = labeled.reduce((acc, c) => acc + Math.abs(applyCalibration({ ...EMPTY_CALIBRATION, blocks: out, ok, n }, clamp01(c.score)) - clamp01(c.score)), 0);
  return {
    kind: "isotonic",
    blocks: out,
    n,
    ok,
    reason: ok
      ? `Isotonik eşleme ${out.length} blokla kuruldu (${n} etiketli bulgu). Örneklem-içi: dış doğrulama yapılmadı.`
      : `Tek blok oluştu (${n} etiketli bulgu): skorlar ayrışmıyor, kalibrasyon anlamlı değil.`,
    inSample: true,
    meanShift: n ? shifted / n : null,
  };
}

/**
 * Ham skoru kalibre olasılığa çevirir.
 * Eşleme yoksa skor **değişmeden** döner (uydurma eğri yok).
 */
export function applyCalibration(cal: Calibration | null | undefined, score: number): number {
  const s = clamp01(score);
  if (!cal || !cal.ok || cal.blocks.length === 0) return s;
  const b = cal.blocks;
  if (s <= b[0].lo) return b[0].p;
  for (let i = 1; i < b.length; i++) {
    if (s <= b[i].lo) {
      // iki blok arasını ara değerle köprüle (parçalı-doğrusal, tekdüze)
      const p0 = b[i - 1].p, p1 = b[i].p;
      const x0 = b[i - 1].hi, x1 = b[i].lo;
      if (x1 <= x0 || p1 === p0) return p1;
      const t = (s - x0) / (x1 - x0);
      return clamp01(p0 + t * (p1 - p0));
    }
  }
  return b[b.length - 1].p;
}

export type CalibConfidence = "iyi" | "orta" | "zayif" | "bilinmiyor";

/**
 * Kalibrasyon kalitesi. ECE (beklenti kalibrasyon hatası) eşikleri:
 *  ≤0.05 iyi · ≤0.10 orta · >0.10 zayıf · null bilinmiyor.
 */
export function calibrationQuality(ece: number | null): { level: CalibConfidence; note: string } {
  if (ece === null || !Number.isFinite(ece)) {
    return { level: "bilinmiyor", note: "ECE hesaplanamadı: yeterli etiketli bulgu yok." };
  }
  if (ece <= 0.05) return { level: "iyi", note: `Kalibrasyon iyi (ECE ${ece.toFixed(3)}).` };
  if (ece <= 0.1) return { level: "orta", note: `Kalibrasyon orta (ECE ${ece.toFixed(3)}); skoru olasılık gibi okumayın.` };
  return { level: "zayif", note: `Kalibrasyon zayıf (ECE ${ece.toFixed(3)}): skor yüzdesi güvenilir değil, düzeltme gerekli.` };
}

/**
 * Karar eşiği ızgarası: kalibre skorla, verilen kesinlik hedefini tutan en yüksek
 * duyarlılığı veren eşiği arar. Yeterli veri yoksa `null`.
 */
export interface ThresholdChoice {
  threshold: number;
  precision: number;
  recall: number;
  kept: number;
}

export function chooseThreshold(
  cases: CalibCase[],
  cal: Calibration | null,
  minPrecision = 0.8,
  grid: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9],
): ThresholdChoice | null {
  const labeled = cases.filter((c) => c.label === 0 || c.label === 1);
  if (labeled.length < CALIB_MIN_CASES) return null;
  const pos = labeled.filter((c) => c.label === 1).length;
  let best: ThresholdChoice | null = null;
  for (const t of grid) {
    const kept = labeled.filter((c) => applyCalibration(cal, c.score) >= t);
    if (kept.length === 0) continue;
    const tp = kept.filter((c) => c.label === 1).length;
    const precision = tp / kept.length;
    const recall = tp / pos;
    if (precision < minPrecision) continue;
    if (!best || recall > best.recall) best = { threshold: t, precision, recall, kept: kept.length };
  }
  return best;
}

export type ReviewAction = "goster" | "incele" | "gizle";

export interface ReviewDecision {
  action: ReviewAction;
  /** Arayüzde gösterilecek kalibre olasılık (0–1) */
  calibrated: number;
  /** Ham skor */
  raw: number;
  /** Karar nedeni (insan okunur, Türkçe) */
  why: string;
}

/**
 * Tek bir aday için gösterim kararı — "düşük güvende **hekim incelesin**" kuralı.
 *
 * Kurallar (açıkça yazılı, sessiz değil):
 *  - kalibre ≥ gösterEşiği → `goster`
 *  - inceleEşiği ≤ kalibre < gösterEşiği → `incele` (ekranda "hekim incelesin" etiketi)
 *  - kalibre < inceleEşiği → `gizle` (aday önceliklendirilmez)
 *  - kalibrasyon yoksa: ham skor kullanılır ve **`incele`**ye asla yükseltilmez
 *    (kalibre olmayan skora göre "emin" demek yanıltıcı olur); ham skor yüksekse
 *    `goster` + "kalibre değil" notu.
 */
export function reviewDecision(
  raw: number,
  cal: Calibration | null | undefined,
  opts: { showAt?: number; inspectAt?: number } = {},
): ReviewDecision {
  const showAt = opts.showAt ?? 0.7;
  const inspectAt = opts.inspectAt ?? 0.4;
  const r = clamp01(raw);
  const calibrated = applyCalibration(cal, r);
  const isCal = !!cal && cal.ok;
  if (!isCal) {
    return {
      action: r >= showAt ? "goster" : "gizle",
      calibrated: r, raw: r,
      why: r >= showAt
        ? `Ham skor ${Math.round(r * 100)}% (eşik ${Math.round(showAt * 100)}%); model kalibre değil — yüzde olasılık olarak okunmamalı.`
        : `Ham skor ${Math.round(r * 100)}% eşiğin altında; kalibrasyon verisi olmadığı için skor düzeltilmedi.`,
    };
  }
  if (calibrated >= showAt) {
    return {
      action: "goster", calibrated, raw: r,
      why: `Kalibre olasılık ${Math.round(calibrated * 100)}% (ham ${Math.round(r * 100)}%), gösterim eşiği ${Math.round(showAt * 100)}%.`,
    };
  }
  if (calibrated >= inspectAt) {
    return {
      action: "incele", calibrated, raw: r,
      why: `Kalibre olasılık ${Math.round(calibrated * 100)}% — model emin değil; HEKİM İNCELEMELİ (${Math.round(inspectAt * 100)}–${Math.round(showAt * 100)}% bandı).`,
    };
  }
  return {
    action: "gizle", calibrated, raw: r,
    why: `Kalibre olasılık ${Math.round(calibrated * 100)}% inceleme eşiğinin (${Math.round(inspectAt * 100)}%) altında.`,
  };
}

/** Doğrulama: kalibrasyon eşlemesi monoton mu (skor ↑ iken olasılık ↓ olamaz). */
export function isMonotonic(cal: Calibration): boolean {
  for (let i = 1; i < cal.blocks.length; i++) {
    if (cal.blocks[i].p < cal.blocks[i - 1].p - 1e-9) return false;
  }
  return true;
}

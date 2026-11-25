/**
 * Çok modaliteli (ör. BT ↔ MR) hizalama için **karşılıklı bilgi (MI)** metriği.
 *
 * Neden: normalleştirilmiş çapraz korelasyon (NCC) aynı modalitede iyi çalışır ama
 * farklı modalitelerde yoğunluk ilişkisi **doğrusal değildir** (BT'de kemik parlak,
 * MR T1'de koyu; PET'te metabolizma). MI, iki görüntünün ortak histogramındaki
 * istatistiksel bağımlılığı ölçer; yoğunluk eşlemesi monoton olmasa da hizalamayı
 * bulur. Bu modül NMI (normalize karşılıklı bilgi = 2·I/(H_A+H_B), 0…1) hesaplar ve
 * yalnız **öteleme** için kabadan inceye arama yapar.
 *
 * Dürüst sınırlar:
 *  - Yalnız **ötelme** (dx, dy) aranır; dönme/ölçek/deformasyon MI ile aranmaz.
 *  - Histogram bin sayısı ve örnekleme sonucu etkiler; 32 bin + tüm geçerli pikseller
 *    kullanılır (hızlı, deterministik).
 *  - MI hizalama "doğru anatomi" garantisi vermez (kötü ünlü yerel maksimumlar vardır);
 *    skor eşiğin altındaysa sonuç uygulanmaz ve hekim görsel doğrular.
 */
import { applyRigid, normalizeRigid, type RigidParams } from "./fusionRigid";
import { downsample } from "./registration";

/** Bu NMI değerinin altındaki MI hizalaması güvenilir sayılmaz (deneysel eşik). */
export const MIN_NMI = 0.2;

export interface MiResult {
  /** Karşılıklı bilgi (bit). */
  mi: number;
  /** Normalize karşılıklı bilgi 2·I/(H_A+H_B), 0…1. */
  nmi: number;
  /** Marjinal entropiler (bit). */
  hA: number;
  hB: number;
  /** Geçerli (sonlu) piksel sayısı. */
  n: number;
}

/** Bir dizinin Shannon entropisi (bit). */
export function entropy(values: ArrayLike<number>, n?: number): number {
  const total = n ?? values.length;
  if (total <= 0) return 0;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < total; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return 0;
  const bins = 32;
  const hist = new Float64Array(bins);
  const scale = bins / (max - min);
  for (let i = 0; i < total; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    hist[Math.min(bins - 1, Math.max(0, Math.floor((v - min) * scale)))]++;
  }
  let h = 0;
  for (const c of hist) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * İki görüntü arasında karşılıklı bilgi. `mask[i]` 0 ise piksel atlanır
 * (örtüşmeyen/NaN alanlar). Bin sayısı sabit 32'dir (deterministik).
 */
export function mutualInformation(a: ArrayLike<number>, b: ArrayLike<number>, mask?: Uint8Array | null, bins = 32): MiResult {
  const B = Math.max(4, Math.min(64, Math.round(bins)));
  const n = a.length;
  let nA = 0;
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const x = a[i], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    nA++;
    if (x < aMin) aMin = x;
    if (x > aMax) aMax = x;
    if (y < bMin) bMin = y;
    if (y > bMax) bMax = y;
  }
  if (nA < 16 || !(aMax > aMin) || !(bMax > bMin)) return { mi: 0, nmi: 0, hA: 0, hB: 0, n: nA };
  const joint = new Float64Array(B * B);
  const hAarr = new Float64Array(B);
  const hBarr = new Float64Array(B);
  const sa = B / (aMax - aMin);
  const sb = B / (bMax - bMin);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const x = a[i], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const ia = Math.min(B - 1, Math.max(0, Math.floor((x - aMin) * sa)));
    const ib = Math.min(B - 1, Math.max(0, Math.floor((y - bMin) * sb)));
    joint[ia * B + ib]++;
    hAarr[ia]++;
    hBarr[ib]++;
  }
  let mi = 0;
  for (let ia = 0; ia < B; ia++) {
    const pa = hAarr[ia] / nA;
    if (pa <= 0) continue;
    for (let ib = 0; ib < B; ib++) {
      const pj = joint[ia * B + ib] / nA;
      if (pj <= 0) continue;
      const pb = hBarr[ib] / nA;
      mi += pj * Math.log2(pj / (pa * pb));
    }
  }
  const hA = entropyBins(hAarr, nA);
  const hB = entropyBins(hBarr, nA);
  const nmi = hA + hB > 1e-9 ? Math.max(0, Math.min(1, (2 * mi) / (hA + hB))) : 0;
  return { mi: Math.max(0, mi), nmi, hA, hB, n: nA };
}

function entropyBins(hist: Float64Array, total: number): number {
  let h = 0;
  for (const c of hist) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/** Hizalama metriği: aynı modalite → NCC, farklı modalite → MI (karşılıklı bilgi). */
export type AlignMetric = "ncc" | "mi";

/**
 * Modalite çiftine göre metrik seçimi. Aynı modalite (BT↔BT, MR↔MR) için NCC daha
 * keskin ve hızlıdır; farklı modalitelerde (BT↔MR, BT↔PET, US↔BT) yoğunluk ilişkisi
 * doğrusal olmadığı için MI kullanılır.
 */
export function metricFor(a?: string | null, b?: string | null): AlignMetric {
  const norm = (m?: string | null) => (m ?? "").trim().toUpperCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return "ncc";
  return x === y ? "ncc" : "mi";
}

export interface MiAlignOptions {
  /** En büyük kayma (tam çözünürlük px). */
  maxShift?: number;
  /** Kaba arama adımı (px). */
  coarseStep?: number;
  /** Altında MI hesaplanmayacak örtüşme oranı. */
  minOverlap?: number;
  /** Histogram bin sayısı. */
  bins?: number;
}

export interface MiAlignEstimate {
  rigid: RigidParams;
  /** En iyi adayın NMI skoru (0…1). */
  score: number;
  /** Hizalama öncesi (dx=dy=0) NMI. */
  baseline: number;
  improved: boolean;
  candidates: number;
  /** Hesaplamada kullanılan en ince indirgeme kademesi. */
  level: number;
}

/** MI tabanlı hizalamanın güvenilir sayılıp sayılmadığı. */
export function miTrusted(e: { score: number; improved: boolean }): boolean {
  return Number.isFinite(e.score) && e.score >= MIN_NMI && e.improved;
}

/**
 * Öteleme için MI tabanlı kabadan inceye arama (farklı modaliteler).
 * `ref` hedef kesit, `mov` hareketli kesit (aynı ızgara).
 */
export function estimateTranslationMI(
  ref: ArrayLike<number>,
  mov: ArrayLike<number>,
  w: number,
  h: number,
  opts: MiAlignOptions = {}
): MiAlignEstimate {
  const maxShift = Math.max(0, Math.min(200, opts.maxShift ?? 25));
  const step0 = Math.max(1, Math.round(opts.coarseStep ?? 4));
  const minOverlap = Math.max(0.05, Math.min(0.95, opts.minOverlap ?? 0.25));
  const bins = Math.max(4, Math.min(64, Math.round(opts.bins ?? 32)));
  const levels = w >= 256 && h >= 256 ? [4, 2, 1] : w >= 96 ? [2, 1] : [1];

  // Her kademe için indirgenmiş görüntüler bir kez hazırlanır; aday başına
  // yeniden indirgeme yapılmaz (512²'de arama maliyeti bununla düşer).
  const prepped = levels.map((f) => ({ f, ref: downsample(ref, w, h, f), mov: downsample(mov, w, h, f) }));
  const scoreAt = (prep: { f: number; ref: { data: Float32Array; w: number; h: number }; mov: { data: Float32Array; w: number; h: number } }, dx: number, dy: number): number | null => {
    const aligned = applyRigid(prep.mov.data, prep.mov.w, prep.mov.h, normalizeRigid({ dx: dx / prep.f, dy: dy / prep.f }));
    const mask = new Uint8Array(aligned.length);
    let valid = 0;
    for (let i = 0; i < aligned.length; i++) {
      if (Number.isFinite(aligned[i]) && Number.isFinite(prep.ref.data[i])) {
        mask[i] = 1;
        valid++;
      }
    }
    if (valid / aligned.length < minOverlap) return null;
    const r = mutualInformation(prep.ref.data, aligned, mask, bins);
    return r.nmi > 0 ? r.nmi : null;
  };

  const baseline = scoreAt(prepped[prepped.length - 1], 0, 0) ?? 0;
  let best = { dx: 0, dy: 0, score: baseline };
  let candidates = 1;
  for (let li = 0; li < prepped.length; li++) {
    const prep = prepped[li];
    const last = li === prepped.length - 1;
    const radius = li === 0 ? maxShift : Math.max(2, Math.round(maxShift / Math.pow(2, li + 1)));
    const step = last ? 0.5 : Math.max(1, Math.round(step0 / Math.pow(2, li)));
    const cx = best.dx;
    const cy = best.dy;
    for (let dy = cy - radius; dy <= cy + radius + 1e-9; dy += step) {
      for (let dx = cx - radius; dx <= cx + radius + 1e-9; dx += step) {
        candidates++;
        const s = scoreAt(prep, dx, dy);
        if (s === null) continue;
        if (s > best.score + 1e-9) best = { dx, dy, score: s };
      }
    }
  }
  const rigid = normalizeRigid({ dx: best.dx, dy: best.dy, rotDeg: 0, scale: 1 });
  return {
    rigid,
    score: best.score,
    baseline,
    improved: best.score > baseline + 0.01,
    candidates,
    level: 1,
  };
}

/** Kullanıcıya gösterilecek durum cümlesi. */
export function miNote(e: MiAlignEstimate, trusted = miTrusted(e)): string {
  const p = `dx ${e.rigid.dx.toFixed(1)} px · dy ${e.rigid.dy.toFixed(1)} px`;
  return trusted
    ? `Çok modaliteli hizalama (MI): NMI ${e.baseline.toFixed(2)} → ${e.score.toFixed(2)}, ${p} (${e.candidates} aday). Hekim görsel doğrulaması gerekir.`
    : `MI hizalaması güvenilmez (NMI ${e.score.toFixed(2)} < ${MIN_NMI} ya da kazanç yok). Öneri: ${p} — elle kontrol edin.`;
}

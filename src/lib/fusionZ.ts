/**
 * Füzyon için **kesitler arası (z) kayma** kestirimi.
 *
 * Neden: `resampleOnto` hedef kesitin hasta koordinatına (IPP/IOP) en yakın hareketli
 * kesiti seçer. İki seri aynı Frame of Reference'ı paylaşsa bile hasta masada farklı
 * konumda yattıysa ya da nefes fazı farklıysa, hareketli seri **z ekseninde** kaymış
 * olur; bu durumda katı/elastik **in-plane** hizalama (dx, dy, dönme, ölçek) hatayı
 * düzeltemez ve bindirme kayar/boşalır (örtüşme `spacing × 0.75` sınırıyla kesilir).
 *
 * Yöntem: hedef seriden eşit aralıklı kesitler seçilir, her aday z kayması için
 * hareketli serinin **karşılık gelen** kesiti bulunur ve indirgenmiş kesitler
 * arasında NCC hesaplanır. Skorların ortalaması en yüksek olan kayma seçilir;
 * komşu skorlarla **parabolik incelme** yapılarak yarım kesit altı duyarlılık elde
 * edilir.
 *
 * Dürüst sınırlar:
 *  - Yalnız **öteleme** (z boyunca sabit kayma). Eğim/eğrilik, kesit aralığı
 *    değişimi (resampling) ve 3B hacim kaydı YOKTUR.
 *  - Farklı modalitelerde NCC zayıftır; bu durumda kayma kestirimi güvenilmez
 *    sayılır (füzyonda in-plane MI hizalaması ayrı iştir).
 *  - Kesit sayısı azsa (< 3) ya da kesitler arasında bilgi yoksa (düz seri) kayma
 *    bildirilmez; 0 döner ve neden yazılır.
 *  - Sonuç tanı aracı değildir; hekim görsel doğrular.
 */
import type { SeriesData } from "./types";
import { nccMasked } from "./registration";
import { sameFrame } from "./planes";

/** Bu skorun altındaki z kayması güvenilir sayılmaz. */
export const MIN_Z_SCORE = 0.5;
/** Kesit başına indirgeme sınırı (en uzun kenar). */
const MAX_SIDE = 64;

export interface ZShiftOptions {
  /** Aranacak en büyük kayma (mm). Varsayılan 30 mm. */
  maxShiftMm?: number;
  /** Arama adımı (mm). Varsayılan kesit aralığının yarısı. */
  stepMm?: number;
  /** Karşılaştırılacak en çok kesit çifti (hız). Varsayılan 24. */
  maxPairs?: number;
  /** Altında NCC hesaplanmayacak geçerli piksel oranı. */
  minOverlap?: number;
}

export interface ZShiftEstimate {
  /** Hareketli serinin hedefe göre z kayması (mm, + = hareketli seri +normal yönünde kaymış). */
  dzMm: number;
  /** Aynı kayma, kesit birimi (hareketli serinin kesit aralığı). */
  dzSlices: number;
  /** En iyi kaymada ortalama NCC. */
  score: number;
  /** Kayma 0 iken ortalama NCC. */
  scoreBefore: number;
  /** Kullanılan kesit çifti sayısı. */
  pairs: number;
  improved: boolean;
  /** Kestirim yapılamadıysa nedeni. */
  reason?: string;
}

/** Serinin z yönünde kesit aralığı (mm). */
export function sliceSpacingOf(s: SeriesData): number {
  const sp = s.sliceSpacing || s.sliceThickness || 0;
  return Number.isFinite(sp) && sp > 0 ? sp : 0;
}

/** Kesiti en uzun kenarı ≤ MAX_SIDE olacak şekilde kutu ortalamasıyla indirger. */
function shrinkSlice(sl: ArrayLike<number>, w: number, h: number): { data: Float32Array; w: number; h: number } {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / MAX_SIDE));
  if (f === 1) return { data: Float32Array.from(sl as ArrayLike<number>), w, h };
  const nw = Math.max(1, Math.floor(w / f));
  const nh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = y * f + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = x * f + dx;
          if (sx >= w) break;
          const v = sl[sy * w + sx];
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      out[y * nw + x] = n ? sum / n : NaN;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Kesitlerin z konumu (hasta koordinatı, mm) — IPP'nin normal izdüşümü. */
export function slicePositions(s: SeriesData): number[] | null {
  if (!s.ipp || !s.orientation) return null;
  const [r0, r1, r2, c0, c1, c2] = s.orientation;
  const nx = r1 * c2 - r2 * c1, ny = r2 * c0 - r0 * c2, nz = r0 * c1 - r1 * c0;
  const len = Math.hypot(nx, ny, nz) || 1;
  return s.ipp.map((p) => (p[0] * nx + p[1] * ny + p[2] * nz) / len);
}

/** Sıralı konum dizisinde verilen konuma en yakın kesit indeksi. */
function nearestIndex(pos: number[], k: number): number {
  let lo = 0, hi = pos.length - 1;
  const asc = pos[hi] >= pos[0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((pos[mid] <= k) === asc) lo = mid;
    else hi = mid;
  }
  return Math.abs(pos[lo] - k) <= Math.abs(pos[hi] - k) ? lo : hi;
}

/**
 * İki seri arasındaki z kaymasını kestirir.
 *
 * `target` ana seri, `moving` bindirilecek seri. Eşleme: hedef kesiti `k`
 * konumundaysa hareketli seride `k + dz` konumundaki kesit aranır.
 */
export function estimateSliceShift(target: SeriesData, moving: SeriesData, opts: ZShiftOptions = {}): ZShiftEstimate {
  const empty = (reason: string): ZShiftEstimate => ({ dzMm: 0, dzSlices: 0, score: 0, scoreBefore: 0, pairs: 0, improved: false, reason });

  if (!sameFrame(target, moving)) return empty("Seriler farklı Frame of Reference'ta; z kayması kestirilemez.");
  if (target.slices.length < 3 || moving.slices.length < 3) return empty("En az 3 kesitli iki seri gerekir.");
  const spacing = sliceSpacingOf(moving);
  if (!(spacing > 0)) return empty("Hareketli serinin kesit aralığı (SliceThickness/SpacingBetweenSlices) eksik.");
  const tPos = slicePositions(target);
  const mPos = slicePositions(moving);
  if (!tPos || !mPos) return empty("Konum etiketleri (IPP/IOP) eksik.");
  if (target.width !== moving.width || target.height !== moving.height) return empty("Izgara boyutları farklı; z kayması için aynı matris gerekir.");

  const maxShiftMm = Math.max(0, Math.min(200, opts.maxShiftMm ?? 30));
  const stepMm = Math.max(0.25, opts.stepMm ?? spacing / 2);
  const maxPairs = Math.max(4, Math.min(64, Math.round(opts.maxPairs ?? 24)));
  const minOverlap = Math.max(0.05, Math.min(0.95, opts.minOverlap ?? 0.25));

  // Hedef seriden eşit aralıklı kesitler; komşu kesitler bilgi taşımıyorsa atlanır.
  const nT = target.slices.length;
  const pick: number[] = [];
  const stride = Math.max(1, Math.floor(nT / maxPairs));
  for (let i = 0; i < nT; i += stride) pick.push(i);
  if (pick[pick.length - 1] !== nT - 1) pick.push(nT - 1);

  const shrunkT = pick.map((i) => shrinkSlice(target.slices[i], target.width, target.height));

  const scoreFor = (dzMm: number): { score: number; pairs: number } => {
    let sum = 0, n = 0;
    for (let p = 0; p < pick.length; p++) {
      const k = tPos[pick[p]] + dzMm;
      const mi = nearestIndex(mPos, k);
      if (Math.abs(mPos[mi] - k) > spacing * 0.75) continue; // bu kaymada örtüşme yok
      const mov = shrinkSlice(moving.slices[mi], moving.width, moving.height);
      if (mov.data.length !== shrunkT[p].data.length) continue;
      const mask = new Uint8Array(mov.data.length);
      let valid = 0;
      for (let i = 0; i < mask.length; i++) {
        if (Number.isFinite(mov.data[i]) && Number.isFinite(shrunkT[p].data[i])) {
          mask[i] = 1;
          valid++;
        }
      }
      if (valid / mask.length < minOverlap) continue;
      const { score } = nccMasked(shrunkT[p].data, mov.data, mask);
      if (Number.isFinite(score) && score > -1) {
        sum += score;
        n++;
      }
    }
    return { score: n ? sum / n : -1, pairs: n };
  };

  const scoreBefore = scoreFor(0);
  if (scoreBefore.score <= -1 || scoreBefore.pairs < 2) return empty("Kesitler arasında yeterli örtüşme/korelasyon bulunamadı.");

  let best = { dzMm: 0, score: scoreBefore.score, pairs: scoreBefore.pairs };
  const steps = Math.round(maxShiftMm / stepMm);
  const scores: { dz: number; score: number }[] = [{ dz: 0, score: scoreBefore.score }];
  for (let s = -steps; s <= steps; s++) {
    if (s === 0) continue;
    const dz = s * stepMm;
    const r = scoreFor(dz);
    scores.push({ dz, score: r.score });
    if (r.pairs >= 2 && r.score > best.score + 1e-9) best = { dzMm: dz, score: r.score, pairs: r.pairs };
  }

  // Parabolik incelme: en iyi adayın iki komşusu da varsa tepe noktası kestirilir.
  if (best.dzMm !== 0) {
    const at = (dz: number) => scores.find((x) => Math.abs(x.dz - dz) < 1e-9)?.score ?? NaN;
    const s0 = at(best.dzMm - stepMm);
    const s2 = at(best.dzMm + stepMm);
    if (Number.isFinite(s0) && Number.isFinite(s2)) {
      const denom = s0 - 2 * best.score + s2;
      if (Math.abs(denom) > 1e-9) {
        const delta = (0.5 * (s0 - s2)) / denom; // [-1, 1] aralığında beklenir
        if (Number.isFinite(delta) && Math.abs(delta) <= 1) {
          const refined = scoreFor(best.dzMm + delta * stepMm);
          // Yalnız GERÇEK kazanç varsa incelme uygulanır; eşit skorda arama
          // adımının yarısına kaymak (yanlılık) engellenir.
          if (refined.pairs >= 2 && refined.score > best.score + 1e-6) {
            best = { dzMm: best.dzMm + delta * stepMm, score: refined.score, pairs: refined.pairs };
          }
        }
      }
    }
  }

  const improved = best.score > scoreBefore.score + 0.01;
  return {
    dzMm: improved ? Number(best.dzMm.toFixed(2)) : 0,
    dzSlices: improved ? Number((best.dzMm / spacing).toFixed(2)) : 0,
    score: Number(best.score.toFixed(4)),
    scoreBefore: Number(scoreBefore.score.toFixed(4)),
    pairs: best.pairs,
    improved,
    ...(improved ? {} : { reason: "Kayma 0'a göre anlamlı kazanç sağlamadı." }),
  };
}

/** Kullanıcıya gösterilecek durum cümlesi. */
export function zShiftNote(e: ZShiftEstimate): string {
  if (!e.improved) return `Kesit (z) kayması uygulanmadı: ${e.reason ?? "kazanç yok"}`;
  return (
    `Kesit (z) kayması: ${e.dzMm >= 0 ? "+" : ""}${e.dzMm.toFixed(1)} mm ` +
    `(${e.dzSlices.toFixed(2)} kesit), NCC ${e.scoreBefore.toFixed(2)} → ${e.score.toFixed(2)} ` +
    `· ${e.pairs} kesit çifti. Hekim görsel doğrulaması gerekir.`
  );
}

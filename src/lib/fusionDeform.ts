/**
 * Füzyon için **deforme (elastik) in-plane hizalama** — yoğun yer değiştirme alanı.
 *
 * Neden: PET/BT ve MR/MR bindirmesinde iki seri aynı Frame of Reference'ı paylaşsa
 * bile hasta hareketi, farklı nefes fazı veya tarayıcı masası farkı **bölgesel**
 * kaymalara yol açar. Katı dönüşüm (öteleme + dönme + ölçek, `fusionRigid.ts`)
 * bunları düzeltemez; bu modül kesit içinde **düğüm ızgaralı yer değiştirme alanı**
 * kestirir ve hareketli kesiti bu alanla yeniden örnekler.
 *
 * Yöntem: kabadan inceye (4 → 2 → 1 indirgeme) **blok eşleme + elastik düzleştirme**:
 *  1. Her düğüm için, çevresindeki pencere üzerinde yerel normalize çapraz
 *     korelasyon (NCC) en yüksek olan yer değiştirme adayı seçilir (koordinat
 *     inişi; adaylar ±arama yarıçapında 1 piksel adımla).
 *  2. Alan Gauss çekirdeğiyle düzleştirilir (elastik düzenlileştirme) ve toplam
 *     kayma `maxDisp` ile sınırlanır — komşu düğümler birbirinden kopmaz.
 *  3. Sonuç, başlangıçtaki NCC'yi **iyileştirmiyorsa** alan sıfırlanır (kimlik
 *     dönüşüm); böylece bindirme hiçbir durumda kötüleşmez.
 *
 * Dürüst sınırlar:
 *  - Yalnız **2B kesit içi** deformasyon. Kesitler arası (z) kayma, 3B hacim
 *    kaydı, B-spline süreklilik garantisi ve simetrik (inverse-consistent) kayıt
 *    YOKTUR; alan düğüm ızgarası üzerinde bilineer ara değerlenir.
 *  - Farklı modaliteler arasında (BT↔MR) yoğunluk ilişkisi doğrusal olmadığı için
 *    NCC güvenilir değildir; bu durumda kazanç düşük çıkar ve alan sıfırlanır.
 *  - Büyük anatomik değişim (kitle, ameliyat sonrası) veya büyük örtüşme kaybı
 *    varsa sonuç anlamsızdır. Sonuç tanı aracı değildir; hekim görsel doğrular.
 */
import { downsample, nccMasked } from "./registration";

/** Düğüm ızgaralı yer değiştirme alanı (hedef kesit piksel uzayında). */
export interface DeformField {
  /** Alanın tanımlı olduğu görüntü boyutu (px). */
  w: number;
  h: number;
  /** Düğüm sayısı (yatay / dikey). */
  gw: number;
  gh: number;
  /** Düğüm başına yatay yer değiştirme (px, + = içerik sağa kayar). */
  ux: Float32Array;
  /** Düğüm başına dikey yer değiştirme (px, + = içerik aşağı kayar). */
  uy: Float32Array;
}

/** Varsayılan ince ızgara (7×7 düğüm). */
export const DEFAULT_GRID = 7;
/** Varsayılan en büyük toplam kayma (px). */
export const DEFAULT_MAX_DISP = 12;
/** Bu kazancın altındaki iyileşme "anlamlı" sayılmaz (NCC). */
export const MIN_DEFORM_GAIN = 0.01;

const MAX_GRID = 21;
const MIN_SIZE = 16;
const MAX_DISP_LIMIT = 80;

const clampNum = (v: unknown, def: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;

/** Düğüm merkezinin görüntü koordinatı (piksel merkezleri 0…n-1). */
export function nodeCoord(i: number, n: number, size: number): number {
  if (n <= 1) return (size - 1) / 2;
  return (i * (size - 1)) / (n - 1);
}

/** Kimlik (sıfır) alanı. */
export function identityField(w: number, h: number, gw = DEFAULT_GRID, gh = gw): DeformField {
  const gx = Math.max(1, Math.min(MAX_GRID, Math.round(gw)));
  const gy = Math.max(1, Math.min(MAX_GRID, Math.round(gh)));
  return { w, h, gw: gx, gh: gy, ux: new Float32Array(gx * gy), uy: new Float32Array(gx * gy) };
}

/** Alan kimlik mi (0.01 px altı tüm kaymalar)? */
export function isIdentityField(f: DeformField | null | undefined): boolean {
  if (!f) return true;
  for (let i = 0; i < f.ux.length; i++) {
    if (Math.abs(f.ux[i]) > 0.01 || Math.abs(f.uy[i]) > 0.01) return false;
  }
  return true;
}

/** Alandan bilineer yer değiştirme okur (ızgara dışında kenar değeri). */
export function fieldAt(f: DeformField, x: number, y: number): { ux: number; uy: number } {
  const { gw, gh, w, h } = f;
  const gx = gw > 1 ? (x * (gw - 1)) / Math.max(1, w - 1) : 0;
  const gy = gh > 1 ? (y * (gh - 1)) / Math.max(1, h - 1) : 0;
  const x0 = Math.min(gw - 1, Math.max(0, Math.floor(gx)));
  const y0 = Math.min(gh - 1, Math.max(0, Math.floor(gy)));
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const ax = Math.min(1, Math.max(0, gx - x0));
  const ay = Math.min(1, Math.max(0, gy - y0));
  const bil = (arr: Float32Array) =>
    arr[y0 * gw + x0] * (1 - ax) * (1 - ay) +
    arr[y0 * gw + x1] * ax * (1 - ay) +
    arr[y1 * gw + x0] * (1 - ax) * ay +
    arr[y1 * gw + x1] * ax * ay;
  return { ux: bil(f.ux), uy: bil(f.uy) };
}

/** Bilineer örnekleme; görüntü dışı/NaN → null. */
function bilinear(src: ArrayLike<number>, w: number, h: number, x: number, y: number): number | null {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return null;
  const x0 = Math.min(w - 2, Math.floor(x));
  const y0 = Math.min(h - 2, Math.floor(y));
  const ax = x - x0, ay = y - y0;
  const v00 = src[y0 * w + x0], v10 = src[y0 * w + x0 + 1];
  const v01 = src[(y0 + 1) * w + x0], v11 = src[(y0 + 1) * w + x0 + 1];
  const v = v00 * (1 - ax) * (1 - ay) + v10 * ax * (1 - ay) + v01 * (1 - ax) * ay + v11 * ax * ay;
  return Number.isFinite(v) ? v : null;
}

/**
 * Hareketli kesiti alanla hedef ızgarasına yeniden örnekler (bilineer).
 * `warp(x,y) = mov(x - ux, y - uy)`; alan dışına düşen pikseller NaN olur.
 */
export function applyDeform(src: ArrayLike<number>, w: number, h: number, field: DeformField | null | undefined): Float32Array {
  const out = new Float32Array(w * h);
  if (!field || isIdentityField(field)) {
    for (let i = 0; i < w * h; i++) out[i] = i < src.length && Number.isFinite(src[i]) ? src[i] : NaN;
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { ux, uy } = fieldAt(field, x, y);
      const v = bilinear(src, w, h, x - ux, y - uy);
      out[y * w + x] = v === null ? NaN : v;
    }
  }
  return out;
}

/** Gauss çekirdeğiyle alanı düzleştirir (elastik düzenlileştirme; sigma düğüm birimi). */
export function smoothField(f: DeformField, sigma = 0.8): DeformField {
  const s = Math.max(0, Math.min(4, Number.isFinite(sigma) ? sigma : 0));
  const out: DeformField = { ...f, ux: Float32Array.from(f.ux), uy: Float32Array.from(f.uy) };
  if (s <= 0.05 || f.gw < 2 || f.gh < 2) return out;
  const radius = Math.max(1, Math.ceil(2 * s));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * s * s));
    kernel[k + radius] = v;
    sum += v;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const pass = (src: Float32Array, horizontal: boolean) => {
    const dst = new Float32Array(src.length);
    for (let j = 0; j < f.gh; j++) {
      for (let i = 0; i < f.gw; i++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const ni = horizontal ? Math.min(f.gw - 1, Math.max(0, i + k)) : i;
          const nj = horizontal ? j : Math.min(f.gh - 1, Math.max(0, j + k));
          acc += src[nj * f.gw + ni] * kernel[k + radius];
        }
        dst[j * f.gw + i] = acc;
      }
    }
    return dst;
  };
  out.ux = pass(pass(out.ux, true), false);
  out.uy = pass(pass(out.uy, true), false);
  return out;
}

/** Toplam kaymayı `maxDisp` ile sınırlar (vektör yönü korunur). */
export function clampField(f: DeformField, maxDisp: number): DeformField {
  const lim = clampNum(maxDisp, DEFAULT_MAX_DISP, 0, MAX_DISP_LIMIT);
  const out: DeformField = { ...f, ux: Float32Array.from(f.ux), uy: Float32Array.from(f.uy) };
  for (let i = 0; i < out.ux.length; i++) {
    const m = Math.hypot(out.ux[i], out.uy[i]);
    if (m > lim && m > 1e-9) {
      const k = lim / m;
      out.ux[i] *= k;
      out.uy[i] *= k;
    }
  }
  return out;
}

export interface FieldStats {
  nodes: number;
  meanDisp: number;
  maxDisp: number;
}

/** Alan istatistikleri (px). */
export function fieldStats(f: DeformField | null | undefined): FieldStats {
  if (!f) return { nodes: 0, meanDisp: 0, maxDisp: 0 };
  let sum = 0, max = 0;
  for (let i = 0; i < f.ux.length; i++) {
    const m = Math.hypot(f.ux[i], f.uy[i]);
    sum += m;
    if (m > max) max = m;
  }
  const nodes = f.ux.length;
  return { nodes, meanDisp: nodes ? sum / nodes : 0, maxDisp: max };
}

/**
 * Önbellek anahtarı: alan 0.02 px'e nicemlenip FNV-1a ile özetlenir.
 * Kimlik alan "id" döner; böylece füzyon katmanı gereksiz yeniden hesaplanmaz.
 */
export function deformKey(f: DeformField | null | undefined): string {
  if (!f || isIdentityField(f)) return "id";
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  mix(f.gw);
  mix(f.gh);
  for (let i = 0; i < f.ux.length; i++) {
    mix(Math.round(f.ux[i] * 50) + 4096);
    mix(Math.round(f.uy[i] * 50) + 4096);
  }
  return `d${f.gw}x${f.gh}-${(h >>> 0).toString(36)}`;
}

/** Yerel NCC: ref(x,y) ile mov(x-du, y-dv) pencere içinde karşılaştırılır. */
function localNcc(
  ref: ArrayLike<number>,
  mov: ArrayLike<number>,
  w: number,
  h: number,
  cx: number,
  cy: number,
  du: number,
  dv: number,
  half: number
): number | null {
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(w - 1, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(h - 1, Math.ceil(cy + half));
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const r = ref[y * w + x];
      if (!Number.isFinite(r)) continue;
      const m = bilinear(mov, w, h, x - du, y - dv);
      if (m === null) continue;
      n++;
      sa += r; sb += m;
      saa += r * r; sbb += m * m; sab += r * m;
    }
  }
  if (n < 16) return null;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-6 * n || vb <= 1e-6 * n) return null; // düz (bilgi yok) pencere
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** İki görüntü arasında sonlu piksellerde global NCC. */
function globalNcc(ref: ArrayLike<number>, mov: ArrayLike<number>, w: number, h: number): { score: number; overlap: number } {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (Number.isFinite(ref[i]) && Number.isFinite(mov[i])) mask[i] = 1;
  }
  const safeRef = new Float32Array(w * h);
  const safeMov = new Float32Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    safeRef[i] = mask[i] ? ref[i] : 0;
    safeMov[i] = mask[i] ? mov[i] : 0;
  }
  return nccMasked(safeRef, safeMov, mask);
}

export interface DeformOptions {
  /** En büyük toplam kayma (tam çözünürlük px). */
  maxDisp?: number;
  /** İnce ızgaradaki düğüm sayısı (gw = gh). */
  grid?: number;
  /** İnce kademede aday arama yarıçapı (px). */
  search?: number;
  /** Gauss düzleştirme sigma'sı (düğüm birimi). */
  smooth?: number;
  /** Kademe başına düğüm taraması turu. */
  iterations?: number;
  /** Altında kestirim yapılmayacak örtüşme oranı. */
  minOverlap?: number;
}

export interface DeformEstimate {
  /** Kestirilen alan (kazanç yoksa kimlik). */
  field: DeformField;
  /** Hizalama öncesi/sonrası global NCC. */
  scoreBefore: number;
  scoreAfter: number;
  /** Anlamlı kazanç var mı (>= MIN_DEFORM_GAIN). */
  improved: boolean;
  /** Kullanılan en ince indirgeme kademesi (1 = tam çözünürlük). */
  level: number;
  /** Değerlendirilen düğüm-aday sayısı. */
  candidates: number;
  stats: FieldStats;
  /** Kestirim yapılamadıysa nedeni. */
  reason?: string;
}

/**
 * Deforme hizalamayı kabadan inceye kestirir.
 *
 * `ref` hedef kesit, `mov` hareketli kesit (aynı ızgara, ör. `resampleOnto` +
 * `applyRigid` çıktısı). NaN'li pikseller geçersiz sayılır.
 */
export function estimateDeform(
  ref: ArrayLike<number>,
  mov: ArrayLike<number>,
  w: number,
  h: number,
  opts: DeformOptions = {}
): DeformEstimate {
  const grid = Math.round(clampNum(opts.grid, DEFAULT_GRID, 3, MAX_GRID));
  const maxDisp = clampNum(opts.maxDisp, DEFAULT_MAX_DISP, 0, MAX_DISP_LIMIT);
  const search = Math.round(clampNum(opts.search, 3, 1, 20));
  const sigma = clampNum(opts.smooth, 0.8, 0, 4);
  const iterations = Math.round(clampNum(opts.iterations, 2, 1, 4));
  const minOverlap = clampNum(opts.minOverlap, 0.2, 0.05, 0.95);

  let field = identityField(w, h, grid);
  const before = globalNcc(ref, mov, w, h);
  const empty = (reason: string): DeformEstimate => ({
    field, scoreBefore: before.score, scoreAfter: before.score, improved: false, level: 1, candidates: 0, stats: fieldStats(field), reason,
  });

  if (w < MIN_SIZE || h < MIN_SIZE) return empty("Görüntü çok küçük (en az 16×16).");
  if (!Number.isFinite(before.score) || before.score <= -1 || before.overlap < minOverlap) {
    return empty("Örtüşme yetersiz ya da görüntüde korelasyon yok.");
  }

  const levels = Math.min(w, h) >= 256 ? [4, 2, 1] : Math.min(w, h) >= 96 ? [2, 1] : [1];
  let candidates = 0;
  for (let li = 0; li < levels.length; li++) {
    const f = levels[li];
    const rl = downsample(ref, w, h, f);
    const ml = downsample(mov, w, h, f);
    if (rl.w < 8 || rl.h < 8) continue;
    const half = Math.max(3, Math.round(9 / f));
    const searchL = li === 0 ? Math.max(2, Math.round((search * 2) / f)) : Math.max(1, Math.round(search / f));
    // Kademe içi kabul ölçütü: her tarama turundan sonra alanın o kademedeki
    // gerçek skoru ölçülür; tur skoru düşürüyorsa alan geri alınır ve tur kesilir.
    // Böylece koordinat inişi salınımı (iterasyon arttıkça kötüleşme) engellenir.
    const scoreAtLevel = (cand: DeformField): number => {
      const scaled: DeformField = {
        w: rl.w, h: rl.h, gw: cand.gw, gh: cand.gh,
        ux: cand.ux.map((v) => v / f), uy: cand.uy.map((v) => v / f),
      };
      return globalNcc(rl.data, applyDeform(ml.data, rl.w, rl.h, scaled), rl.w, rl.h).score;
    };
    let levelBest = field;
    let levelBestScore = scoreAtLevel(field);
    for (let it = 0; it < iterations; it++) {
      const next: DeformField = { ...field, ux: Float32Array.from(field.ux), uy: Float32Array.from(field.uy) };
      for (let j = 0; j < next.gh; j++) {
        for (let i = 0; i < next.gw; i++) {
          const k = j * next.gw + i;
          const cx = nodeCoord(i, next.gw, w) / f;
          const cy = nodeCoord(j, next.gh, h) / f;
          const startUx = field.ux[k];
          const startUy = field.uy[k];
          let best = localNcc(rl.data, ml.data, rl.w, rl.h, cx, cy, startUx / f, startUy / f, half);
          let bestUx = startUx, bestUy = startUy;
          for (let dv = -searchL; dv <= searchL; dv++) {
            for (let du = -searchL; du <= searchL; du++) {
              if (du === 0 && dv === 0) continue;
              const ux = startUx + du * f;
              const uy = startUy + dv * f;
              if (Math.hypot(ux, uy) > maxDisp) continue;
              const s = localNcc(rl.data, ml.data, rl.w, rl.h, cx, cy, ux / f, uy / f, half);
              candidates++;
              if (s === null) continue;
              if (best === null || s > best + 1e-9) {
                best = s;
                bestUx = ux;
                bestUy = uy;
              }
            }
          }
          if (best === null) continue; // düz pencere: düğüm önceki değerinde kalır
          next.ux[k] = bestUx;
          next.uy[k] = bestUy;
        }
      }
      const cand = clampField(smoothField(next, sigma), maxDisp);
      const candScore = scoreAtLevel(cand);
      if (candScore > levelBestScore + 1e-6) {
        field = cand;
        levelBest = cand;
        levelBestScore = candScore;
      } else {
        field = levelBest;
        break; // bu kademede iyileşme durdu
      }
    }
  }

  const warped = applyDeform(mov, w, h, field);
  const after = globalNcc(ref, warped, w, h);
  const improved = after.score > before.score + MIN_DEFORM_GAIN;
  if (!improved) {
    return {
      field: identityField(w, h, grid),
      scoreBefore: before.score,
      scoreAfter: after.score,
      improved: false,
      level: 1,
      candidates,
      stats: fieldStats(null),
      reason: "Deforme alan kazanç sağlamadı; katı hizalama korunuyor.",
    };
  }
  return { field, scoreBefore: before.score, scoreAfter: after.score, improved: true, level: 1, candidates, stats: fieldStats(field) };
}

/** Kullanıcıya gösterilecek durum cümlesi. */
export function deformNote(e: DeformEstimate): string {
  if (!e.improved) {
    return `Elastik hizalama kazanç sağlamadı (NCC ${e.scoreBefore.toFixed(2)} → ${e.scoreAfter.toFixed(2)}); ${e.reason ?? "alan sıfırlandı"}`;
  }
  const gain = e.scoreAfter - e.scoreBefore;
  return (
    `Elastik hizalama: NCC ${e.scoreBefore.toFixed(2)} → ${e.scoreAfter.toFixed(2)} (+${gain.toFixed(2)}), ` +
    `ızgara ${e.field.gw}×${e.field.gh}, ortalama ${e.stats.meanDisp.toFixed(1)} px / en çok ${e.stats.maxDisp.toFixed(1)} px kayma. ` +
    `Hekim görsel doğrulaması gerekir.`
  );
}

/**
 * Önceki/şimdiki tetkik hizalaması (a-prior) — 2B öteleme + ölçek kestirimi.
 *
 * Yöntem: normalize çapraz korelasyon (NCC). Hareketli görüntü, referans ızgarasına
 * (dx, dy, scale) ile bilineer örneklenir; skor, örtüşen bölgede Pearson
 * korelasyonudur. Kabadan inceye arama yapılır (indirgeme 4 → 2 → 1).
 *
 * Sınırlar (dürüstçe):
 *  - Yalnız **katı** dönüşüm (öteleme + izotropik ölçek). Döndürme, elastik/
 *    deformable kayıt ve 3B hacim hizalaması YOKTUR.
 *  - Farklı modaliteler (BT↔MR) arasında güvenilir değildir; aynı modalite,
 *    benzer pencere varsayılır. Skor düşükse sonuç "güvenilmez" sayılır.
 *  - Sonuç hekimin görsel doğrulamasına tabidir; ölçüm/yorum otomatik değişmez.
 */

export interface AlignmentResult {
  /** Hareketli görüntüyü referansa oturtmak için x ötelemesi (piksel). */
  dx: number;
  dy: number;
  /** İzotropik ölçek (1 = aynı boyut). */
  scale: number;
  /** Normalize çapraz korelasyon, -1…1 (1 = tam eşleşme). */
  score: number;
  /** Kestirimde kullanılan indirgeme kademesi (1 = tam çözünürlük). */
  level: number;
}

/** Bu skorun altındaki hizalama güvenilir sayılmaz. */
export const MIN_ALIGNMENT_SCORE = 0.55;

export interface AlignmentOptions {
  /** En büyük öteleme (indirgenmiş pikselde değil, tam çözünürlükte). */
  maxShift?: number;
  /** Taranacak ölçekler. */
  scales?: number[];
  /** Altında korelasyon hesaplanmayacak örtüşme oranı (0…1). */
  minOverlap?: number;
}

/** Görüntüyü kutu ortalamasıyla indirger (f=1 ise kopya). */
export function downsample(
  src: ArrayLike<number>,
  w: number,
  h: number,
  f: number
): { data: Float32Array; w: number; h: number } {
  if (f <= 1) return { data: Float32Array.from(src as ArrayLike<number>), w, h };
  const nw = Math.max(1, Math.floor(w / f));
  const nh = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = y * f + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = x * f + dx;
          if (sx >= w) break;
          sum += src[sy * w + sx];
          n++;
        }
      }
      out[y * nw + x] = n ? sum / n : 0;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Bilineer örnekleme; sınır dışı en yakın piksele kenetlenir. */
export function sampleBilinear(src: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = src[y0 * w + x0];
  const b = src[y0 * w + x1];
  const c = src[y1 * w + x0];
  const d = src[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Hareketli görüntüyü referans ızgarasında yeniden örnekler.
 * Eşleme: ref (x,y) ← mov ( cx + (x−cx−dx)/scale, cy + (y−cy−dy)/scale ).
 */
export function warp(
  refW: number,
  refH: number,
  mov: ArrayLike<number>,
  movW: number,
  movH: number,
  dx: number,
  dy: number,
  scale: number
): { data: Float32Array; mask: Uint8Array } {
  const out = new Float32Array(refW * refH);
  const mask = new Uint8Array(refW * refH);
  warpInto(out, mask, refW, refH, mov, movW, movH, dx, dy, scale);
  return { data: out, mask };
}

/** `warp` ile aynı işlev, hazır tamponlara yazar (arama döngüsünde ayırma maliyeti yok). */
export function warpInto(
  out: Float32Array,
  mask: Uint8Array,
  refW: number,
  refH: number,
  mov: ArrayLike<number>,
  movW: number,
  movH: number,
  dx: number,
  dy: number,
  scale: number
): void {
  mask.fill(0);
  const cx = refW / 2;
  const cy = refH / 2;
  const s = scale > 0 ? scale : 1;
  // Hareketli görüntünün referans ızgarasındaki ölçeği
  const kx = movW / refW;
  const ky = movH / refH;
  for (let y = 0; y < refH; y++) {
    const my = (cy + (y - cy - dy) / s) * ky;
    for (let x = 0; x < refW; x++) {
      const mx = (cx + (x - cx - dx) / s) * kx;
      const i = y * refW + x;
      if (mx < 0 || my < 0 || mx > movW - 1 || my > movH - 1) continue; // geçersiz: kenetlenmiş değer kullanılmaz
      out[i] = sampleBilinear(mov, movW, movH, mx, my);
      mask[i] = 1;
    }
  }
}

/** Pearson korelasyonu (sabit görüntüde 0). */
export function ncc(a: ArrayLike<number>, b: ArrayLike<number>, n = a.length): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : 0;
}

/**
 * Yalnız geçerli (hareketli görüntü içinde kalan) piksellerde Pearson korelasyonu.
 * Örtüşme oranı döner; çok küçük örtüşmede skor anlamsızdır.
 */
export function nccMasked(
  ref: ArrayLike<number>,
  warped: ArrayLike<number>,
  mask: Uint8Array
): { score: number; overlap: number } {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; sa += ref[i]; sb += warped[i]; }
  if (n < 16) return { score: -1, overlap: n / mask.length };
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = ref[i] - ma, y = warped[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return { score: den > 1e-9 ? num / den : 0, overlap: n / mask.length };
}

/**
 * Kabadan inceye katı hizalama kestirimi.
 * `ref` ve `mov` farklı boyutlarda olabilir; hareketli görüntü referans
 * ızgarasına örneklenir.
 */
export function estimateAlignment(
  ref: ArrayLike<number>,
  refW: number,
  refH: number,
  mov: ArrayLike<number>,
  movW: number,
  movH: number,
  opts: AlignmentOptions = {}
): AlignmentResult {
  const maxDim = Math.max(refW, refH);
  const maxShift = Math.max(2, Math.round(opts.maxShift ?? Math.min(64, maxDim * 0.12)));
  const coarseScales = opts.scales ?? [0.9, 0.95, 1, 1.05, 1.1];
  const minOverlap = opts.minOverlap ?? 0.35;

  // Üst kademe ~320 px'i geçmesin (maliyet kapısı); alt kademeler yarı yarıya iner.
  // Maliyet kapısı: üst kademe ~160 px, en ince kademe ~768 px'i geçmez.
  const f0 = Math.max(1, Math.ceil(maxDim / 160));
  const f1 = Math.max(1, Math.round(f0 / 2));
  const minFactor = Math.max(1, Math.ceil(maxDim / 768));
  const factors = Array.from(new Set([f0, f1, 1]))
    .filter((f) => f >= minFactor)
    .sort((a, b) => b - a);
  // Küçük görüntüde tek kademe kalırsa ikinci bir ince geçiş eklenir; ilk geçiş
  // her zaman geniş ölçek/öteleme aramasıdır (yoksa ölçek 1 civarına kilitlenir).
  if (factors.length === 1) factors.push(1);

  let best: AlignmentResult = { dx: 0, dy: 0, scale: 1, score: -1, level: 1 };
  let center = { dx: 0, dy: 0, scale: 1 };
  let prevFactor = 1;
  let prevScore = -1;

  for (let idx = 0; idx < factors.length; idx++) {
    const factor = factors[idx];
    const coarse = idx === 0;
    const r = downsample(ref, refW, refH, factor);
    const m = downsample(mov, movW, movH, factor);
    // Arama genişliği: kaba kademede tüm arama uzayı, ince kademede bir önceki
    // kademenin niceleme hatasını kapatacak kadar (± prevFactor + 1).
    const span = coarse
      ? Math.max(1, Math.round(maxShift / factor))
      : Math.max(2, prevFactor + 1);
    // Kaba kademede öteleme ızgarası seyreltilir (maliyet), ince kademede tam.
    const step = coarse ? Math.max(1, Math.round(span / 4)) : 1;
    // Ölçek, önceki kademe zaten yüksek skor verdiyse en ince kademede sabit
    // tutulur (maliyet); düşük güvende ±0,02 yeniden denenir.
    const scaleList = coarse
      ? coarseScales
      : prevScore > 0.8
        ? [center.scale]
        : [center.scale - 0.02, center.scale, center.scale + 0.02].filter((v) => v > 0.5 && v < 2);

    const wBuf = new Float32Array(r.w * r.h);
    const mBuf = new Uint8Array(r.w * r.h);
    let localBest = { dx: center.dx, dy: center.dy, scale: factor === 1 ? best.scale : 1, score: -1 };
    for (const s of scaleList) {
      for (let dy = -span; dy <= span; dy += step) {
        for (let dx = -span; dx <= span; dx += step) {
          const tx = Math.round(center.dx + dx);
          const ty = Math.round(center.dy + dy);
          warpInto(wBuf, mBuf, r.w, r.h, m.data, m.w, m.h, tx, ty, s);
          const { score, overlap } = nccMasked(r.data, wBuf, mBuf);
          if (overlap < minOverlap) continue;
          if (score > localBest.score) localBest = { dx: tx, dy: ty, scale: s, score };
        }
      }
    }
    if (localBest.score < 0) continue; // bu kademede geçerli örtüşme yok
    best = {
      dx: Math.round(localBest.dx * factor),
      dy: Math.round(localBest.dy * factor),
      scale: Number(localBest.scale.toFixed(3)),
      score: Number(localBest.score.toFixed(4)),
      level: factor,
    };
    center = { dx: localBest.dx, dy: localBest.dy, scale: localBest.scale };
    prevFactor = factor;
    prevScore = localBest.score;
  }
  return best;
}

/** Hizalama güvenilir mi? */
export function alignmentTrusted(res: AlignmentResult): boolean {
  return res.score >= MIN_ALIGNMENT_SCORE;
}

/** Kullanıcıya gösterilecek kısa özet. */
export function alignmentNote(res: AlignmentResult, trusted = alignmentTrusted(res)): string {
  const dir = (v: number) => (v === 0 ? "0" : v > 0 ? `+${v}` : `${v}`);
  const base = `Δx ${dir(res.dx)} px · Δy ${dir(res.dy)} px · ölçek ${res.scale.toFixed(2)} · skor ${res.score.toFixed(2)}`;
  if (!trusted) return `${base} — otomatik hizalama GÜVENİLİR DEĞİL (skor < ${MIN_ALIGNMENT_SCORE}); yalnız görsel referans olarak kullanın.`;
  return `${base} — katı hizalama (öteleme+ölçek); hekim görsel doğrulaması gerekir.`;
}

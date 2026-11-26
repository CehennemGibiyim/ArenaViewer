/**
 * Kavisli (curved) MPR — v-mpr "Kalan: Kavisli MPR (damar/omurga merkez hattı)" maddesi.
 *
 * Merkez hattı bir dizi 3B kontrol noktasından (voksel koordinatı; x=sütun, y=satır,
 * z=kesit) Catmull-Rom splini ile geçirilir; spline yay uzunluğuna göre eşit adımlarla
 * örneklenir. Her örnek noktada paralel taşıma (parallel transport) çerçevesi korunur
 * (ani bükülme/dönmede 180° çevrilme olmaz). Her yay adımı için merkez hattan
 * ±halfWidthMm yanal şerit trilinear örneklenir; isteğe bağlı kalın kesit
 * (merkez hattın binormal normali boyunca) MIP/ortalama/tek kesit uygulanır.
 *
 * Çıktı: satırı yay yönü (akış yönü), sütunu yanal yön olan Float32Array görüntü.
 * saf fonksiyondur; UI `CurvedMprPanel`dedir.
 */
import type { SeriesData } from "./types";
import { sampleTrilinear, volGeo } from "./volume";

export type CurvedMode = "single" | "avg" | "mip";

export interface CurvedOpts {
  /** Kontrol noktaları (voksel). En az 2, tekrar noktalar güvenle atlanır. */
  points: [number, number, number][];
  /** Merkez hattın iki yanındaki şerit yarı genişliği (mm). Varsayılan 30. */
  halfWidthMm?: number;
  /** Yay örnekleme adımı (mm). Varsayılan min(psX, psY, sz). */
  stepMm?: number;
  /** Kalın kesit (mm) — binormal boyunca; 0 = tek kesit. */
  slabMm?: number;
  mode?: CurvedMode;
  /** Yay örnek sayısı üst sınırı (güvenlik). Varsayılan 1024. */
  maxSamples?: number;
}

export interface CurvedImage {
  data: Float32Array;
  /** Yanal örnek sayısı. */
  width: number;
  /** Yay boyunca örnek sayısı. */
  height: number;
  /** Yay adım mm. */
  stepMm: number;
  /** Toplam yay uzunluğu (mm). */
  lengthMm: number;
  /** Arka plan (hacim dışı) değeri. */
  BG: number;
}

type V3 = [number, number, number];
const BG = -3.4e38;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
};

/** Catmull-Rom (centripetal, α=0.5) — ardışık noktalar arasında örnekler üretir. */
function catmullRom(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const cr = (a: number, b: number, c: number, d: number) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]), cr(p0[2], p1[2], p2[2], p3[2])];
}

/** Kontrol noktalarından eşit yay adımıyla örneklenmiş nokta + teğet listesi. */
export function resampleCenterline(points: [number, number, number][], sxMm: number, syMm: number, szMm: number, stepMm: number, maxSamples: number): { p: V3; t: V3 }[] {
  const pts = points.map(([x, y, z]) => [x * sxMm, y * syMm, z * szMm] as V3);
  // tekrar noktaları temizle (sıfır uzunluklu spline segmenti çökmesin)
  const clean: V3[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || len(sub(p, last)) > 1e-6) clean.push(p);
  }
  if (clean.length < 2) return [];

  // yoğun örnekleme (segment başına 200 nokta)
  const dense: V3[] = [];
  const ext = [clean[0], ...clean, clean[clean.length - 1]];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    for (let j = 0; j < 200; j++) dense.push(catmullRom(p0, p1, p2, p3, j / 200));
  }
  dense.push(clean[clean.length - 1]);

  // yay uzunluğu
  const cum = new Float64Array(dense.length);
  for (let i = 1; i < dense.length; i++) cum[i] = cum[i - 1] + len(sub(dense[i], dense[i - 1]));
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [];
  const n = Math.min(maxSamples, Math.max(2, Math.floor(total / stepMm) + 1));
  const out: { p: V3; t: V3 }[] = [];
  let di = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * total;
    while (di < cum.length - 2 && cum[di + 1] < s) di++;
    const segLen = cum[di + 1] - cum[di] || 1e-12;
    const f = (s - cum[di]) / segLen;
    const p = add(dense[di], scale(sub(dense[di + 1], dense[di]), f));
    out.push({ p, t: [0, 0, 1] });
  }
  // orta farkla teğetler
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)].p, b = out[Math.min(out.length - 1, i + 1)].p;
    out[i].t = norm(sub(b, a));
  }
  return out;
}

/** Paralel taşıma ile bükülmesiz (n, b) normal çerçevesi. */
export function parallelTransport(frames: { p: V3; t: V3 }[]): { n: V3; b: V3 }[] {
  if (frames.length === 0) return [];
  const t0 = frames[0].t;
  // teğete en dik dünya ekseniyle başla
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best: V3 = axes[0], bestDot = Infinity;
  for (const a of axes) { const d = Math.abs(dot(a, t0)); if (d < bestDot) { bestDot = d; best = a; } }
  let n = norm(sub(best, scale(t0, dot(best, t0))));
  const out: { n: V3; b: V3 }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i].t;
    if (i > 0) {
      // önceki normali yeni teğete dik bileşene taşı, normalize et
      n = norm(sub(n, scale(t, dot(n, t))));
      if (len(n) < 1e-6) {
        // dejenere (180° dönüş) — yedek eksen
        const alt: V3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        n = norm(sub(alt, scale(t, dot(alt, t))));
      }
    }
    out.push({ n, b: norm(cross(t, n)) });
  }
  return out;
}

/** Kavisli yeniden kesit görüntüsü üretir. Boş/dejenere girdide null. */
export function curvedMpr(s: SeriesData, o: CurvedOpts): CurvedImage | null {
  const g = volGeo(s);
  const sx = g.sx, sy = g.sy, sz = g.sz;
  const step = o.stepMm && o.stepMm > 0 ? o.stepMm : Math.min(sx, sy, sz);
  const maxS = Math.max(16, Math.min(2048, Math.floor(o.maxSamples ?? 1024)));
  const frames = resampleCenterline(o.points, sx, sy, sz, step, maxS);
  if (frames.length < 2) return null;
  const half = Math.max(1, o.halfWidthMm ?? 30);
  const slab = Math.max(0, o.slabMm ?? 0);
  const mode = o.mode ?? "single";
  // yay uzunluğu
  let total = 0;
  for (let i = 1; i < frames.length; i++) total += len(sub(frames[i].p, frames[i - 1].p));
  const actualStep = frames.length > 1 ? total / (frames.length - 1) : step;
  const latN = Math.max(8, Math.floor((2 * half) / actualStep) + 1);
  const framesT = parallelTransport(frames);
  const ks = slab <= actualStep ? 0 : Math.floor(slab / 2 / actualStep);
  const data = new Float32Array(frames.length * latN);
  for (let r = 0; r < frames.length; r++) {
    const { p, t } = frames[r];
    const n = framesT[r].n, b = framesT[r].b;
    // yanal yön: n; kalın kesit binormal b üzerinde
    for (let c = 0; c < latN; c++) {
      const u = (c / (latN - 1) - 0.5) * 2 * half;
      let acc = mode === "mip" ? -Infinity : 0, cnt = 0;
      for (let k = -ks; k <= ks; k++) {
        const off = k * actualStep;
        const q = add(add(p, scale(n, u)), scale(b, off));
        const v = sampleTrilinear(s, q[0] / sx, q[1] / sy, q[2] / sz);
        if (Number.isNaN(v)) continue;
        cnt++;
        if (mode === "mip") acc = Math.max(acc, v); else acc += v;
      }
      data[r * latN + c] = cnt === 0 ? BG : mode === "mip" ? acc : acc / cnt;
    }
  }
  return { data, width: latN, height: frames.length, stepMm: actualStep, lengthMm: total, BG };
}

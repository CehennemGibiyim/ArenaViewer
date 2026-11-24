/**
 * MPR (çok düzlemsel rekonstrüksiyon) — aksiyel bir BT/MR serisinden koronal ve
 * sagital görüntüler üretir.
 *
 * Model: kaynak hacim `P(i,j,k) = o0 + j·psX·c + i·psY·r + k·t` şeklindedir
 * (r = satır yönü, c = sütun yönü, t = kesit yönü vektörü; LPS mm). Hedef düzlem
 * iki birim vektör (U,V) + orijin ile tanımlanır ve her hedef pikseli kaynak
 * koordinatına ters-çözülüp trilinear örneklenir.
 *
 * Not: Oblik (non-orthogonal) kesit yönünde ters-çözüm kosinüs yaklaşımına daya­nır;
 * bu tip serilerde tek piksel mertebesinde sapma görülebilir. Görüntü, modelin
 * çıktısı niteliğindedir ve ölçüm/rapor için aksiyel veri kullanılmalıdır.
 *
 * Üretilen `SeriesData` sanaldır: `id` sonuna `__mpr_<düzlem>` eklenir, gerçek
 * seri kaynağı kaybolmaz. Bu sayede mevcut görüntüleyici (pencereleme, ölçek,
 * bulgu katmanı) değişiklik gerektirmeden çalışır.
 */
import type { SeriesData } from "./types";

export type MprPlane = "axial" | "coronal" | "sagittal";
export const MPR_PLANES: MprPlane[] = ["axial", "coronal", "sagittal"];

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export interface VolumeGeom {
  /** Her kesitin ImagePositionPatient'ı (varsa). */
  o0: V3;
  /** Kesitler arası vektör (mm); ipp yoksa `sliceThickness` ve normal yönüyle üretilir. */
  tvec: V3;
  r: V3;
  c: V3;
  n: V3;
  psX: number;
  psY: number;
  w: number;
  h: number;
  nSlices: number;
  sliceStepMm: number;
}

/** Kaynak seriden hacim geometrisi; MPR uygunsa nesneyi, değilse null döner. */
export function volumeGeometry(s: SeriesData): VolumeGeom | null {
  const w = s.width;
  const h = s.height;
  const nSlices = s.slices.length;
  if (!w || !h || !nSlices) return null;
  const iop = s.orientation;
  const r: V3 = iop && iop.length >= 6 ? [iop[0], iop[1], iop[2]] : [1, 0, 0];
  const c: V3 = iop && iop.length >= 6 ? [iop[3], iop[4], iop[5]] : [0, 1, 0];
  const n = norm(cross(r, c));
  const psX = s.pixelSpacingX ?? s.pixelSpacing ?? 1;
  const psY = s.pixelSpacing ?? 1;
  const o0: V3 = s.ipp?.[0] ? [s.ipp[0][0], s.ipp[0][1], s.ipp[0][2]] : [0, 0, 0];
  let tvec: V3;
  if (s.ipp && s.ipp.length === nSlices && nSlices > 1 && s.ipp[nSlices - 1]) {
    const last = s.ipp[nSlices - 1];
    tvec = [(last[0] - o0[0]) / (nSlices - 1), (last[1] - o0[1]) / (nSlices - 1), (last[2] - o0[2]) / (nSlices - 1)];
  } else {
    const step = s.sliceThickness || s.sliceSpacing || 1;
    tvec = mul(n, step);
  }
  const sliceStepMm = Math.hypot(tvec[0], tvec[1], tvec[2]);
  return { o0, tvec, r, c, n, psX, psY, w, h, nSlices, sliceStepMm };
}

/** Ters-çözüm: hasta konumundan kaynak (satır, sütun, kesit) endekslerine. */
export function patientToIndex(g: VolumeGeom, p: V3): [number, number, number] {
  const d = sub(p, g.o0);
  const k = dot(d, g.n) / Math.max(1e-9, dot(g.tvec, g.n)) ;
  const i = dot(d, g.r) / g.psY;
  const j = dot(d, g.c) / g.psX;
  return [i, j, k];
}

function sample(s: SeriesData, g: VolumeGeom, i: number, j: number, k: number): number {
  const W = g.w;
  const H = g.h;
  const N = g.nSlices;
  const i0 = Math.floor(i);
  const j0 = Math.floor(j);
  const k0 = Math.floor(k);
  const fi = i - i0;
  const fj = j - j0;
  const fk = k - k0;
  const inside = (ii: number, jj: number) => ii >= 0 && ii < H && jj >= 0 && jj < W;
  const get = (kk: number, ii: number, jj: number) => {
    if (kk < 0 || kk >= N || !inside(ii, jj)) return null;
    return s.slices[kk][ii * W + jj] as number;
  };
  let acc = 0;
  let wsum = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const v = get(k0 + dz, i0 + dy, j0 + dx);
        if (v === null) continue;
        const wgt = (dz ? fk : 1 - fk) * (dy ? fi : 1 - fi) * (dx ? fj : 1 - fj);
        acc += v * wgt;
        wsum += wgt;
      }
    }
  }
  if (wsum === 0) return s.unit === "HU" ? -1000 : 0; // hacim dışı: hava/sıfır
  return acc / wsum;
}

export interface MprOptions {
  /** Hedef piksel ölçeği kaynağınkinden farklı ise uygulanır (varsayılan 1). */
  scale?: number;
}

/**
 * Verilen düzlem için sanal `SeriesData` üretir.
 * - axial: kaynak serinin aynısı (kopya).
 * - coronal: (x,z) düzlemi — satır = kesit yönü, sütun = sütun yönü.
 * - sagittal: (y,z) düzlemi — satır = kesit yönü, sütun = satır yönü.
 */
export function mprSeries(s: SeriesData, plane: MprPlane, opts: MprOptions = {}): SeriesData | null {
  const g = volumeGeometry(s);
  if (!g) return null;
  const scale = opts.scale ?? 1;

  if (plane === "axial") {
    return { ...s, id: `${s.id}__mpr_axial`, description: `${s.description} · aksiyel (orijinal)` };
  }

  const W = g.w;
  const H = g.h;
  const N = g.nSlices;

  // Kaynak hacim merkezi (piksel merkezleri mertebesinde).
  const center = add(g.o0, add(mul(g.c, (W / 2) * g.psX), add(mul(g.r, (H / 2) * g.psY), mul(g.tvec, N / 2))));
  // Görüntü merkezleri piksel izinlerinin yarısı kadar kayar; tutarlılık için 0.5 eklenmez.

  let outW: number;
  let outN: number;
  let U: V3;
  let V: V3;
  let du: number;
  let dv: number;
  if (plane === "coronal") {
    outW = Math.max(1, Math.round(W * scale));
    outN = Math.max(1, Math.round(N * scale));
    U = g.c;
    V = g.n;
    du = g.psX;
    dv = g.sliceStepMm;
  } else {
    outW = Math.max(1, Math.round(H * scale));
    outN = Math.max(1, Math.round(N * scale));
    U = g.r;
    V = g.n;
    du = g.psY;
    dv = g.sliceStepMm;
  }

  // Merkezli orijin: (outW/2, outN/2) hedef pikseli kaynak merkezine denk gelsin.
  const origin = sub(center, add(mul(U, (outW / 2) * du), mul(V, (outN / 2) * dv)));

  const slices: Float32Array[] = [];
  for (let q = 0; q < outN; q++) {
    const buf = new Float32Array(outW);
    for (let p = 0; p < outW; p++) {
      const pos = add(origin, add(mul(U, p * du), mul(V, q * dv)));
      const [i, j, k] = patientToIndex(g, pos);
      buf[p] = sample(s, g, i, j, k);
    }
    slices.push(buf);
  }

  // Hedef serinin kendi geometrisi (LPS): satır yönü V'nin tersi, sütun U.
  const outR: V3 = norm(mul(V, -1));
  const outC: V3 = U;
  const outNrm = norm(cross(outR, outC));
  const outPsX = du;
  const outPsY = dv;
  const ipp: number[][] = [];
  for (let q = 0; q < outN; q++) {
    const pos = add(origin, add(mul(U, 0), mul(V, q * dv)));
    ipp.push([pos[0], pos[1], pos[2]]);
  }

  const label =
    plane === "coronal"
      ? `${s.description} · KORONAL (MPR)`
      : `${s.description} · SAGİTTAL (MPR)`;

  return {
    ...s,
    id: `${s.id}__mpr_${plane}`,
    description: label,
    width: outW,
    height: outN,
    pixelSpacing: outPsY,
    pixelSpacingX: outPsX,
    sliceThickness: dv,
    slices,
    ipp,
    orientation: [...outR, ...outC],
    lesions: [],
    tags: [],
    defaultWL: s.defaultWL,
    defaultWW: s.defaultWW,
  };
}

/**
 * Oblik düzlemin ortogonal MPR panellerinde çizgi olarak gösterimi — v-mpr maddesi.
 *
 * Oblik MPR düzlemi: hasta uzayında merkezi P, normali n (obliqueBasis üzerinden) olan
 * düzlem; denklem n·(q − P) = 0. Her ortogonal panel afin bir çerçevedir:
 *   pos(p,q) = origin + U·p·du + V·q·dv   (p,q panel piksel koordinatı)
 * Düzlemin panelle kesişimi:
 *   A·p + B·q = K,  A = n·U·du, B = n·V·dv, K = n·(P − origin)
 * Bu doğru dikdörtgen [0,w]×[0,h] ile kesilir (sonsuz doğru ∩ dikdörtgen, kenar kesişimleri).
 * A ≈ B ≈ 0 ise düzlem panelle paraleldir (kesişim çizgisi yok) → null. Panelin KENDİSİ
 * düzlemle çakışıyorsa (A=B=K=0) da null döner; çizilecek çizgi yoktur.
 * Saf fonksiyondur; UI VolumeView/Plane'dedir.
 */
import type { SeriesData } from "./types";
import { planeFrame, volumeGeometry, type MprPlane } from "./mpr";
import { obliqueBasis } from "./volume";

export interface LineSeg {
  /** Panel veri birimlerinde (p,q) uç noktalar; Plane `rowScale` ile ölçekleyip çizer. */
  x0: number; y0: number; x1: number; y1: number;
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** Sonsuz doğruyu A·p + B·q = K dikdörtgenle keser; en uzak iki kesim noktasını döner, yoksa null. */
export function clipLineToRect(A: number, B: number, K: number, w: number, h: number): LineSeg | null {
  if (Math.abs(A) < 1e-12 && Math.abs(B) < 1e-12) return null;
  const pts: [number, number][] = [];
  const push = (p: number, q: number) => { if (p >= -1e-6 && p <= w + 1e-6 && q >= -1e-6 && q <= h + 1e-6) pts.push([Math.min(Math.max(p, 0), w), Math.min(Math.max(q, 0), h)]); };
  if (Math.abs(B) >= 1e-12) { push(0, K / B); push(w, (K - A * w) / B); }
  if (Math.abs(A) >= 1e-12) { push(K / A, 0); push((K - B * h) / A, h); }
  const uniq: [number, number][] = [];
  for (const p of pts) if (!uniq.some((u) => Math.hypot(u[0] - p[0], u[1] - p[1]) < 1e-6)) uniq.push(p);
  if (uniq.length < 2) return null;
  let i0 = 0, i1 = 1, best = -1;
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
    const d = Math.hypot(uniq[i][0] - uniq[j][0], uniq[i][1] - uniq[j][1]);
    if (d > best) { best = d; i0 = i; i1 = j; }
  }
  return { x0: uniq[i0][0], y0: uniq[i0][1], x1: uniq[i1][0], y1: uniq[i1][1] };
}

/** Hasta uzayındaki oblik düzlemle panelin kesişim çizgisi (veri birimlerinde). */
export function obliqueLineOnPlane(
  frame: { origin: V3; u: V3; v: V3; w: number; h: number; du: number; dv: number },
  center: V3,
  n: V3,
): LineSeg | null {
  const A = dot(n, frame.u) * frame.du;
  const B = dot(n, frame.v) * frame.dv;
  const K = dot(n, sub(center, frame.origin));
  return clipLineToRect(A, B, K, frame.w, frame.h);
}

/**
 * Üç ortogonal panel için kesişim çizgileri.
 * @param center voksel koordinatı (x=sütun, y=satır, z=kesit) — MPR çapraz imleci ile aynı.
 */
export function obliqueLinesFor(
  s: SeriesData,
  center: { x: number; y: number; z: number },
  rotX: number,
  rotY: number,
  rotZ: number,
): Record<MprPlane, LineSeg | null> {
  const empty = { axial: null, coronal: null, sagittal: null };
  const g = volumeGeometry(s);
  if (!g) return empty;
  // oblik düzlemin yerel normali → hasta uzayı
  const { n: nLocal } = obliqueBasis(rotX, rotY, rotZ);
  const nPatient = add(add(scale(g.c, nLocal[0]), scale(g.r, nLocal[1])), scale(g.n, nLocal[2]));
  // merkezin hasta uzayındaki konumu (o0 + j·psX·c + i·psY·r + k·tvec)
  const centerP = add(add(add(g.o0, scale(g.c, center.x * g.psX)), scale(g.r, center.y * g.psY)), scale(g.tvec, center.z));
  const levels: Record<MprPlane, { index?: number; row?: number; col?: number }> = {
    axial: { index: Math.round(center.z) },
    coronal: { row: Math.round(center.y) },
    sagittal: { col: Math.round(center.x) },
  };
  const out: Record<MprPlane, LineSeg | null> = { ...empty };
  for (const plane of ["axial", "coronal", "sagittal"] as const) {
    const frame = planeFrame(s, plane, levels[plane]);
    out[plane] = frame ? obliqueLineOnPlane(frame, centerP, nPatient) : null;
  }
  return out;
}

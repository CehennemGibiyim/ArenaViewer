import type { Mesh } from "./volume";

/**
 * Mesh düzgünleştirme — v-vr "Kalan: ... mesh düzgünleştirme" maddesi.
 *
 * isoSurface() üçgen çorbası üretir (üçgenler köşe paylaşmaz); Laplacian
 * düzleştirme ancak köşeler kaynaklanırsa etkilidir. Bu modül:
 *   1) önce köşe kaynaştırma (nicelenmiş mm anahtarıyla),
 *   2) sonra Taubin (λ|μ) düzleştirme uygular — saf Laplacian'ın aksine hacmi
 *      neredeyse korur (|μ| > λ ve μ < 0),
 *   3) sonucu yeniden üçgen çorbasına çevirir (çıktı toBinaryStl ile doğrudan yazılır).
 * Kapalı yüzey varsayar (iç/dış sınırı yoktur). Saf fonksiyondur; ağ yoktur.
 */

export interface SmoothOptions {
  /** Genişletme katsayısı (tipik 0.5). */
  lambda?: number;
  /** Büzme katsayısı (tipik -0.53); negatif ve |μ| ≥ |λ| olmalı. */
  mu?: number;
  /** λ|μ çift sayısı (varsayılan 12). */
  iterations?: number;
  /** Kaynak toleransı, mm (varsayılan 1e-4; isoSurface lerp çıktısıyla uyumlu). */
  weldEps?: number;
}

export interface SmoothResult {
  mesh: Mesh;
  /** Kaynaştırma öncesi çorba köşe sayısı (count*3) ve sonrası tekil köşe sayısı. */
  soupVertices: number;
  uniqueVertices: number;
}

/** Üçgen çorbasını kaynaştırır ve Taubin düzleştirme uygular. Boş mesh güvenli. */
export function smoothMesh(m: Mesh, o: SmoothOptions = {}): SmoothResult {
  const soup = m.count * 3;
  if (m.count === 0 || m.tris.length < m.count * 9) {
    return { mesh: { tris: new Float32Array(0), count: 0 }, soupVertices: soup, uniqueVertices: 0 };
  }
  const lambda = o.lambda ?? 0.5;
  const mu = o.mu ?? -0.53;
  const iters = Math.max(0, Math.floor(o.iterations ?? 12));
  const eps = o.weldEps ?? 1e-4;
  const inv = 1 / eps;
  const T = m.tris;

  // ── 1) köşe kaynaştırma ──
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
  const ids = new Uint32Array(soup);
  const posArr: number[] = [];
  const keyToId = new Map<string, number>();
  for (let i = 0; i < soup; i++) {
    const b = i * 3;
    const key = keyOf(T[b], T[b + 1], T[b + 2]);
    let id = keyToId.get(key);
    if (id === undefined) {
      id = posArr.length / 3;
      posArr.push(T[b], T[b + 1], T[b + 2]);
      keyToId.set(key, id);
    }
    ids[i] = id;
  }
  const nV = posArr.length / 3;
  let px = new Float64Array(nV), py = new Float64Array(nV), pz = new Float64Array(nV);
  for (let i = 0; i < nV; i++) { px[i] = posArr[i * 3]; py[i] = posArr[i * 3 + 1]; pz[i] = posArr[i * 3 + 2]; }

  // ── komşuluk (kenar başına her iki yön) ──
  const adj: Set<number>[] = Array.from({ length: nV }, () => new Set<number>());
  for (let f = 0; f < m.count; f++) {
    const a = ids[f * 3], b = ids[f * 3 + 1], c = ids[f * 3 + 2];
    adj[a].add(b).add(c); adj[b].add(a).add(c); adj[c].add(a).add(b);
  }

  // ── 2) Taubin adımları (Jacobi: yeni diziye yaz, sonda yer değiştir) ──
  const stepAll = (coeff: number) => {
    const nx = new Float64Array(nV), ny = new Float64Array(nV), nz = new Float64Array(nV);
    for (let i = 0; i < nV; i++) {
      const nb = adj[i];
      if (nb.size === 0) { nx[i] = px[i]; ny[i] = py[i]; nz[i] = pz[i]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { sx += px[j]; sy += py[j]; sz += pz[j]; }
      const invN = 1 / nb.size;
      nx[i] = px[i] + coeff * (sx * invN - px[i]);
      ny[i] = py[i] + coeff * (sy * invN - py[i]);
      nz[i] = pz[i] + coeff * (sz * invN - pz[i]);
    }
    px = nx; py = ny; pz = nz;
  };
  for (let k = 0; k < iters; k++) { stepAll(lambda); stepAll(mu); }

  // ── 3) çorba yeniden kur ──
  const out = new Float32Array(T.length);
  for (let f = 0; f < m.count; f++) {
    for (let v = 0; v < 3; v++) {
      const id = ids[f * 3 + v], b = (f * 3 + v) * 3;
      out[b] = px[id]; out[b + 1] = py[id]; out[b + 2] = pz[id];
    }
  }
  return { mesh: { tris: out, count: m.count }, soupVertices: soup, uniqueVertices: nV };
}

/** Kapalı mesh'in imzalı hacmi (tetra toplamı, mm³). Düz/bozuk girdide NaN döner. */
export function meshVolumeMm3(m: Mesh): number {
  const T = m.tris;
  let vol = 0;
  for (let f = 0; f < m.count; f++) {
    const b = f * 9;
    const ax = T[b], ay = T[b + 1], az = T[b + 2];
    const bx = T[b + 3], by = T[b + 4], bz = T[b + 5];
    const cx = T[b + 6], cy = T[b + 7], cz = T[b + 8];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(vol) / 6;
}

/**
 * v-vr "mesh düzgünleştirme": köşe kaynaştırma + Taubin λ|μ düzleştirme testleri.
 * Sentetik küre hacminden isoSurface ile gerçek yüzey üretilip düzleştirilir.
 */
import assert from "node:assert/strict";
import { isoSurface, volGeo, type Mesh } from "../src/lib/volume";
import { meshVolumeMm3, smoothMesh } from "../src/lib/meshSmooth";
import type { SeriesData } from "../src/lib/types";

const W = 32, H = 32, N = 32, R = 11;
function sphereVolume(): SeriesData {
  const slices: Float32Array[] = [];
  const c = (W - 1) / 2;
  for (let k = 0; k < N; k++) {
    const b = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const d2 = (i - c) * (i - c) + (j - c) * (j - c) + (k - c) * (k - c);
      b[j * W + i] = R * R - d2; // küre içi pozitif
    }
    slices.push(b);
  }
  return {
    id: "s", modality: "CT", description: "test küresi", bodyPart: "",
    patientName: "T", patientId: "T", patientAge: "50", patientSex: "M",
    studyDate: "20260101", institution: "T", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: 2, pixelSpacingX: 2, sliceThickness: 2,
    defaultWL: 40, defaultWW: 400, unit: "HU",
    slices, lesions: [], tags: [], isSample: true,
    orientation: [1, 0, 0, 0, 1, 0], ipp: Array.from({ length: N }, (_, k) => [0, 0, 2 * k]),
  } as unknown as SeriesData;
}

const series = sphereVolume();
const mesh = isoSurface(series, 0, 64);
assert.ok(mesh.count > 100, `küre yüzeyi üçgen üretir (${mesh.count})`);
const v0 = meshVolumeMm3(mesh);
const analytic = (4 / 3) * Math.PI * Math.pow(R * 2, 3); // mm³ (voksel 2 mm)
console.log(`iso küre hacmi ${(v0 / 1000).toFixed(1)} cm³ (analitik ≈ ${(analytic / 1000).toFixed(1)} cm³), ${mesh.count} üçgen`);
assert.ok(Math.abs(v0 - analytic) / analytic < 0.25, "isoSurface hacmi analitiğin %25'i içinde");

// 1) köşe kaynaştırma: çorba → tekil
const sm = smoothMesh(mesh, { iterations: 1 });
assert.ok(sm.uniqueVertices < sm.soupVertices, `kaynaştırma küçültür (${sm.soupVertices} → ${sm.uniqueVertices})`);
console.log("PASS köşe kaynaştırma (çorba → tekil)");

// 2) Taubin: üçgen sayısı korunur
assert.equal(sm.mesh.count, mesh.count, "üçgen sayısı düzleştirmede değişmez");
console.log("PASS üçgen sayısı korunur");

// 3) Hacim korunumu (Taubin saf Laplacian'dan iyi olmalı)
const sm12 = smoothMesh(mesh, { iterations: 12 });
const v1 = meshVolumeMm3(sm12.mesh);
const shrink = Math.abs(v1 - v0) / v0;
console.log(`Taubin 12 çift: hacim kayması %${(shrink * 100).toFixed(2)}`);
assert.ok(shrink < 0.08, "12 Taubin çifti hacmi %8'den fazla değiştirmez");
console.log("PASS hacim korunumu (<%8)");

// 4) Pürüzlülük azalır: köşe başına komşu ortalığından sapma düşer
function roughness(m: Mesh): number {
  const T = m.tris, pos = new Map<string, number>(), pts: number[] = [];
  const inv = 1e4;
  const idx = (x: number, y: number, z: number) => {
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = pos.get(key); if (id === undefined) { id = pts.length / 3; pts.push(x, y, z); pos.set(key, id); } return id;
  };
  const adj: Set<number>[] = [];
  for (let f = 0; f < m.count; f++) {
    const b = f * 9, a = idx(T[b], T[b + 1], T[b + 2]), c = idx(T[b + 3], T[b + 4], T[b + 5]), d = idx(T[b + 6], T[b + 7], T[b + 8]);
    while (adj.length < pts.length / 3) adj.push(new Set());
    adj[a].add(c).add(d); adj[c].add(a).add(d); adj[d].add(a).add(c);
  }
  let acc = 0, n = 0;
  for (let i = 0; i < adj.length; i++) {
    const nb = adj[i]; if (nb.size === 0) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const j of nb) { sx += pts[j * 3]; sy += pts[j * 3 + 1]; sz += pts[j * 3 + 2]; }
    acc += Math.hypot(pts[i * 3] - sx / nb.size, pts[i * 3 + 1] - sy / nb.size, pts[i * 3 + 2] - sz / nb.size); n++;
  }
  return acc / n;
}
const r0 = roughness(mesh), r1 = roughness(sm12.mesh);
console.log(`pürüzlülük: ${r0.toFixed(4)} mm → ${r1.toFixed(4)} mm`);
assert.ok(r1 < r0, "Taubin pürüzlülüğü azaltır");
console.log("PASS pürüzlülük azalır");

// 5) Boş ve bozuk girdi güvenli
const empty = smoothMesh({ tris: new Float32Array(0), count: 0 });
assert.equal(empty.mesh.count, 0);
const ragged = smoothMesh({ tris: new Float32Array(3), count: 1 }); // eksik veri
assert.equal(ragged.mesh.count, 0);
console.log("PASS boş/bozuk girdi güvenli");

// 6) isoSurface hacmi/volGeo ile uyum: STL akışı değişmedi
assert.ok(volGeo(series).n === 32, "volGeo bozulmadı");
console.log("PASS volGeo etkileşimsiz");

console.log("Tüm mesh-smooth testleri geçti.");

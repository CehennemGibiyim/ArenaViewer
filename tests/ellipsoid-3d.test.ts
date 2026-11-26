/**
 * m-shapes: 3. eksen çapı tahmini testleri.
 * Sentetik hacim: 0 HU arka plan üzerinde 40 HU yükseklikte elipsoid lezyon (HU 200).
 */
import assert from "node:assert/strict";
import { otsu1d, suggestEllipsoidD3 } from "../src/lib/ellipsoid3d";
import type { SeriesData } from "../src/lib/types";

const W = 40, H = 40, N = 20, PS = 2, SZ = 3;
const CX = 20, CY = 20, RX = 6, RY = 5;
const LES_HU = 200, BG = 0;
// lezyon z-aralığı: kesitler 7..12 (6 kesit)
function lesionVolume(): SeriesData {
  const slices: Float32Array[] = [];
  for (let k = 0; k < N; k++) {
    const b = new Float32Array(W * H).fill(BG);
    const inZ = k >= 7 && k <= 12;
    if (inZ) {
      // katı (uniform HU) elipsoid; uç kesitlerde hafif daralma (kısmi hacim payı)
      const t = (k - 7) / 5; // 0..1
      const taper = 1 - 0.35 * Math.pow(Math.abs(t - 0.5) * 2, 2);
      const rx = RX * taper, ry = RY * taper;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - CX) / rx, dy = (y + 0.5 - CY) / ry;
        if (dx * dx + dy * dy <= 1) b[y * W + x] = LES_HU;
      }
    }
    slices.push(b);
  }
  return {
    id: "les", modality: "CT", description: "test lezyonu", bodyPart: "AC",
    patientName: "T", patientId: "T", patientAge: "50", patientSex: "M",
    studyDate: "20260101", institution: "T", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: PS, pixelSpacingX: PS, sliceThickness: SZ, sliceSpacing: SZ,
    defaultWL: 40, defaultWW: 400, unit: "HU",
    slices, lesions: [], tags: [], isSample: true,
    orientation: [1, 0, 0, 0, 1, 0], ipp: Array.from({ length: N }, (_, k) => [0, 0, k * SZ]),
  } as unknown as SeriesData;
}

// 1) Otsu: iki modlu dizi
const thr = otsu1d([0, 1, 0, 1, 1, 0, 9, 10, 9, 10, 10, 9])!;
assert.ok(thr >= 0.99 && thr < 9, `otsu eşik iki mod arasında (${thr})`);
assert.equal(otsu1d([5, 5, 5]), null, "tek değer → null");
const two = otsu1d([1, 2])!;
assert.ok(two >= 1 && two <= 2, "iki değer → sınırlı (1..2)");
console.log("PASS Otsu 1B");

// 2) Lezyon tahmini: orta kesitten tarama
const series = lesionVolume();
const est = suggestEllipsoidD3(series, 9, { cx: CX, cy: CY, rx: RX, ry: RY })!;
assert.ok(est, "tahmin üretildi");
console.log(`koşu ${est.sliceRun} kesit · d3 ${est.d3Mm} mm · eşik ${est.threshold.toFixed(0)} HU`);
assert.ok(est.sliceRun >= 5 && est.sliceRun <= 7, "6 kesitlik lezyon yakalandı (±1)");
assert.ok(Math.abs(est.d3Mm - est.sliceRun * SZ) < 1e-9, "d3 = koşu × kesit aralığı");
assert.ok(est.threshold > 10 && est.threshold < 199, "eşik arka planla lezyon arasında");
console.log("PASS lezyon z-yayılımı (6 kesit)");

// 3) Kenar kesitten de koşu taşınır
const estEdge = suggestEllipsoidD3(series, 7, { cx: CX, cy: CY, rx: RX, ry: RY })!;
assert.ok(estEdge && estEdge.sliceRun >= 5, "kenar kesitte de koşu bulunur");
console.log("PASS kenar kesit toleransı");

// 4) Düz hacim → null (tahmin yok)
const flatSlices = Array.from({ length: 10 }, () => new Float32Array(W * H).fill(40));
const flat = { ...series, slices: flatSlices } as unknown as SeriesData;
assert.equal(suggestEllipsoidD3(flat, 5, { cx: CX, cy: CY, rx: RX, ry: RY }), null, "kontrastsız hacim → null");
console.log("PASS düz hacim → tahmin yok");

// 5) Hacim dışı/boş seri güvenli
assert.equal(suggestEllipsoidD3({ ...series, slices: [] } as unknown as SeriesData, 0, { cx: 5, cy: 5, rx: 2, ry: 2 }), null);
console.log("PASS boş seri");

// 6) Kontrastı zayıf ama var: minContrast'i düşür → bulur
const weakSlices: Float32Array[] = [];
for (let k = 0; k < 10; k++) {
  const b = new Float32Array(W * H).fill(100);
  if (k >= 4 && k <= 6) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x + 0.5 - CX) / 5, dy = (y + 0.5 - CY) / 4;
    if (dx * dx + dy * dy <= 1) b[y * W + x] = 125; // 25 HU kontrast
  }
  weakSlices.push(b);
}
const weak = { ...series, slices: weakSlices } as unknown as SeriesData;
assert.equal(suggestEllipsoidD3(weak, 5, { cx: CX, cy: CY, rx: 5, ry: 4 }), null, "25 HU kontrast varsayılan 30 eşikte null");
const weakEst = suggestEllipsoidD3(weak, 5, { cx: CX, cy: CY, rx: 5, ry: 4 }, { minContrast: 10 });
assert.ok(weakEst && weakEst.sliceRun === 3, "düşük kontrast minContrast ile yakalanır");
console.log("PASS düşük kontrast davranışı");

console.log("Tüm ellipsoid-3d testleri geçti.");

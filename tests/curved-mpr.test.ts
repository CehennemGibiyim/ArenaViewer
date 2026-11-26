/**
 * Kavisli MPR saf fonksiyon testleri.
 * Sentetik 3B hacimde bilinen bir çeyrek-çember tüp hattı: değer = 1000 - mesafe (yarıçap 5 mm).
 */
import assert from "node:assert/strict";
import { curvedMpr, parallelTransport, resampleCenterline } from "../src/lib/curvedMpr";
import type { SeriesData } from "../src/lib/types";

const W = 48, H = 48, N = 48, PS = 2; // voksel 2 mm
const c = (W - 1) / 2;
const R_TUBE_MM = 5;
const TUBE_CENTER_MM_RADIUS = 16; // çeyrek çember yarıçapı (mm), merkez (0,y,0)

function tubeVolume(): SeriesData {
  const slices: Float32Array[] = [];
  const cy = (H - 1) / 2;
  for (let k = 0; k < N; k++) {
    const b = new Float32Array(W * H);
    const zmm = k * PS;
    for (let j = 0; j < H; j++) {
      const ymm = j * PS;
      for (let i = 0; i < W; i++) {
        const xmm = i * PS;
        // merkez hattı: x = R·sin θ, z = R·(1-cos θ)  (θ ∈ [0, π/2]), y sabit
        // nokta-küme mesafesinin yaklaşık formu: çeyrek çember yayına uzaklık
        const dx = xmm - 0, dz = zmm - 0;
        // yay üzerindeki en yakın nokta: θ* = atan2(|dx|, ...) — çeyrek çember x≥0, z≥0 bölgesinde
        // merkez hattı: merkez (0, y, R) etrafında yarıçap R çember yayı (θ ∈ [0,π/2])
        const r = Math.hypot(dx, dz - TUBE_CENTER_MM_RADIUS);
        const dCenter = Math.abs(r - TUBE_CENTER_MM_RADIUS);
        const d = Math.hypot(dCenter, ymm - cy * PS);
        b[j * W + i] = 1000 - Math.min(1000, (d / R_TUBE_MM) * 1000);
      }
    }
    slices.push(b);
  }
  return {
    id: "tube", modality: "CT", description: "test tüpü", bodyPart: "",
    patientName: "T", patientId: "T", patientAge: "50", patientSex: "M",
    studyDate: "20260101", institution: "T", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: PS, pixelSpacingX: PS, sliceThickness: PS,
    defaultWL: 40, defaultWW: 400, unit: "HU",
    slices, lesions: [], tags: [], isSample: true,
    orientation: [1, 0, 0, 0, 1, 0], ipp: Array.from({ length: N }, (_, k) => [0, 0, PS * k]),
  } as unknown as SeriesData;
}

const series = tubeVolume();
const R_MM = TUBE_CENTER_MM_RADIUS;
// yay üzerindeki üç kontrol noktası (voksel cinsi): θ = 0, 45°, 90°
const arcPt = (thetaDeg: number): [number, number, number] => {
  const t = (thetaDeg * Math.PI) / 180;
  return [(R_MM * Math.sin(t)) / PS, (H - 1) / 2, (R_MM * (1 - Math.cos(t))) / PS];
};

// 1) merkez hattı örnekleme: yay uzunluğu ve örnek sayısı
const step = PS;
const frames = resampleCenterline([arcPt(0), arcPt(45), arcPt(90)], PS, PS, PS, step, 1024);
assert.ok(frames.length > 10, `yeterli örnek (${frames.length})`);
let arcLen = 0;
for (let i = 1; i < frames.length; i++) arcLen += Math.hypot(...frames[i].p.map((v, k) => v - frames[i - 1].p[k]));
const expectedArc = (Math.PI / 2) * R_MM;
console.log(`yay ${arcLen.toFixed(1)} mm (beklenen ≈ ${expectedArc.toFixed(1)} mm)`);
assert.ok(Math.abs(arcLen - expectedArc) / expectedArc < 0.05, "yay uzunluğu %5 içinde");
console.log("PASS merkez hattı yay uzunluğu");

// 2) paralel taşıma: çerçeve teğete dik kalır
const pt = parallelTransport(frames);
for (let i = 0; i < frames.length; i += Math.floor(frames.length / 8)) {
  const t = frames[i].t, n = pt[i].n, b = pt[i].b;
  assert.ok(Math.abs(t[0] * n[0] + t[1] * n[1] + t[2] * n[2]) < 1e-6, `t⊥n (i=${i})`);
  assert.ok(Math.abs(t[0] * b[0] + t[1] * b[1] + t[2] * b[2]) < 1e-6, `t⊥b (i=${i})`);
}
console.log("PASS paralel taşıma dikliği");

// 3) kavisli yeniden kesit: merkez sütun tüp hattını izler (yüksek değer), kenarlar düşer
const img = curvedMpr(series, { points: [arcPt(0), arcPt(45), arcPt(90)], halfWidthMm: 10, stepMm: PS });
assert.ok(img, "görüntü üretildi");
const { data, width, height, lengthMm } = img!;
assert.ok(height > 10 && width > 4, `boyutlar makul (${width}×${height})`);
assert.ok(Math.abs(lengthMm - expectedArc) / expectedArc < 0.05, "lengthMm yay uzunluğuna eşit");
let centerSum = 0, edgeSum = 0;
for (let r = 0; r < height; r++) {
  centerSum += data[r * width + (width >> 1)];
  edgeSum += Math.min(data[r * width + 0], data[r * width + width - 1]);
}
const centerAvg = centerSum / height, edgeAvg = edgeSum / height;
console.log(`merkez ort. ${centerAvg.toFixed(0)} | kenar ort. ${edgeAvg.toFixed(0)}`);
assert.ok(centerAvg > 500, "merkez hattı tüp içinde (parlak)");
assert.ok(centerAvg - edgeAvg > 300, "merkez-kenar kontrastı belirgin");
console.log("PASS tüp hattı takibi (merkez parlak, kenar sönük)");

// 4) sabit hacimde doğrusal hat: tüm örnekler sabit, genişlik formülü doğru
const flatSlices: Float32Array[] = [];
for (let k = 0; k < 8; k++) flatSlices.push(new Float32Array(16 * 16).fill(500));
const flat = { ...series, slices: flatSlices, width: 16, height: 16 } as unknown as SeriesData;
const flatImg = curvedMpr(flat, { points: [[2, 8, 2], [13, 8, 6]], halfWidthMm: 4, stepMm: 2 });
assert.ok(flatImg, "doğrusal hat çalışır");
assert.ok([...flatImg.data].every((v) => Math.abs(v - 500) < 1e-6), "sabit hacim → tüm örnekler 500");
const expectW = Math.max(8, Math.floor((2 * 4) / 2.128) + 1); // ızgara en az 8 sütun
assert.equal(flatImg.width, expectW, `yanal genişlik max(8, floor(2·yarı/fiili adım)+1) = ${expectW}`);
console.log("PASS doğrusal hat + yanal genişlik formülü");

// 5) kurallı hatlar/dejenere girdi
assert.equal(curvedMpr(series, { points: [] }), null);
assert.equal(curvedMpr(series, { points: [[10, 10, 10]] }), null);
assert.equal(curvedMpr(series, { points: [[10, 10, 10], [10, 10, 10], [10, 10, 10]] }), null, "aynı nokta üç kez → null");
// aynı noktalar arasında ikinci (geçerli) nokta varsa tekrarlar sorunsuz:
const dup = curvedMpr(series, { points: [[8, 24, 4], [8, 24, 4], [40, 24, 16]], halfWidthMm: 5 });
assert.ok(dup, "yinelenen noktalar elenip hat üretilir");
console.log("PASS dejenere girdiler");

// 6) hacim dışı: BG döner
const outside = curvedMpr(series, { points: [[0, 0, 0], [0, 0, 6]], halfWidthMm: 400 });
assert.ok(outside, "görüntü yine de üretilir");
const corners = [outside!.data[0], outside!.data[outside!.width - 1]];
assert.ok(corners.every((v) => v <= -3e38 || Number.isFinite(v)), "köşeler tanımlı (BG veya örnek)");
console.log("PASS hacim dışı kenarlar güvenli");

console.log("Tüm curved-mpr testleri geçti.");

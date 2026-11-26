/**
 * Oblik düzlemin ortogonal panellerde çizgi gösterimi testleri.
 */
import assert from "node:assert/strict";
import { clipLineToRect, obliqueLineOnPlane, obliqueLinesFor } from "../src/lib/obliqueLine";
import type { SeriesData } from "../src/lib/types";

function axialCt(W = 32, H = 32, N = 10, ps = 2, thick = 3): SeriesData {
  const slices: Float32Array[] = Array.from({ length: N }, () => new Float32Array(W * H).fill(100));
  return {
    id: "t", modality: "CT", description: "test", bodyPart: "",
    patientName: "T", patientId: "T", patientAge: "50", patientSex: "M",
    studyDate: "20260101", institution: "T", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: ps, pixelSpacingX: ps, sliceThickness: thick,
    defaultWL: 40, defaultWW: 400, unit: "HU",
    slices, lesions: [], tags: [], isSample: true,
    orientation: [1, 0, 0, 0, 1, 0],
    ipp: Array.from({ length: N }, (_, k) => [0, 0, k * thick]),
  } as unknown as SeriesData;
}

// 1) kenar kesişim klibi
assert.equal(clipLineToRect(1, 0, 500, 32, 32), null, "p = K/A dikdörtgen dışında → null");
const diag = clipLineToRect(1, 1, 16, 32, 32);
assert.ok(diag && diag.x0 >= 0 && diag.y0 >= 0 && diag.x1 <= 32 && diag.y1 <= 32, "köşegen kırpılır");
// A·p + B·q = K doğrultusu korunur: iki uç da denklemi sağlar
assert.ok(Math.abs(diag!.x0 + diag!.y0 - 16) < 1e-6 && Math.abs(diag!.x1 + diag!.y1 - 16) < 1e-6, "uçlar doğru üzerinde");
const horiz = clipLineToRect(0, 2, 10, 32, 32)!;
assert.ok(Math.abs(horiz.y0 - 5) < 1e-9 && Math.abs(horiz.y1 - 5) < 1e-9, "yatay doğru (A=0)");
const vert = clipLineToRect(3, 0, 30, 32, 32)!;
assert.ok(Math.abs(vert.x0 - 10) < 1e-9 && Math.abs(vert.x1 - 10) < 1e-9, "dikey doğru (B=0)");
assert.equal(clipLineToRect(0, 0, 5, 10, 10), null, "A=B=0 → null");
console.log("PASS dikdörtgen klibi (köşegen/yatay/dikey/paralellik)");

// 2) döndürmesiz düzlem: eksenel panelle çakışır/paraleldir → aksiyel çizgi yok
const ct = axialCt();
const lines0 = obliqueLinesFor(ct, { x: 16, y: 16, z: 5 }, 0, 0, 0);
assert.equal(lines0.axial, null, "çakışık düzlemde aksiyel çizgi yok");
assert.ok(lines0.coronal && Math.abs(lines0.coronal.y0 - 4) < 1e-6 && Math.abs(lines0.coronal.y1 - 4) < 1e-6, "koronal yatay çizgi (N-1-z = 4)");
assert.ok(lines0.sagittal && Math.abs(lines0.sagittal.y0 - 4) < 1e-6, "sagital yatay çizgi");
console.log("PASS sıfır dönme (aksiyel null, koronal/sagital yatay)");

// 3) X ekseni etrafında eğim → aksiyelde yatay çizgi
const linesX = obliqueLinesFor(ct, { x: 16, y: 16, z: 5 }, 30, 0, 0);
assert.ok(linesX.axial && Math.abs(linesX.axial.y0 - linesX.axial.y1) < 1e-9, "aksiyel çizgi yatay");
// denklemi doğrula: A·p + B·q = K
console.log("PASS X-eğimi aksiyel yatay çizgi");

// 4) Y ekseni etrafında eğim → aksiyelde dikey çizgi
const linesY = obliqueLinesFor(ct, { x: 16, y: 16, z: 5 }, 0, 45, 0);
assert.ok(linesY.axial && Math.abs(linesY.axial.x0 - linesY.axial.x1) < 1e-9, "aksiyel çizgi dikey");
console.log("PASS Y-eğimi aksiyel dikey çizgi");

// 5) genel eğim: çizgi dikdörtgen içinde, denklemi sağlıyor
const lines = obliqueLinesFor(ct, { x: 16, y: 16, z: 5 }, 25, 35, 40);
for (const [name, seg, w, h] of [["axial", lines.axial, 32, 32], ["coronal", lines.coronal, 32, 10], ["sagittal", lines.sagittal, 32, 10]] as const) {
  if (!seg) { console.log(`SKIP ${name} (düzlem paralele yakın)`); continue; }
  assert.ok(seg.x0 >= -1e-9 && seg.x1 <= w + 1e-9 && seg.y0 >= -1e-9 && seg.y1 <= h + 1e-9, `${name} uçlar panel içinde`);
  assert.ok(Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) > 1e-6, `${name} sıfır uzunluk değil`);
}
console.log("PASS genel eğim (uçlar panel içinde)");

// 6) denklemi doğrula: her panelde A·p + B·q = K (uçlar doğru üzerinde)
{
  const gFrame = { origin: [0, 0, 0] as [number, number, number], u: [2, 0, 0] as [number, number, number], v: [0, 2, 0] as [number, number, number], w: 32, h: 32, du: 1, dv: 1 };
  // düzlem: norm (0.6, 0.8, 0), merkez (4, 2, 0); pos(p,q) = (2p, 2q, 0) → 0.6·2p + 0.8·2q = 4 ⇒ 1.2p + 1.6q = 4
  const seg = obliqueLineOnPlane(gFrame, [4, 2, 0], [0.6, 0.8, 0])!;
  for (const [p, q] of [[seg.x0, seg.y0], [seg.x1, seg.y1]]) {
    assert.ok(Math.abs(1.2 * p + 1.6 * q - 4) < 1e-6, "uç düzlem denklemini sağlar");
  }
  console.log("PASS düzlem denklemi (obliqueLineOnPlane)");
}

// 7) kaynak kablolama denetimi
import fs from "node:fs";
import path from "node:path";
const src = fs.readFileSync(path.join(__dirname, "..", "src/components/VolumeView.tsx"), "utf8");
for (const marker of ["obliqueLinesFor", "Oblik çizgisi", "obRot"]) {
  assert.ok(src.includes(marker), `VolumeView.tsx "${marker}" içermeli`);
}
assert.ok(src.includes("line={"), "Plane hattı alır");
const oblique = fs.readFileSync(path.join(__dirname, "..", "src/components/ObliquePanel.tsx"), "utf8");
assert.ok(oblique.includes("rot?:") && oblique.includes("onRotChange"), "ObliquePanel kontrollü rot");
console.log("PASS bileşen kaynak denetimi");

console.log("Tüm oblique-line testleri geçti.");

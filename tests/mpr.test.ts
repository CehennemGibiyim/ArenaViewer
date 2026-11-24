/**
 * MPR (çok düzlemsel rekonstrüksiyon) saf fonksiyon testleri.
 * Sentetik 3B rampa hacmi: v(i,j,k) = 100k + 10j + i (i=satır, j=sütun, k=kesit).
 */
import { mprSeries, volumeGeometry, patientToIndex, MPR_PLANES, type MprPlane } from "../src/lib/mpr";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function volume(W = 8, H = 8, N = 5, over: Partial<SeriesData> = {}): SeriesData {
  const slices: Float32Array[] = [];
  for (let k = 0; k < N; k++) {
    const b = new Float32Array(W * H);
    for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) b[i * W + j] = 100 * k + 10 * j + i;
    slices.push(b);
  }
  const ipp: number[][] = [];
  for (let k = 0; k < N; k++) ipp.push([0, 0, 3 * k]);
  return {
    id: "vol", modality: "CT", description: "Test hacmi", bodyPart: "TORAKS",
    patientName: "TEST", patientId: "T1", patientAge: "50", patientSex: "M",
    studyDate: "20260101", institution: "TEST", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: 2, pixelSpacingX: 1, sliceThickness: 3,
    defaultWL: 40, defaultWW: 400, unit: "HU",
    slices, lesions: [], tags: [], isSample: true,
    orientation: [1, 0, 0, 0, 1, 0], ipp,
    ...over,
  };
}

// ── geometri ──
const g = volumeGeometry(volume())!;
ok(g.psX === 1 && g.psY === 2, `psX/psY doğru (${g.psX}/${g.psY})`);
ok(Math.abs(g.sliceStepMm - 3) < 1e-9, `kesit adımı 3 mm (${g.sliceStepMm})`);
ok(g.n[2] > 0.99, "kesit normali +Z");
ok(volumeGeometry(volume(0)) === null, "boş seri → null");

// ── ters çözüm ──
// i = satır (r=+X, psY), j = sütun (c=+Y, psX): i=2, j=1, k=1 beklenir.
const idx = patientToIndex(g, [g.psY * 2, g.psX * 1, 3]);
ok(Math.abs(idx[0] - 2) < 1e-9 && Math.abs(idx[1] - 1) < 1e-9 && Math.abs(idx[2] - 1) < 1e-9,
  `patient→index doğru (${idx.map((x) => x.toFixed(2)).join(",")})`);

// ── aksiyel ──
const ax = mprSeries(volume(), "axial")!;
ok(ax.id === "vol__mpr_axial" && ax.slices.length === 5 && ax.width === 8, "aksiyel = orijinal (sanal kopya)");

// ── koronal ──
const cor = mprSeries(volume(), "coronal")!;
ok(cor !== null && cor.width === 8 && cor.height === 5, `koronal boyut 8×5 (${cor?.width}×${cor?.height})`);
ok(Math.abs(cor.pixelSpacing! - 3) < 1e-9, `koronal satır aralığı = kesit adımı 3 (${cor.pixelSpacing})`);
ok(Math.abs(cor.pixelSpacingX! - 1) < 1e-9, "koronal sütun aralığı = kaynak psX");
ok(cor.slices[2][3] === 100 * 2 + 10 * 3 + 4, `koronal(3,2) kaynak (i=4,j=3,k=2) → ${cor.slices[2][3]}`);
ok(cor.slices[0][0] === 4, "koronal sol üst köşe kaynak (i=4,j=0,k=0)");
ok(cor.description.includes("KORONAL"), "koronal etiketi");
// Koronal: satır yönü = -kesit normali (yukarı baş), sütun yönü = kaynak sütun yönü (+Y).
ok(Math.abs(cor.orientation![0]) < 1e-9 && Math.abs(cor.orientation![2] + 1) < 1e-9 &&
   Math.abs(cor.orientation![3]) < 1e-9 && Math.abs(cor.orientation![4] - 1) < 1e-9,
  "koronal yönelim yeniden hesaplandı");
ok(cor.ipp!.length === 5 && Math.abs(cor.ipp![4][2] - 12) < 1e-9, "koronal ipp kesit derinliği");

// ── sagital ──
const sag = mprSeries(volume(), "sagittal")!;
ok(sag.width === 8 && sag.height === 5, `sagital boyut 8×5 (${sag.width}×${sag.height})`);
ok(sag.slices[1][2] === 100 * 1 + 10 * 4 + 2, `sagital(2,1) kaynak (i=2,j=4,k=1) → ${sag.slices[1][2]}`);
ok(Math.abs(sag.pixelSpacing! - 3) < 1e-9 && Math.abs(sag.pixelSpacingX! - 2) < 1e-9, "sagital ölçekleri doğru");

// ── kaynak bozulmaz ──
const src = volume();
mprSeries(src, "coronal");
mprSeries(src, "sagittal");
ok(src.slices[0][0] === 0 && src.slices[4][7 * 8 + 7] === 477, "kaynak seri değişmedi");
ok(src.width === 8 && src.height === 8, "kaynak boyutları korundu");

// ── sınır / ölçek ──
const half = mprSeries(volume(), "coronal", { scale: 0.5 })!;
ok(half.width === 4 && half.height === 3, `ölçek 0,5: 4×3 (${half.width}×${half.height})`);
ok(half.slices.length === 3, "önce kare sayısı ölçeklendi");

// ── oblik kesit yönü: kosinüs yaklaşımı ──
const oblique = volume(8, 8, 5, {
  ipp: [
    [0, 0, 0], [1, 0, 3], [2, 0, 6], [3, 0, 9], [4, 0, 12],
  ],
});
const og = volumeGeometry(oblique)!;
const oCor = mprSeries(oblique, "coronal")!;
// Oblikte tam eşleme beklenmez; ancak boyutlar ve ara değerler makul aralıkta.
ok(oCor.width === 8 && oCor.height === 5, "oblik seride boyutlar tutarlı");
ok(Number.isFinite(oCor.slices[2][3]) && Math.abs(oCor.slices[2][3] - 234) < 40,
  `oblik koronal değeri kaynağa yakın (${oCor.slices[2][3].toFixed(1)})`);

// ── sabit listeler ──
ok(MPR_PLANES.join(",") === "axial,coronal,sagittal", "düzlem listesi sabit");
const planes: MprPlane[] = ["axial", "coronal", "sagittal"];
ok(planes.every((p) => mprSeries(volume(), p) !== null), "üç düzlem de üretilebiliyor");

if (failed) { console.error(`${failed} MPR testi başarısız`); process.exit(1); }
console.log("Tüm MPR testleri geçti.");

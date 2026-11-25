/** Kesitler arası (z) kayma testleri — v-fusion. */
import type { SeriesData } from "../src/lib/types";
import { MIN_Z_SCORE, estimateSliceShift, slicePositions, sliceSpacingOf, zShiftNote } from "../src/lib/fusionZ";
import { resampleOnto } from "../src/lib/planes";
import { buildFusionLayer } from "../src/lib/fusion";
import { nccMasked } from "../src/lib/registration";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── yardımcılar ──
const W = 32, H = 32;
/** Kesit içeriği: z indeksine göre kayan iki disk (kesitler arasında ayırt edilebilir). */
function sliceContent(i: number): Float32Array {
  const sl = new Float32Array(W * H);
  const cx = 8 + i * 1.7, cy = 10 + i * 1.1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.hypot(x - cx, y - cy);
      const d2 = Math.hypot(x - (24 - i * 0.6), y - (20 + i * 0.4));
      sl[y * W + x] = Math.max(0, 1 - d1 / 6) + 0.7 * Math.max(0, 1 - d2 / 4);
    }
  }
  return sl;
}
const contents = Array.from({ length: 12 }, (_, i) => sliceContent(i));

function mkSeries(id: string, opts: { z0?: number; spacing?: number; idx?: number[]; frame?: string; thickness?: number } = {}): SeriesData {
  const z0 = opts.z0 ?? 0;
  const spacing = opts.spacing ?? 3;
  const idx = opts.idx ?? contents.map((_, i) => i);
  return {
    id, modality: "CT", description: id, bodyPart: "ABDOMEN", patientName: "T", patientId: "1",
    patientAge: "050Y", patientSex: "E", studyDate: "", institution: "", studyUid: "1.2.3",
    width: W, height: H, pixelSpacing: 1, pixelSpacingX: 1,
    sliceThickness: opts.thickness ?? spacing, sliceSpacing: spacing,
    orientation: [1, 0, 0, 0, 1, 0], frameOfRef: opts.frame ?? "F1",
    ipp: idx.map((_, j) => [0, 0, z0 + j * spacing]),
    slices: idx.map((i) => contents[Math.max(0, Math.min(contents.length - 1, i))]),
    defaultWL: 0, defaultWW: 1, unit: "HU",
  } as SeriesData;
}

// ── temel sözleşme ──
ok(sliceSpacingOf(mkSeries("a")) === 3, "kesit aralığı okunur");
ok(sliceSpacingOf({ ...mkSeries("a"), sliceSpacing: undefined, sliceThickness: 5 } as unknown as SeriesData) === 5, "aralık yoksa kalınlığa düşer");
const pos = slicePositions(mkSeries("a", { z0: 10 }))!;
ok(Math.abs(pos[0] - 10) < 1e-9 && Math.abs(pos[2] - 16) < 1e-9, "kesit konumları normal izdüşümünden (mm) hesaplanır");

// ── bilinen kayma: hareketli seri +6 mm (2 kesit) kaymış ──
const target = mkSeries("t");
// Hasta z yönünde 6 mm kaymış: kesit konumları aynı, ANCAK her kesit 2 kesit
// (6 mm) yukarıdaki anatomiyi gösteriyor → hedef kesit i, hareketlide i+2'de.
const moving = mkSeries("m", { z0: 0, idx: contents.map((_, i) => Math.max(0, i - 2)) });
const est = estimateSliceShift(target, moving, { maxShiftMm: 15 });
ok(est.improved, `z kayması bulundu (${est.dzMm} mm)`);
ok(Math.abs(est.dzMm - 6) <= 1, `kayma 6 mm'ye yakın (${est.dzMm} mm)`);
ok(Math.abs(est.dzSlices - 2) <= 0.4, `kesit biriminde ≈ 2 (${est.dzSlices})`);
ok(est.score > est.scoreBefore && est.score > MIN_Z_SCORE, `NCC ${est.scoreBefore.toFixed(2)} → ${est.score.toFixed(2)}`);
ok(est.pairs >= 4, `kesit çifti sayısı raporlanır (${est.pairs})`);

// kayma yoksa 0 döner
const estZero = estimateSliceShift(target, mkSeries("m2"), { maxShiftMm: 15 });
ok(!estZero.improved && estZero.dzMm === 0, "kayma yokken 0 döner ve uygulanmaz");
ok(!!estZero.reason, "kazançsız durumun nedeni yazılır");

// farklı çerçeve
const estFrame = estimateSliceShift(target, mkSeries("m3", { frame: "F9", idx: contents.map((_, i) => Math.max(0, i - 2)) }));
ok(!estFrame.improved && estFrame.dzMm === 0 && (estFrame.reason ?? "").includes("Frame of Reference"), "farklı çerçevede kestirim yok");

// eksik aralık
const noSpacing = { ...mkSeries("m4", { idx: contents.map((_, i) => Math.max(0, i - 2)) }), sliceSpacing: undefined, sliceThickness: undefined } as unknown as SeriesData;
const estSpacing = estimateSliceShift(target, noSpacing);
ok(!estSpacing.improved && (estSpacing.reason ?? "").includes("aralığı"), "kesit aralığı yoksa kestirim yok");

// az kesit
const few = { ...mkSeries("m5"), slices: contents.slice(0, 2), ipp: [[0, 0, 0], [0, 0, 3]] } as SeriesData;
const estFew = estimateSliceShift(target, few);
ok(!estFew.improved && (estFew.reason ?? "").includes("3 kesit"), "az kesitte kestirim yok");

// ızgara uyuşmazlığı
const other = { ...mkSeries("m6"), width: 64 } as SeriesData;
const estGrid = estimateSliceShift(target, other);
ok(!estGrid.improved && (estGrid.reason ?? "").includes("Izgara"), "farklı matriste kestirim yok");

// ── z kayması filtreyi düzeltir (resampleOnto) ──
const nccOf = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const mask = new Uint8Array(a.length);
  for (let i = 0; i < mask.length; i++) mask[i] = Number.isFinite(a[i]) && Number.isFinite(b[i]) ? 1 : 0;
  return nccMasked(Float32Array.from(a as ArrayLike<number>), Float32Array.from(b as ArrayLike<number>), mask).score;
};
const tgtSlice = target.slices[4];
const movNoZ = resampleOnto(target, 4, moving, 0);
const movZ = resampleOnto(target, 4, moving, 6);
ok(!!movNoZ && !!movZ, "z kaymalı ve kaymasız yeniden örnekleme üretilir");
const nccNoZ = nccOf(tgtSlice, movNoZ!);
const nccZ = nccOf(tgtSlice, movZ!);
ok(nccZ > nccNoZ + 0.2, `z kayması örtüşmeyi düzeltir (NCC ${nccNoZ.toFixed(2)} → ${nccZ.toFixed(2)})`);
ok(nccZ > 0.95, `doğru kaymada kesit neredeyse birebir (NCC ${nccZ.toFixed(2)})`);

// ── füzyon katmanı z kaymasını uygular ve önbellek anahtarına katar ──
// Hareketli seride her kesit farklı parlaklıkta: z kayması hangi kesitin
// örneklendiğini değiştirir, dolayısıyla katman baytları da değişir.
const mk8 = (id: string, values: number[]): SeriesData => ({
  id, modality: "PET", description: id, bodyPart: "A", patientName: "T", patientId: "1", patientAge: "050Y", patientSex: "E",
  studyDate: "", institution: "", studyUid: "1.2.3", width: 8, height: 8, pixelSpacing: 1, pixelSpacingX: 1,
  sliceThickness: 3, sliceSpacing: 3, orientation: [1, 0, 0, 0, 1, 0], frameOfRef: "F1",
  ipp: values.map((_, j) => [0, 0, j * 3]),
  slices: values.map((v) => {
    const sl = new Float32Array(64);
    sl[27] = v;
    return sl;
  }),
  defaultWL: 0, defaultWW: 1, unit: "SUV",
} as SeriesData);
const tSmall = mk8("ts", [100, 100, 100, 100]);
const fSmall = mk8("fs", [100, 200, 300, 400]);
const layerBase = { series: fSmall, alpha: 1, cmap: "hot" as const, loPct: 10, hiPct: 100 };
const lit = (layer: Uint32Array | null, i: number) => (layer ? (layer[i] >>> 24) > 0 : false);
const l0 = buildFusionLayer(tSmall, 0, layerBase);
const lz = buildFusionLayer(tSmall, 0, { ...layerBase, zMm: 6 });
ok(!!l0 && lit(l0, 27), "z kaymasız katman kaynaktaki pikselde");
ok(!!lz && JSON.stringify([...l0!]) !== JSON.stringify([...lz]), "z kayması katmanı değiştirir (önbellek anahtarı ayrı)");
const lz0 = buildFusionLayer(tSmall, 0, { ...layerBase, zMm: 0 });
ok(JSON.stringify([...l0!]) === JSON.stringify([...lz0!]), "zMm=0 kimlik davranışı korur");

// ── not metni ──
ok(zShiftNote(est).includes("mm") && zShiftNote(est).includes("görsel doğrulama"), "kazanç notu mm ve doğrulama uyarısı verir");
ok(zShiftNote(estZero).includes("uygulanmadı"), "kazançsız not açık");

if (failed) { console.error(`${failed} z kayması testi başarısız`); process.exit(1); }
console.log("Tüm kesit (z) kayması testleri geçti.");

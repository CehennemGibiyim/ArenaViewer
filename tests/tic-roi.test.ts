/**
 * ROI tabanlı TIC testleri (v-fusion).
 *
 * Sentetik seriler: geometri (IPP/IOP/Frame of Reference), ROI eşleme,
 * zaman ekseni ve wash-out / plato / progresif sınıflaması.
 */
import type { Annotation, SeriesData } from "../src/lib/types";
import {
  analyzeRoiTic, buildTicPhases, phaseFor, roiGeometry, ticRoiCandidates, ticSummaryLine, type TicPhase,
} from "../src/lib/ticRoi";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

/** 8×8 kesit; `fill(x,y)` piksel değerini verir. N kesit, z aralığı `dz`. */
function mkSeries(id: string, opts: {
  fill?: (x: number, y: number, slice: number) => number;
  n?: number; dz?: number; z0?: number; frame?: string; time?: number | null;
  modality?: string; color?: boolean; special?: boolean; spacing?: number;
} = {}): SeriesData {
  const n = opts.n ?? 2;
  const dz = opts.dz ?? 2;
  const spacing = opts.spacing ?? 1;
  const fill = opts.fill ?? (() => 100);
  const slices = Array.from({ length: n }, (_, s) => {
    const a = new Float32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) a[y * 8 + x] = fill(x, y, s);
    return a;
  });
  return {
    id, modality: opts.modality ?? "MR", description: id, bodyPart: "HEAD",
    patientName: "T", patientId: "1", patientAge: "40", patientSex: "E",
    studyDate: "2026-01-01", institution: "", studyUid: "1.2.3",
    width: 8, height: 8, pixelSpacing: spacing, pixelSpacingX: spacing,
    sliceThickness: dz, sliceSpacing: dz,
    orientation: [1, 0, 0, 0, 1, 0], frameOfRef: opts.frame ?? "F1",
    ipp: Array.from({ length: n }, (_, i) => [0, 0, (opts.z0 ?? 0) + i * dz]),
    seriesTime: opts.time === undefined ? 3600 : opts.time,
    slices, lesions: [], tags: [], isSample: false,
    isColor: opts.color ?? false, specialType: opts.special ? "sr" : undefined,
    defaultWL: 0, defaultWW: 1, unit: "SI",
  } as SeriesData;
}

const rect: Annotation = { id: "a1", kind: "rect", slice: 0, points: [{ x: 2, y: 2 }, { x: 5, y: 5 }] };
const ellipse: Annotation = { id: "a2", kind: "ellipse", slice: 0, points: [{ x: 2, y: 2 }, { x: 6, y: 6 }] };
const polygon: Annotation = { id: "a3", kind: "polygon", slice: 0, points: [{ x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 6 }] };
const lengthAnn: Annotation = { id: "a4", kind: "length", slice: 0, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };

// ── ROI geometrisi ──
ok(!!roiGeometry(rect) && roiGeometry(rect)!.inside(3, 3), "dikdörtgen ROI geometrisi");
ok(roiGeometry(rect)!.box.x0 === 2 && roiGeometry(rect)!.box.x1 === 5, "ROI kutusu sınırları");
ok(!roiGeometry(ellipse)!.inside(2.1, 2.1) && roiGeometry(ellipse)!.inside(4, 4), "elips köşeleri dışlar, merkezi içerir");
ok(roiGeometry(polygon)!.inside(5, 2) && !roiGeometry(polygon)!.inside(2, 5), "poligon iç/dış testi");
ok(roiGeometry(lengthAnn) === null, "desteklenmeyen tür (uzunluk) ROI sayılmaz");
ok(ticRoiCandidates([rect, ellipse, polygon, lengthAnn], 0).length === 3, "kesitteki ROI adayları süzülür");
ok(ticRoiCandidates([rect], 3).length === 0, "başka kesitteki ROI listelenmez");

// ── faz üretimi ve kesit eşleme ──
const base = mkSeries("p", { fill: (x, y) => 10 + x, n: 3, dz: 2, time: 3600 });
const mid = mkSeries("m", { fill: () => 50, n: 3, dz: 2, time: 3660 });
const late = mkSeries("l", { fill: () => 30, n: 3, dz: 2, time: 3720 });
const p0 = phaseFor(base, 0, rect, base)!;
ok(p0.seriesId === "p" && p0.sliceIndex === 0, "birincil seri fazı");
ok(Math.abs(p0.mean - 13.5) < 1e-6, `ROI ortalaması (piksel merkezleri x=2..5 → 12,13,14,15 → 13.5; ölçülen ${p0.mean})`);
ok(p0.timeSec === 3600, "seri zamanı taşınır");
const pm = phaseFor(base, 0, rect, mid)!;
ok(pm.mean === 50 && pm.sliceIndex === 0, "diğer seride karşılık gelen kesit 0");
const lateMapped = phaseFor(base, 2, rect, mkSeries("l2", { fill: () => 30, n: 5, dz: 1, z0: 0, time: 3720 }));
ok(!!lateMapped && lateMapped.sliceIndex === 4, `farklı kesit aralığında konumla eşlenir (idx=${lateMapped?.sliceIndex})`);

const badFrame = mkSeries("x", { fill: () => 99, frame: "F2", time: 3780 });
ok(phaseFor(base, 0, rect, badFrame) === null, "farklı Frame of Reference dışlanır");
const colorSeries = mkSeries("c", { fill: () => 99, color: true });
ok(phaseFor(base, 0, rect, colorSeries) === null, "renkli seri dışlanır");
const special = mkSeries("s", { fill: () => 99, special: true });
ok(phaseFor(base, 0, rect, special) === null, "özel seri (SR/PR) dışlanır");
const skew = mkSeries("k", { fill: () => 99 });
skew.orientation = [1, 0, 0, 0, 0, 1];
ok(phaseFor(base, 0, rect, skew) === null, "paralel olmayan düzlem dışlanır");

// ── faz sıralaması ──
const phases = buildTicPhases(base, 0, rect, [late, mid, badFrame, colorSeries]);
ok(phases.length === 3, "uygun fazlar toplanır (geometri uymayanlar elenir)");
ok(phases.map((p) => p.seriesId).join(",") === "p,m,l", "zaman varsa fazlar zamana göre sıralanır");
const untimed = buildTicPhases(mkSeries("u0", { time: null, n: 2 }), 0, rect, [mkSeries("u1", { time: null, n: 2 }), mkSeries("u2", { time: null, n: 2 })]);
ok(untimed.length === 3 && untimed.every((p) => p.timeSec === null), "zaman etiketi yoksa fazlar zaman null taşır");

// ── analiz: wash-out / plato / progresif ──
const mk = (vals: number[], times: (number | null)[] | null, ids = ["a", "b", "c", "d", "e"]): TicPhase[] =>
  vals.map((v, i) => ({ seriesId: ids[i], label: `f${i}`, modality: "MR", sliceIndex: 0, mean: v, timeSec: times ? times[i] : null }));

const wo = analyzeRoiTic(mk([10, 50, 40, 30], [0, 60, 120, 180]));
ok(wo.axis === "sn" && wo.curve.pattern === "washout", `wash-out eğrisi (${wo.curve.pattern})`);
ok(Math.abs((wo.curve.washOutPct ?? 0) - 40) < 1e-6, `wash-out %40 (${wo.curve.washOutPct})`);
ok(wo.enhancementPct === 400, `zirveye artış %400 (${wo.enhancementPct})`);
ok(wo.values.length === 4 && wo.times[0] === 0 && wo.times[3] === 180, "zaman ekseni ilk fazdan itibaren saniye");

const plateau = analyzeRoiTic(mk([10, 50, 49, 47], [0, 60, 120, 180]));
ok(plateau.curve.pattern === "plateau", `plato eğrisi (%${plateau.curve.washOutPct?.toFixed(1)})`);
const prog = analyzeRoiTic(mk([10, 20, 30, 40], [0, 60, 120, 180]));
ok(prog.curve.pattern === "progressif", "progresif eğri");
const short2 = analyzeRoiTic(mk([10, 20], [0, 60]));
ok(short2.curve.pattern === "yetersiz" && short2.note.includes("3 faz"), "iki faz → yetersiz + uyarı");

const noTime = analyzeRoiTic(mk([10, 50, 30], null));
ok(noTime.axis === "faz" && noTime.curve.pattern === "yetersiz", "zaman yoksa sınıflama yapılmaz");
ok(noTime.curve.advice.includes("zaman"), "zaman eksikliği gerekçesi yazılır");
ok(noTime.times.join(",") === "0,1,2", "faz ekseni 0..n-1");

const mixed = analyzeRoiTic(mk([10, 50, 30], [0, null, 180]));
ok(mixed.axis === "faz", "karışık zaman (biri null) → faz ekseni");

const excl = analyzeRoiTic(mk([10, 50, 30], [0, 60, 120]), [mkSeries("z1"), mkSeries("z2")]);
ok(excl.excluded === 2, "analiz dışında kalan seri sayısı raporlanır");

// ── CSV ve özet satırı ──
ok(wo.csv.split("\n")[0] === "faz;seri;modalite;kesit;zaman_sn;ortalama", "CSV başlığı");
ok(wo.csv.split("\n").length === 5, "CSV satır sayısı (başlık + 4 faz)");
ok(wo.csv.includes("180") && wo.csv.includes("30.00"), "CSV zaman ve ortalama taşır");
const line = ticSummaryLine(wo);
ok(line.includes("Tip 3") && line.includes("wash-out") && line.includes("4 faz"), `özet satırı (${line})`);
ok(ticSummaryLine(plateau).includes("Tip 2") && ticSummaryLine(prog).includes("Tip 1"), "özet satırında tip adları");
ok(ticSummaryLine(noTime).includes("faz ekseni"), "özet satırı faz eksenini belirtir");

if (failed) { console.error(`${failed} TIC ROI testi başarısız`); process.exit(1); }
console.log("Tüm ROI tabanlı TIC testleri geçti.");

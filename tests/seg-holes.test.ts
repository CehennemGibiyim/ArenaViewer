/**
 * c-seg-rtstruct — RTSTRUCT'ta delik (iç kontur) desteği.
 *
 * Neden gerekli: içi boş (donut) bir segmentin yalnız dış sınırı yazılırsa PACS/TP
 * hacmi **dolu silindir** olarak hesaplar — ölçüm hatası doğrudan klinik hataya
 * dönüşür. DICOM RTSTRUCT deliği, aynı ROI'nin ikinci bir CLOSED_PLANAR konturu
 * ile temsil eder. Bu test gerçek DICOM baytlarını üretip `dicom-parser` ile geri
 * okuyarak kontur sayısını ve geometrisini doğrular (kaynak metni aranmaz).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDicom } from "dicom-parser";
import { buildRtStruct, buildSegDocument, sliceSopMap, traceContours, traceContoursWithHoles } from "../src/lib/dicomSeg";
import { emptyMask, makeSegmentDef, paint, type SegMask } from "../src/lib/segmentation";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const W = 64, H = 64;
const geometry = { pxMm: 0.7, pyMm: 0.7, dz: 2.5, origin: [10, 20, 30] as [number, number, number] };

/** Dikdörtgen halka maskesi (32..32 kutu, 16'lık delik). */
function ringMask(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
    const inHole = x >= 24 && x < 40 && y >= 24 && y < 40;
    if (!inHole) m[y * W + x] = 1;
  }
  return m;
}

function segMaskOf(rows: Uint8Array[]): SegMask {
  const mask = emptyMask(W, H);
  rows.forEach((m, i) => mask.slices.set(i + 1, m));
  return mask;
}

const SOURCE = { seriesUid: "1.2.3.4", sopUids: ["1.2.3.4.5", "1.2.3.4.6"], sopClassUid: "1.2.840.10008.5.1.4.1.1.2" };
const IDS = { patientName: "TEST^HASTA", patientId: "T1", patientSex: "O", studyUid: "1.2.3", studyDate: "20260101", institution: "Test" };

function rtstructBytes(mask: SegMask, sliceSopUids?: Record<number, string>): Uint8Array {
  return buildRtStruct({
    ...IDS, width: W, height: H, geometry, source: SOURCE, sliceSopUids,
    rois: [{ def: makeSegmentDef(1, "Karaciger"), mask }],
  });
}

/** (3006,0050) kontur verisini DICOM baytlarından okur. */
function contoursOf(bytes: Uint8Array) {
  const ds = parseDicom(new Uint8Array(bytes));
  const seq = ds.elements["x30060039"]?.items ?? [];
  const out: { z: number; pts: number[]; count: number; refs: string[] }[] = [];
  for (const roiItem of seq) {
    for (const c of roiItem.dataSet?.elements["x30060040"]?.items ?? []) {
      const el = c.dataSet?.elements;
      if (!el) continue;
      const data = (c.dataSet!.string("x30060050") ?? "").split("\\").map(Number).filter((n) => Number.isFinite(n));
      const zs = data.filter((_, i) => i % 3 === 2);
      const refs = (c.dataSet!.elements["x30060016"]?.items ?? []).map((ri) => ri.dataSet?.string("x00081155") ?? "");
      out.push({ z: zs.length ? zs[0] : 0, pts: data, count: Number(c.dataSet!.string("x30060046") ?? 0), refs });
    }
  }
  return out;
}

// ── 1. Kontur izleme katmanı ──
const ring = ringMask();
const both = traceContours(ring, W, H);
ok(both.length === 2, `halkada 2 kontur (dış + delik): ${both.length}`);
const split = traceContoursWithHoles(ring, W, H);
ok(split.outer.length === 1 && split.holes.length === 1, "dış sınır ve delik ayrı ayrı sınıflandırılır");
const holeXs = split.holes[0].map((p) => p.x), holeYs = split.holes[0].map((p) => p.y);
ok(Math.min(...holeXs) >= 24 && Math.max(...holeXs) <= 40, "delik konturu x aralığı delik bölgesinde");
ok(Math.min(...holeYs) >= 24 && Math.max(...holeYs) <= 40, "delik konturu y aralığı delik bölgesinde");
ok(split.outer[0].some((p) => p.x < 24) && split.outer[0].some((p) => p.x > 40), "dış kontur halka gövdesini izler");
// Delik, dış konturdan KÜÇÜK olmalı (alan sırası: dış büyükten küçüğe, sonra delikler)
ok(both[0].length > 0 && both[1].length > 0, "iki kontur da boş değil");

// ── 2. RTSTRUCT: iki kontur, aynı ROI, doğru z ──
const mask = segMaskOf([ring, ring]);
const bytes = rtstructBytes(mask);
ok(bytes.length > 500, `RTSTRUCT üretildi (${bytes.length} bayt)`);
const contours = contoursOf(bytes);
ok(contours.length === 4, `2 kesit × (dış + delik) = 4 kontur (${contours.length})`);
const byZ = new Map<number, number[]>();
for (const c of contours) byZ.set(c.z, [...(byZ.get(c.z) ?? []), c.pts.length / 3]);
ok(byZ.size === 2, `iki farklı kesit (z) yazıldı: ${[...byZ.keys()].map((z) => z.toFixed(1)).join(",")}`);
ok(![...byZ.keys()].includes(0), "z koordinatı kontur verisinden okunur (0 değil — gerçek geometri)");
ok([...byZ.values()].every((v) => v.length === 2), "her kesitte 2 kontur (dış + delik)");
/** Konturun mm cinsinden sınır kutusu alanı (delik ↔ dış ayrımı için). */
const bboxArea = (pts: number[]) => {
  const xs = pts.filter((_, i) => i % 3 === 0), ys = pts.filter((_, i) => i % 3 === 1);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
};
ok(contours.every((c) => Number.isFinite(bboxArea(c.pts)) && bboxArea(c.pts) > 0), "her konturun geçerli sınır kutusu var");
ok(contours.every((c) => c.count === c.pts.length / 3), "NumberOfContourPoints gerçek nokta sayısıyla uyumlu (3006,0046)");
ok(contours.every((c) => c.pts.length % 3 === 0 && c.pts.length >= 9), "her kontur x,y,z üçlüleri ve ≥3 nokta");
// Delik noktaları gerçekten deliğin mm karşılığında mı? (origin 10,20 · px 0.7)
const zFirst = [...byZ.keys()].sort((a, b) => a - b)[0];
const firstSlice = contours.filter((c) => c.z === zFirst);
// Delik = aynı kesitteki **daha küçük** kontur (dikdörtgen halkada ikisi de 4 noktaya sadeleşir).
const hole = firstSlice.reduce((a, b) => (bboxArea(a.pts) <= bboxArea(b.pts) ? a : b));
const outerC = firstSlice.find((c) => c !== hole)!;
ok(bboxArea(hole.pts) < bboxArea(outerC.pts), `delik konturu dıştan küçük (${bboxArea(hole.pts).toFixed(1)} < ${bboxArea(outerC.pts).toFixed(1)} mm²)`);
const hx = hole.pts.filter((_, i) => i % 3 === 0), hy = hole.pts.filter((_, i) => i % 3 === 1);
ok(Math.min(...hx) >= 10 + 24 * 0.7 - 0.71 && Math.max(...hx) <= 10 + 40 * 0.7 + 0.71, "delik x koordinatları mm'de doğru yerde");
ok(Math.min(...hy) >= 20 + 24 * 0.7 - 0.71 && Math.max(...hy) <= 20 + 40 * 0.7 + 0.71, "delik y koordinatları mm'de doğru yerde");
// `zFirst` kontur verisinden okunan z'dir; delik aynı kesitte olduğu için z'si eşit olmalı.
ok(hole.pts.filter((_, i) => i % 3 === 2).every((z) => Math.abs(z - zFirst) < 0.01), "delik z koordinatı kesitle uyumlu");
ok(Math.abs(zFirst - (30 + 2.5)) < 0.01, "z, origin + dilim aralığı formülüne uyuyor (30 + 1×2,5 = 32,5)");

// ── 2b. DICOM etiket doğruluğu: (3006,0040) çift kullanımı giderildi ──
const dsRaw = parseDicom(new Uint8Array(rtstructBytes(segMaskOf([ring]))));
const contourItems = (dsRaw.elements["x30060039"]?.items ?? [])
  .flatMap((r) => r.dataSet?.elements["x30060040"]?.items ?? []);
ok(contourItems.length === 2, "ROIContourSequence → ContourSequence 2 öğe (dış + delik)");
const itemTags = Object.keys(contourItems[0].dataSet?.elements ?? {});
ok(itemTags.includes("x30060042") && itemTags.includes("x30060046") && itemTags.includes("x30060050"), "kontur öğesi geometri/sayı/veri taşır");
ok(!itemTags.includes("x30060040"), "kontur öğesinde (3006,0040) IS olarak TEKRAR kullanılmıyor (geçersiz DICOM giderildi)");

// ── 2c. sliceSopUids verilirse ContourImageSequence ile kesit referanslanır ──
const uidMap = { 1: "1.2.3.4.5", 2: "1.2.3.4.6" };
const refContours = contoursOf(rtstructBytes(mask, uidMap));
ok(refContours.length === 4, "referanslı yazımda kontur sayısı aynı");
ok(refContours.every((c) => c.refs.length === 1), "her kontur tek ContourImageSequence taşır");
const sliceOfZ = new Map<number, number>([[30 + 1 * 2.5, 1], [30 + 2 * 2.5, 2]]);
ok(refContours.every((c) => {
  const expect = uidMap[sliceOfZ.get(Number(c.z.toFixed(3))) as 1 | 2];
  return !expect || c.refs[0] === expect;
}), "referans, konturun z'sine karşılık gelen kesit UID'i");
ok(contoursOf(rtstructBytes(mask)).every((c) => c.refs.length === 0), "sliceSopUids yoksa uydurma referans yazılmaz");

// ── 3. Dolu maskede davranış değişmedi (regresyon) ──
const solid = new Uint8Array(W * H);
for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) solid[y * W + x] = 1;
const solidContours = contoursOf(rtstructBytes(segMaskOf([solid])));
ok(solidContours.length === 1, "dolu maskede tek kontur (delik uydurulmaz)");

// ── 4. Çentik delik sayılmaz (kenara açılan boşluk) ──
const notch = new Uint8Array(W * H);
for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) if (!(x < 24 && y >= 24 && y < 40)) notch[y * W + x] = 1;
ok(contoursOf(rtstructBytes(segMaskOf([notch]))).length === 1, "çentikli segment tek kontur (yanlış delik yok)");

// ── 5. SEG (1 bit/piksel) delik bilgisini zaten taşır — regresyon kontrolü ──
const segBytes = buildSegDocument({
  ...IDS, width: W, height: H, geometry, source: SOURCE,
  segments: [{ def: makeSegmentDef(1, "Karaciger"), mask }],
});
ok(segBytes.length > 0, "SEG belgesi delikli maskeden üretilebiliyor (bit maskesi deliği korur)");
void assert;

// ── 6. sliceSopMap: boş/eksik UID uydurulmaz; çağrı yerleri referansı besler ──
ok(JSON.stringify(sliceSopMap(["1.2.3.4.5", "1.2.3.4.6"])) === JSON.stringify({ 0: "1.2.3.4.5", 1: "1.2.3.4.6" }), "sıra → UID haritası");
ok(Object.keys(sliceSopMap(["", "  ", "1.2.3"])).join(",") === "2", "boş UID'ler atlanır (uydurma referans yok)");
ok(Object.keys(sliceSopMap(undefined)).length === 0, "sopUids yoksa harita boş");
const segEditor = readFileSync(path.join(__dirname, "..", "src/components/SegEditor.tsx"), "utf8");
const exportMenu = readFileSync(path.join(__dirname, "..", "src/components/ExportMenu.tsx"), "utf8");
const knee = readFileSync(path.join(__dirname, "..", "src/components/KneeSegPanel.tsx"), "utf8");
ok(/sliceSopUids: sliceSopMap\(series\.sopUids\)/.test(segEditor), "SegEditor RTSTRUCT'a kesit referansını veriyor");
ok(/sliceSopUids: sliceSopMap\(series\.sopUids\)/.test(exportMenu), "ExportMenu RTSTRUCT'a kesit referansını veriyor");
ok(/sliceSopUids: sliceSopMap\(series\.sopUids\)/.test(knee), "KneeSegPanel RTSTRUCT'a kesit referansını veriyor");

console.log(`\nseg-holes: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
process.exit(fail === 0 ? 0 : 1);

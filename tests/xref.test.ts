/**
 * 3B imleç (v-xref) testleri.
 * Tıklanan noktanın hasta koordinatında, aynı Frame of Reference'i paylaşan
 * diğer panellerin en yakın kesidi güncellenmeli; farklı çerçeve/paralel olmayan
 * durumlar güvenli şekilde atlanmalı.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SeriesData } from "../src/lib/types";
import { planeOf, sliceIndexAtPoint, toPatient } from "../src/lib/planes";
import { jumpToPatient, registerPanel, unregisterPanel } from "../src/lib/panelRegistry";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function makeSeries(id: string, opts: { frame?: string; origin: [number, number, number]; spacing?: number; n?: number }): SeriesData {
  const sp = opts.spacing ?? 1;
  const n = opts.n ?? 5;
  return {
    id, modality: "CT", description: id, bodyPart: "HEAD", patientName: "T", patientId: "1", patientAge: "40", patientSex: "E",
    studyDate: "", institution: "", studyUid: "1.2.3", width: 8, height: 8, pixelSpacing: sp, sliceThickness: sp,
    orientation: [1, 0, 0, 0, 1, 0], frameOfRef: opts.frame,
    ipp: Array.from({ length: n }, (_, i) => [opts.origin[0], opts.origin[1], opts.origin[2] + i * sp]),
    slices: Array.from({ length: n }, () => new Float32Array(64).fill(100)),
    defaultWL: 0, defaultWW: 1, unit: "HU",
  } as SeriesData;
}

// ── sliceIndexAtPoint ──
const s1 = makeSeries("s1", { frame: "F1", origin: [0, 0, 0], spacing: 2, n: 5 }); // z = 0,2,4,6,8
ok(sliceIndexAtPoint(s1, [0, 0, 0]) === 0, "ilk kesit → 0");
ok(sliceIndexAtPoint(s1, [0, 0, 8]) === 4, "son kesit → 4");
ok(sliceIndexAtPoint(s1, [0, 0, 4.4]) === 2, "en yakın kesit (4.4 → idx 2)");
ok(sliceIndexAtPoint(s1, [0, 0, 3.9]) === 2, "eşik yukarı (3.9 → idx 2)");
ok(sliceIndexAtPoint(s1, [50, 0, 100]) === 4, "dışına taşan nokta son keside kenetlenir");
const noGeom = { ...s1, ipp: undefined };
ok(sliceIndexAtPoint(noGeom, [0, 0, 0]) === null, "geometri yoksa null");

// piksel merkezi ↔ hasta koordinatı tutarlılığı (fonksiyon: piksel i, [i,i+1) aralığı; u=i → merkez i−0.5)
const pl = planeOf(s1, 0)!;
const P = toPatient(pl, 4, 4);
ok(Math.abs(P[0] - 7) < 1e-6 && Math.abs(P[1] - 7) < 1e-6 && Math.abs(P[2]) < 1e-6, "görüntü (4,4) → 3.5 piksel × 2 mm/px = (7,7,0) hasta koordinatı");
ok(toPatient(pl, 4.5, 4.5)[2] === 0, "kesirli koordinat da düzlem içinde kalır");
ok(sliceIndexAtPoint(s1, toPatient(planeOf(s1, 3)!, 4, 4)) === 3, "tıklanan kesidin hasta noktası aynı seride aynı indeksi verir");

// ── jumpToPatient ──
const calls: { id: string; slice: number }[] = [];
const sA = makeSeries("A", { frame: "F1", origin: [0, 0, 0], spacing: 2, n: 5 });
const sB = makeSeries("B", { frame: "F1", origin: [100, 0, 10], spacing: 2, n: 5 }); // z = 10..18
const sC = makeSeries("C", { frame: "F2", origin: [0, 0, 0], spacing: 2, n: 5 });   // başka çalışma
registerPanel({ id: "main", series: sA, slice: 0, label: "A", setSlice: (n) => calls.push({ id: "main", slice: n }) });
registerPanel({ id: "ref1", series: sB, slice: 4, label: "B", setSlice: (n) => calls.push({ id: "ref1", slice: n }) });
registerPanel({ id: "ref2", series: sC, slice: 0, label: "C", setSlice: (n) => calls.push({ id: "ref2", slice: n }) });

const changed = jumpToPatient("main", [0, 0, 14]); // B'de z=14 → idx 2; C farklı çerçeve
ok(changed === 1, `yalnızca aynı çerçevedeki panel güncellendi (dönüş=${changed})`);
ok(calls.some((c) => c.id === "ref1" && c.slice === 2), "ref1 doğru keside (2)");
ok(!calls.some((c) => c.id === "ref2"), "farklı çerçeveli panel dokunulmadı");
ok(!calls.some((c) => c.id === "main"), "kaynak panel kendini tekrar güncellemedi");

// Gerçek uygulamada setSlice state'i değiştirir, panel yeniden kaydedilir; testte bunu taklit ederiz.
registerPanel({ id: "ref1", series: sB, slice: 2, label: "B", setSlice: (n) => calls.push({ id: "ref1", slice: n }) });
calls.length = 0;
jumpToPatient("main", [0, 0, 18]); // 18 → idx 4 (kayıtta 2)
ok(calls.some((c) => c.id === "ref1" && c.slice === 4), "yeni konuma taşıma yapıldı");
registerPanel({ id: "ref1", series: sB, slice: 4, label: "B", setSlice: (n) => calls.push({ id: "ref1", slice: n }) });
calls.length = 0;
jumpToPatient("main", [0, 0, 17.9]); // en yakın idx 4 → zaten orada
ok(calls.filter((c) => c.id === "ref1").length === 0, "zaten doğru kesideste ise çağrı yapılmaz");

// kaynak serisi yok / bilinmeyen panel: sessiz 0
ok(jumpToPatient("yok", [0, 0, 0]) === 0, "bilinmeyen kaynak → 0");
unregisterPanel("main");
ok(jumpToPatient("main", [0, 0, 0]) === 0, "serisi kayıtlı olmayan kaynak → 0");
for (const id of ["ref1", "ref2"]) unregisterPanel(id);

// paralel olmayan (farklı düzlem) serilerde de nokta bazlı atlama çalışır
// koronol seri: ipp y boyunca ilerler; normal [0,1,0]
const sD = makeSeries("D", { frame: "F3", origin: [0, 0, 0], spacing: 1, n: 10 });
sD.orientation = [1, 0, 0, 0, 0, -1];
sD.ipp = Array.from({ length: 10 }, (_, i) => [0, i, 0]);
const sP = makeSeries("P", { frame: "F3", origin: [0, 0, 0], spacing: 1, n: 10 });
calls.length = 0;
registerPanel({ id: "p", series: sP, slice: 5, label: "P", setSlice: (n) => calls.push({ id: "p", slice: n }) });
registerPanel({ id: "d", series: sD, slice: 0, label: "D", setSlice: (n) => calls.push({ id: "d", slice: n }) });
const ch2 = jumpToPatient("p", [0, 5.5, 0]);
ok(ch2 === 1 && calls.some((c) => c.id === "d" && (c.slice === 5 || c.slice === 6)), "farklı düzlemli seride de en yakın keside atlama");
ok(sliceIndexAtPoint(sD, [0, 5.5, 0]) !== null && sliceIndexAtPoint(sD, [0, 5.5, 0])! >= 5 && sliceIndexAtPoint(sD, [0, 5.5, 0])! <= 6, "koronol ipp ile en yakın kesit bulunuyor");
unregisterPanel("p"); unregisterPanel("d");

// ── arayüz / kod sözleşmesi ──
const root = path.resolve(__dirname, "..");
const types = readFileSync(path.join(root, "src/lib/types.ts"), "utf8");
ok(types.includes('"xref"'), "ToolName xref içeriyor");
const viewport = readFileSync(path.join(root, "src/components/Viewport.tsx"), "utf8");
ok(viewport.includes('tool === "xref"') && viewport.includes("jumpToPatient"), "Viewport tıklamayı 3B imlece yönlendiriyor");
ok(viewport.includes("setSlice:") && viewport.includes("sliceFn.current"), "panel kaydı kesit geri çağırma taşıyor");
const ws = readFileSync(path.join(root, "src/components/Workstation.tsx"), "utf8");
ok(ws.includes('id: "xref"') && ws.includes("İmleç"), "araç çubuğunda imleç aracı var");

if (failed) { console.error(`${failed} xref testi başarısız`); process.exit(1); }
console.log("Tüm 3B imleç testleri geçti.");

/**
 * Model belirsizlik bandı (a-uncert) testleri.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { BAND_LABEL, BAND_MARGIN, uncertaintyBand, uncertaintyNote } from "../src/lib/uncertainty";
import { cxrResultsToFindings, CXR_CLASSES, type CxrResult } from "../src/lib/cxrModel";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── bant sınırları ──
const t = 0.5;
ok(uncertaintyBand(t - 0.04, t) === "sinirda", "eşik−0,04 → sınırda");
ok(uncertaintyBand(t + 0.04, t) === "sinirda", "eşik+0,04 → sınırda");
ok(uncertaintyBand(t + BAND_MARGIN + 0.01, t) === "orta", "biraz üstte → orta");
ok(uncertaintyBand(t + 0.2 + 0.01, t) === "guclu", "çok üstte → güçlü");
ok(uncertaintyBand(0.99, 0.2) === "guclu", "fazla uzak → güçlü");
ok(uncertaintyBand(0.05, 0.5) === "orta", "uzak alt taraf da orta (eşiğin çok altı)");
ok(uncertaintyBand(Number.NaN, 0.5) === "sinirda", "NaN skor → en temkinli bant");
ok(uncertaintyBand(0.5, Number.NaN) === "sinirda", "NaN eşik → sınırda");

// ── not metni ──
const nSinir = uncertaintyNote("sinirda", 0.52, 0.5);
ok(nSinir.includes("SINIRDA") && nSinir.includes("emin değil"), `sınırda notu vurgulu (${nSinir.slice(0, 70)}…)`);
const nOrta = uncertaintyNote("orta", 0.6, 0.5);
console.log("not-orta:", nOrta);
ok(nOrta.includes("60%") && nOrta.includes("eşik 50%"), "orta notu yüzdeyi ve eşiği taşıyor");
const nGuclu = uncertaintyNote("guclu", 0.85, 0.3);
ok(nGuclu.includes("güçlü") || nGuclu.toLocaleLowerCase("tr-TR").includes("güçlü"), "güçlü notu vurgulu");
ok(BAND_LABEL.sinirda === "SINIRDA" && BAND_LABEL.guclu === "GÜÇLÜ", "etiketler Türkçe");

// ── CXR bulgusu taşıyor mu ──
function chest(): SeriesData {
  return {
    id: "c", modality: "CR", description: "Toraks", bodyPart: "TORAKS", patientName: "T", patientId: "1",
    patientAge: "50", patientSex: "E", studyDate: "", institution: "", studyUid: "1.2.3",
    width: 64, height: 64, pixelSpacing: 1, sliceThickness: 0, defaultWL: 128, defaultWW: 256,
    unit: "SI", slices: [new Float32Array(64 * 64)], lesions: [], tags: [], isSample: true,
  } as SeriesData;
}
const res: CxrResult = {
  scores: CXR_CLASSES.map((c, i) => ({ index: i, name: c.name, labelTr: c.labelTr, prob: i === 6 ? 0.37 : 0.05, threshold: c.threshold, positive: false })),
  top: { index: 6, name: "Pneumonia", prob: 0.51 }, heats: [], elapsedMs: 5, model: "Medical_X", imageSize: 320,
};
const f = cxrResultsToFindings(res, chest())[0];
ok(f.threshold === CXR_CLASSES[6].threshold, "bulguya sınıf eşiği taşınıyor");
ok(uncertaintyBand(f.confidence, f.threshold!) === "sinirda", "0,37 vs 0,36 → sınırda bandı bulguda tanınır");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const rp = readFileSync(path.join(root, "src/components/RightPanel.tsx"), "utf8");
ok(rp.includes('from "@/lib/uncertainty"'), "sağ panel belirsizlik modülünü kullanıyor");
ok(rp.includes("BAND_LABEL[") && rp.includes("uncertaintyNote("), "skor listesi ve bulgu kartı bandı/notu gösteriyor");
const cxm = readFileSync(path.join(root, "src/lib/cxrModel.ts"), "utf8");
ok(cxm.includes("threshold: c.threshold"), "CXR bulgusuna eşik kaydediliyor");

if (failed) { console.error(`${failed} belirsizlik testi başarısız`); process.exit(1); }
console.log("Tüm belirsizlik (a-uncert) testleri geçti.");

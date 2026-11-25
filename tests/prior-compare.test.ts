/**
 * Önceki tetkikle karşılaştırma (a-prior) testleri.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRIOR_COMPARE_NOTE, priorDelta, priorFinding } from "../src/lib/priorCompare";
import type { Finding, SavedReport } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1", sliceIndex: 3, sliceStart: 3, sliceEnd: 3, keySliceNumber: 4,
    sliceRangeStr: "K4", anatomicalLocation: "Sağ alt lob", densityOrSignal: "nodül",
    sizeMmStr: "8 mm", bbox: null, label: "Nodül adayı", detail: "", category: "AI Nodül",
    severity: "orta", confidence: 0.7, confidenceKind: "heuristic", source: "ai-model",
    metrics: { maxDiameterMm: 8 },
    ...over,
  };
}

const BASE_REPORT = {
  id: 1, studyId: 1, status: "onaylandi", version: 1, mode: "kapsamli",
  clinicalInfo: "", technique: "", findingsText: "", impression: "", recommendation: "",
  findingsJson: [], findingsApproval: {}, triageLevel: "dusuk", triageScore: 1,
  createdAt: "2026-03-12T10:00:00Z", updatedAt: "2026-03-12T10:00:00Z",
  contentHash: "", signatureMeta: "", institution: "",
  aiModel: "", engine: "", modelCard: "", approvedBy: "", doctorTitle: "", doctorRegNo: "",
  keyImageDataUrl: "", patientName: "TEST", patientId: "TR-1", patientAge: "50", patientSex: "E",
  studyDate: "20260312", approvedAt: null, studyUid: "1.2.3.4", modality: "BT", bodyPart: "TORAKS", seriesDescription: "Toraks BT",
} as const;

function report(over: Partial<SavedReport> = {}): SavedReport {
  return Object.assign({ ...BASE_REPORT }, over);
}

// ── eşleşme ──
ok(priorFinding(finding(), [report({ findingsJson: [finding({ metrics: { maxDiameterMm: 5 } })] })]) !== null, "aynı kategoriden nicelli bulgu eşleşir");
ok(priorFinding(finding(), [report({ findingsJson: [finding({ category: "Farklı", metrics: { maxDiameterMm: 5 } })] })]) === null, "kategori farklıysa eşleşmez");
ok(priorFinding(finding({ category: "Sistem" }), [report()]) === null, "Sistem bulgusu karşılaştırılmaz");
ok(priorFinding(finding({ metrics: undefined }), [report()]) === null, "ölçümsüz bulgu karşılaştırılmaz");
ok(priorFinding(finding(), [report({ findingsJson: [finding({ metrics: { maxDiameterMm: 5 }, source: "manual" as Finding["source"] })] })]) === null, "manuel kaynaklı ölçüm karşılaştırılmaz");

// ── delta metni ──
const d = priorDelta(finding({ metrics: { maxDiameterMm: 8 } }), [report({
  findingsJson: [finding({ metrics: { maxDiameterMm: 5 } })], createdAt: "2026-03-12T10:00:00Z",
})]);
ok(d !== null && d.includes("çap 5 → 8 mm (+3.0)"), `çap farkı doğru (${d})`);
ok(d!.includes(PRIOR_COMPARE_NOTE), "registration sınırı notu taşınıyor");
ok(d!.includes("Önceki (") && d!.length > 20, "tarih etiketi var");

const dv = priorDelta(finding({ metrics: { volumeMl: 12, maxDiameterMm: undefined } }), [report({
  findingsJson: [finding({ metrics: { volumeMl: 8, maxDiameterMm: undefined } })],
})]);
ok(dv !== null && dv.includes("hacim 8 → 12 mL (+50%)"), `hacim yüzdesi doğru (${dv})`);

const neg = priorDelta(finding({ metrics: { maxDiameterMm: 3 } }), [report({
  findingsJson: [finding({ metrics: { maxDiameterMm: 5 } })],
})]);
ok(neg !== null && neg.includes("(−2.0)") || (neg ?? "").includes("(-2.0)"), "azalma işaretli gösterilir");

ok(priorDelta(finding(), []) === null, "önceki rapor yoksa null");
ok(priorDelta(finding({ metrics: { meanHu: 3 } }), [report({ findingsJson: [finding({ metrics: { meanHu: 4 } })] })]) === null, "karşılaştırılan alan yoksa null");
// Sağ panel priors'ı yeniden eskiye sıralar; liste sıralı geldiğinde ilk eşleşme en yenidir.
const two = priorDelta(finding({ metrics: { maxDiameterMm: 9 } }), [
  report({ id: 3, createdAt: "2026-09-01T00:00:00Z", findingsJson: [finding({ metrics: { maxDiameterMm: 8 } })] }),
  report({ id: 2, createdAt: "2026-01-01T00:00:00Z", findingsJson: [finding({ metrics: { maxDiameterMm: 7 } })] }),
]);
ok(two !== null && two.includes("çap 8 → 9 mm (+1.0)"), "sıralı listede en YENİ kayıt seçilir");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const rp = readFileSync(path.join(root, "src/components/RightPanel.tsx"), "utf8");
ok(rp.includes('from "@/lib/priorCompare"'), "sağ panel paylaşılan modülü kullanıyor");
ok(!rp.includes("function priorDelta"), "panelde yerel kopya kalmadı");

if (failed) { console.error(`${failed} önceki tetkik testi başarısız`); process.exit(1); }
console.log("Tüm önceki tetkik karşılaştırma testleri geçti.");

/**
 * Gölge mod (shadow mode) saf fonksiyon testleri.
 * DB/HTTP katmanı ayrıdır; burada yalnızca karar ve dönüşüm mantığı doğrulanır.
 */
import {
  shadowModeEnabled,
  splitFindings,
  toShadowRecord,
  summarizeShadow,
  SHADOW_ENV,
} from "../src/lib/shadowMode";
import type { Finding } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function finding(over: Partial<Finding>): Finding {
  return {
    id: "f1", sliceIndex: 0, sliceStart: 0, sliceEnd: 0, keySliceNumber: 1, sliceRangeStr: "Kesit 1",
    anatomicalLocation: "—", densityOrSignal: "—", sizeMmStr: "—", bbox: null,
    label: "Aday", detail: "", category: "CXR AI", severity: "orta",
    confidence: 0.6, confidenceKind: "heuristic", source: "ai-model",
    ...over,
  };
}

// ── bayrak ──
delete process.env[SHADOW_ENV];
ok(shadowModeEnabled() === false, "varsayılan: gölge mod kapalı");
process.env[SHADOW_ENV] = "true";
ok(shadowModeEnabled() === true, "NEXT_PUBLIC_AI_SHADOW_MODE=true → açık");
process.env[SHADOW_ENV] = "1";
ok(shadowModeEnabled() === false, "yalnızca 'true' kabul edilir");
delete process.env[SHADOW_ENV];

// ── ayırma ──
const ai = [finding({ id: "cx1", source: "ai-model" }), finding({ id: "cx2", source: "ai-model", severity: "yuksek" })];
const manual = [finding({ id: "m1", source: "manual", category: "Ölçüm" })];
const roi = [finding({ id: "r1", source: "manual", category: "ROI" })];

const off = splitFindings([...ai, ...manual], false);
ok(off.hidden.length === 0 && off.report.length === 3, "kapalıyken hiçbir bulgu gizlenmez");

const on = splitFindings([...ai, ...manual, ...roi], true);
ok(on.hidden.length === 2 && on.hidden.every((f) => f.source === "ai-model"), "açıkken yalnızca ai-model bulgular gizlenir");
ok(on.report.length === 2 && on.report.every((f) => f.source !== "ai-model"), "manuel/ROI bulgular raporda kalır");

// ── kayıt dönüşümü ──
const rec = toShadowRecord("cxr-model", "Medical_X DenseNet121", "1.2.3", "CR", on.hidden);
ok(rec.findingCount === 2 && rec.findings.length === 2, "kayıt bulgu sayısı doğru");
ok(rec.findings[0].label === "Aday" && typeof rec.findings[0].confidence === "number", "kayıt alanları şemayla uyumlu");
ok(!JSON.stringify(rec).includes("detail") && !JSON.stringify(rec).includes("anatomicalLocation"),
  "kayıtta ayrıntılı klinik metin yok (hafif kayıt)");
ok(rec.studyUid === "1.2.3" && rec.modality === "CR", "kayıt bağlamı doğru");

// ── özet ──
const sum = summarizeShadow([
  { engine: "cxr-model", model: "Medical_X", finding_count: 2, createdAt: "2026-11-01T10:00:00Z" },
  { engine: "cxr-model", model: "Medical_X", finding_count: 1, createdAt: "2026-11-02T10:00:00Z" },
  { engine: "cv-heuristic", model: "MONAI", finding_count: 4, createdAt: "2026-10-01T10:00:00Z" },
]);
ok(sum.length === 2, "özet motor/model bazında gruplar");
ok(sum[0].engine === "cv-heuristic" && sum[0].count === 1 && sum[0].findings === 4, "sıralama: en çok bulgu üstte");
ok(sum[1].count === 2 && sum[1].findings === 3, "aynı anahtar birleştirilir");
ok(sum[1].firstAt === "2026-11-01T10:00:00.000Z" && sum[1].lastAt === "2026-11-02T10:00:00.000Z", "zaman aralığı doğru");
const empty = summarizeShadow([]);
ok(empty.length === 0, "boş kayıt → boş özet");

if (failed) { console.error(`${failed} gölge mod testi başarısız`); process.exit(1); }
console.log("Tüm gölge mod testleri geçti.");

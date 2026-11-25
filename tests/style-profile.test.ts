/**
 * Üslup örneği seçimi (r-genai) testleri.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildStyleInstruction, pickStyleSample, STYLE_SAMPLE_MAX, type StyleCandidate } from "../src/lib/styleProfile";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function rep(over: Partial<StyleCandidate> & { impression: string }): StyleCandidate {
  return { bodyPart: "TORAKS", modality: "BT", status: "onaylandi", ...over };
}

// ── temel seçim ──
ok(pickStyleSample([]) === null, "liste boşsa null");
ok(pickStyleSample([rep({ impression: "kısa" })]) === null, "çok kısa izlenim elenmez");
const longA = "Akciğer parankimlerinde aktif infiltrasyon veya nodül saptanmadı. Plevral effüzyon izlenmedi. Mediasten normal. ";
const out1 = pickStyleSample([rep({ impression: longA }), rep({ impression: longA.repeat(2) })]);
ok(out1 === longA.repeat(2).trim(), "en uzun örnek seçilir (sonu trim'lenir)");
ok(out1!.length <= STYLE_SAMPLE_MAX, "parça sınır aşmıyor");

// ── durum/bölge filtresi ──
ok(pickStyleSample([rep({ impression: longA, status: "taslak" })]) === null, "taslak rapor örnek alınmaz");
const regionPref = pickStyleSample([
  rep({ impression: longA, bodyPart: "BEYİN" }),
  rep({ impression: longA + "Ekstra bir cümle.", bodyPart: "TORAKS" }),
], { bodyPart: "TORAKS" });
ok(regionPref !== null && regionPref.includes("Ekstra"), "bölge tercihi öncelikli");

// ── üslup talimatı ──
const instr = buildStyleInstruction(longA);
ok(instr.includes("aynı hekimin") && instr.includes("kimlik"), "talimat üslubu/privacy notunu açıkça belirtiyor");

// ── entegrasyon iddiaları ──
const root = path.resolve(__dirname, "..");
const route = readFileSync(path.join(root, "src/app/api/reports/draft-impression/route.ts"), "utf8");
ok(route.includes("styleSample") && route.includes("buildStyleInstruction"), "taslak ucu üslup örneğini prompt'a ekliyor");
const modal = readFileSync(path.join(root, "src/components/ReportPrintModal.tsx"), "utf8");
ok(modal.includes('from "@/lib/styleProfile"') && modal.includes("priorReports.map"), "rapor penceresi örneği seçip gönderiyor");

if (failed) { console.error(`${failed} üslup profili testi başarısız`); process.exit(1); }
console.log("Tüm üslup profili (r-genai) testleri geçti.");

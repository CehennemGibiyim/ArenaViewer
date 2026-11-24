/** CEF denetim satırı biçimlendirme testi (DB'siz). */
import assert from "node:assert/strict";
import { cefLine } from "../src/lib/server/cef";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const base = { ts: "2026-11-24T12:00:00.000Z", username: "dr@test", action: "report.approve", entityType: "report", entityId: "42", details: "{}" };
const line = cefLine(base);
ok(line.startsWith("CEF:0|ArenaViewer|ATIK|1.0|report.approve|report|7|"), "CEF üstbilgi + şiddet (approve→7)");
ok(line.includes("rt="), "rt alanı var");
ok(line.includes("suser=dr@test") && line.includes("cs2=42 cs2Label=entityId"), "kullanıcı/varlık alanları");
ok(cefLine({ ...base, action: "report.save" }).includes("|4|"), "Sıradan eylem şiddeti 4");

// Kaçış: | ve \ ve yeni satır bozulmaz
const kacis = cefLine({ ...base, details: "a|b\\c\nd" });
ok(!kacis.includes("a|b") && kacis.includes("a\\|b\\\\c"), "CEF alan kaçışları (|, \\)");
ok(kacis.split("\n").length === 1, "CEF tek satır");

if (failed) { console.error(`${failed} CEF testi başarısız`); process.exit(1); }
console.log("Tüm CEF denetim testleri geçti.");

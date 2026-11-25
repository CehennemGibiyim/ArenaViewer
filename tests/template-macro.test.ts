/**
 * Şablon yer tutucuları / makro yardımcısı (r-template) testleri.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fillPlaceholders, placeholders, reportPlaceholders } from "../src/lib/templateMacro";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── bulma ──
ok(JSON.stringify(placeholders("Sol akciğerde [BOYUT] mm nodül; [HU] HU.")) === JSON.stringify(["BOYUT", "HU"]), "tutucular sıralı ve benzersiz");
ok(JSON.stringify(placeholders("[KONUM] [KONUM]")) === JSON.stringify(["KONUM"]), "tekrar eden tekilleşir");
ok(placeholders("").length === 0 && placeholders("normal metin").length === 0, "yoksa boş dizi");
ok(JSON.stringify(placeholders("değer [45] HU")) === JSON.stringify(["45"]), "sayısal etiket de tutucu");
ok(!placeholders("okunan [ x y z ] şey").includes(" x y z "), "içi boşluklu uzun alan da tanınır ama çevrilmez");
const r = { technique: "", findingsText: "A [KONUM] B", impression: "[KONUM] normal", recommendation: "" };
ok(JSON.stringify(reportPlaceholders(r)) === JSON.stringify(["KONUM"]), "rapor geneli tekilleştirme");

// ── doldurma ──
const filled = fillPlaceholders("Sağ alt lobda [BOYUT] mm, [HU] HU lezyon.", { BOYUT: "8", HU: "32" });
ok(filled === "Sağ alt lobda 8 mm, 32 HU lezyon.", `doldurma doğru (${filled})`);
ok(fillPlaceholders("[BOYUT] [KONUM]", { BOYUT: "" }) === "[BOYUT] [KONUM]", "boş değer tutucuyu bırakır");
ok(fillPlaceholders("[a] [b]", { a: "1", b: "2" }) === "1 2", "küçük harf etiketler de");
ok(fillPlaceholders("", {}) === "", "boş metin güvenli");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const m = readFileSync(path.join(root, "src/components/ReportPrintModal.tsx"), "utf8");
ok(m.includes('from "@/lib/templateMacro"') && m.includes("reportPlaceholders(report)"), "onay öncesi yer tutucu uyarısı entegre");
ok(m.includes("doldurulmamış şablon alanları"), "uyarı metni Türkçe ve anlamlı");
const tpl = readFileSync(path.join(root, "src/lib/templates.ts"), "utf8");
ok((tpl.match(/findings: "/g) ?? []).length >= 24, "hazır şablon tohumu korunuyor (≥24)");

if (failed) { console.error(`${failed} şablon makrosu testi başarısız`); process.exit(1); }
console.log("Tüm şablon makrosu (r-template) testleri geçti.");

/**
 * i-a11y: erişilebilirlik yardımcıları (WCAG kontrastı, tema sabitleri).
 *
 * Referans değerler WCAG 2.1 tanımından gelir: siyah/beyaz 21:1, #777/#fff
 * ≈4,48:1, eşikler 4,5 (AA normal), 3 (AA büyük/arayüz), 7 (AAA normal).
 */
import {
  AA_LARGE, AA_NORMAL, AAA_NORMAL, APP_BG, APP_BG_DEEP, HC_TOKENS, HIGH_CONTRAST_CLASS,
  HIGH_CONTRAST_STORAGE_KEY, SKIP_LINK_LABEL, UI_TOKENS, auditContrast, contrastRatio, hexToRgb,
  meetsAA, relativeLuminance, requiredRatio, wcagLevel,
} from "../src/lib/a11y";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// ── renk ayrıştırma ──
ok(hexToRgb("#fff")?.join(",") === "255,255,255", "#rgb kısa biçim");
ok(hexToRgb("#0b0f16")?.join(",") === "11,15,22", "#rrggbb");
ok(hexToRgb("0b0f16")?.join(",") === "11,15,22", "# olmadan da okunur");
ok(hexToRgb("#12345") === null && hexToRgb("zzz") === null && hexToRgb("") === null, "geçersiz renk null");

// ── parlaklık ve oran ──
ok(relativeLuminance("#000000") === 0 && relativeLuminance("#ffffff") === 1, "siyah 0, beyaz 1 parlaklık");
ok(near(contrastRatio("#000", "#fff"), 21), "siyah/beyaz 21:1");
ok(near(contrastRatio("#fff", "#000"), 21), "oran sıradan bağımsız");
ok(near(contrastRatio("#777", "#fff"), 4.48, 0.02), "#777 üzerinde beyaz ≈4,48 (WCAG örneği)");
ok(near(contrastRatio("#0b0f16", "#0b0f16"), 1), "aynı renk 1:1");
ok(Number.isNaN(contrastRatio("geçersiz", "#fff")), "geçersiz renkte NaN");
ok(Number.isNaN(relativeLuminance("nope")), "geçersiz parlaklık NaN");

// ── WCAG düzeyleri ──
ok(wcagLevel(7) === "AAA" && wcagLevel(4.5) === "AA" && wcagLevel(4.49) === "yetersiz", "normal metin eşikleri");
ok(wcagLevel(4.5, true) === "AAA" && wcagLevel(3, true) === "AA (büyük metin)" && wcagLevel(2.9, true) === "yetersiz", "büyük metin eşikleri");
ok(wcagLevel(Number.NaN) === "yetersiz" && wcagLevel(999) === "AAA", "NaN ve aşırı oran kırpılır");

ok(requiredRatio(12) === AA_NORMAL && requiredRatio(24) === AA_LARGE, "boyuta göre eşik");
ok(requiredRatio(19, true) === AA_LARGE && requiredRatio(18, true) === AA_NORMAL, "kalın metinde 18,66 px sınırı");
ok(meetsAA(AA_NORMAL, 14) && !meetsAA(4.4, 14) && meetsAA(3.2, 24), "meetsAA boyut duyarlı");
ok(AAA_NORMAL === 7, "AAA eşiği 7");

// ── arayüz paleti ──
const rows = auditContrast(UI_TOKENS);
ok(rows.length === UI_TOKENS.length, "tüm token çiftleri denetlenir");
ok(rows.every((r) => r.pass), `arayüz renkleri AA eşiğini geçer (en düşük ${Math.min(...rows.map((r) => r.ratio)).toFixed(2)}:1)`);
const label = rows.find((r) => r.name.includes("slate-500"))!;
ok(label.ratio > AA_LARGE && label.ratio < AA_NORMAL, "slate-500 etiket olarak 3:1'i geçer, normal metin 4,5 eşiğini geçmez → yüksek kontrast temaya ihtiyaç");
const main = rows.find((r) => r.name.includes("slate-200"))!;
ok(main.ratio > AAA_NORMAL, "ana metin AAA düzeyinde");
ok(contrastRatio("#e2e8f0", APP_BG_DEEP) > AA_NORMAL, "derin zemin üzerinde de AA");

// ── yüksek kontrast teması ──
ok(HIGH_CONTRAST_CLASS === "hc" && HIGH_CONTRAST_STORAGE_KEY === "atik-high-contrast", "tema sınıfı ve saklama anahtarı sabit");
ok(contrastRatio(HC_TOKENS.slate500, APP_BG) > AA_NORMAL, "yüksek kontrastta slate-500 → AA normal metin");
ok(contrastRatio(HC_TOKENS.slate400, APP_BG) > AAA_NORMAL, "yüksek kontrastta slate-400 → AAA");
ok(SKIP_LINK_LABEL === "İçeriğe geç", "içeriğe geç etiketi");

if (failed) { console.error(`${failed} erişilebilirlik testi başarısız`); process.exit(1); }
console.log("Tüm erişilebilirlik testleri geçti.");

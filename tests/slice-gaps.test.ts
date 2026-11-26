/**
 * Kesit aralığı denetimi testleri (f-series).
 *
 * Sözleşme: medyan aralığa göre düzensiz boşluklar eksik kesit olarak tahmin
 * edilir, aynı konumdaki kesitler yinelenen sayılır, düzenli seride uyarı
 * üretilmez ve konum yoksa/azsa sonuç null olur.
 */
import { analyzeSliceGaps, hasSliceProblem } from "../src/lib/sliceGaps";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const regular = (n: number, spacing = 2.5) => Array.from({ length: n }, (_, i) => i * spacing);

// ── 1. düzenli seri ──
const r = analyzeSliceGaps(regular(10))!;
ok(r !== null, "düzenli seride rapor üretilir");
ok(r.total === 10 && r.expected === 10, `beklenen kesit sayısı doğru (${r.total}/${r.expected})`);
ok(r.missing === 0 && r.duplicates === 0 && r.irregular === 0, "düzenli seride eksik/çift/düzensiz yok");
ok(!hasSliceProblem(r), "düzenli seride uyarı üretilmez");
ok(r.message.includes("aralık düzenli"), `düzenli seri mesajı (${r.message})`);
ok(r.spacing === 2.5, `medyan aralık korunur (${r.spacing})`);

// ── 2. eksik kesit ──
const withGap = [...regular(5), ...regular(4).map((x) => x + 2.5 * 5 + 2.5)]; // 6. adım atlanmış
const g = analyzeSliceGaps(withGap)!;
ok(g.missing === 1, `tek boşluk 1 eksik kesit olarak tahmin edilir (${g.missing})`);
ok(g.expected === 10, `beklenen 10 kesit (${g.expected})`);
ok(hasSliceProblem(g), "eksik kesitte uyarı üretilir");
ok(g.message.includes("eksik"), `mesajda 'eksik' yazar (${g.message})`);

// ── 3. iki katı boşluk ──
const doubleGap = [...regular(4), ...regular(4, 2.5).map((x) => x + 2.5 * 6)];
const d = analyzeSliceGaps(doubleGap)!;
ok(d.missing === 2, `iki katı boşluk 2 eksik kesit (${d.missing})`);

// ── 4. yinelenen kesit ──
const dup = [...regular(6), 10]; // 10 = 4. konum tekrar (positions: 0,2.5,5,7.5,10,12.5 + 10)
const du = analyzeSliceGaps(dup)!;
ok(du.duplicates === 1, `aynı konum yinelenen olarak sayılır (${du.duplicates})`);
ok(du.total === 7, "yinelenen kesit toplamdan düşülmez (uyarı verilir)");
ok(hasSliceProblem(du), "yinelenen kesitte uyarı üretilir");

// ── 5. sınır durumlar ──
ok(analyzeSliceGaps([]) === null, "boş liste → null");
ok(analyzeSliceGaps([1, 2]) === null, "iki kesit → null (istatistik için yetersiz)");
ok(analyzeSliceGaps([5, 5, 5]) === null, "tümü aynı konum → null (aralık yok)");
ok(analyzeSliceGaps([NaN, Infinity, 0, 2, 4])?.total === 3, "sayısal olmayan konumlar atılır");
ok(analyzeSliceGaps(regular(5).reverse())?.missing === 0, "sıra önemsizdir (ters liste de düzenli)");

// ── 6. eşik davranışı ──
const slightly = [0, 2.5, 5.2, 7.5, 10]; // küçük sapma
ok(analyzeSliceGaps(slightly)!.irregular === 0, "küçük sapma (tolerans içinde) düzensiz sayılmaz");
ok(analyzeSliceGaps(slightly, 0.001)!.irregular >= 1, "tolerans daraltılınca sapma yakalanır");

if (failed) { console.error(`${failed} kesit aralığı testi başarısız`); process.exit(1); }
console.log("Kesit aralığı testleri geçti.");

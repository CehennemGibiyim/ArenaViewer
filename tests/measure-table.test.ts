/**
 * Ölçüm metni → sütunlu tablo testleri (r-struct).
 *
 * Sözleşme: "Kesit N · Tür: değer · ayrıntı" satırları kesit/tür/değer/ayrıntı olarak
 * ayrıştırılır; ayrıştırılamayan satır kaybolmaz (raw olarak tabloya düşer), sayı
 * biçimi (ondalık virgül/nokta) değiştirilmez.
 */
import { measureSummary, measureSummaryText, parseMeasureLine, parseMeasurements } from "../src/lib/measureTable";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── 1. tek satır ──
const len = parseMeasureLine("Kesit 12 · Uzunluk: 34.5 mm")!;
ok(len.slice === 12, "kesit numarası okunur");
ok(len.kind === "Uzunluk", `tür okunur (${len.kind})`);
ok(len.value === "34.5 mm", `değer okunur (${len.value})`);
ok(len.detail === "", "ayrıntı boş");
ok(len.raw === "Kesit 12 · Uzunluk: 34.5 mm", "özgün satır korunur");

const roi = parseMeasureLine("Kesit 5 · Dikdörtgen ROI: A 1234.5 mm² · ç 150.2 mm · ort 42±8 HU · min/maks 10/90")!;
ok(roi.slice === 5 && roi.kind === "Dikdörtgen ROI", "ROI türü okunur");
ok(roi.value === "A 1234.5 mm²", `ilk değer birincil (${roi.value})`);
ok(roi.detail.startsWith("ç 150.2 mm"), "ayrıntı ikinci parçadan başlar");
ok(roi.detail.includes("min/maks 10/90"), "tüm ayrıntı korunur");

const ellipse = parseMeasureLine("Kesit 3 · Elips ROI: A 78.5 mm² · ç 31.4 mm · ort 35±12 HU · SUVort 4.20 · SUVmaks 6.10")!;
ok(ellipse.detail.includes("SUVmaks 6.10"), "SUV ayrıntısı tabloya taşınır");

// ── 2. biçim varyantları ──
ok(parseMeasureLine("Kesit 7 · Açı: 45.0°")!.kind === "Açı", "açı ölçümü");
ok(parseMeasureLine("kesit 2 · Cobb açısı: Cobb 12.5°")!.slice === 2, "küçük harf 'kesit' kabul edilir");
ok(parseMeasureLine("Kesit 9 - Uzunluk: 5,5 mm")!.value === "5,5 mm", "ondalık virgül korunur");
const noColon = parseMeasureLine("Kesit 4 · Uzunluk 22.1 mm")!;
ok(noColon.kind === "Uzunluk" && noColon.value === "22.1 mm", "iki nokta olmadan da tür/değer ayrılır");
const free = parseMeasureLine("Hastaya ölçüm açıklandı")!;
ok(free.slice === null && free.kind === "" && free.value === "Hastaya ölçüm açıklandı", "serbest satır kaybolmaz (raw/değer)");
const noSlice = parseMeasureLine("Uzunluk: 12 mm")!;
ok(noSlice.slice === null && noSlice.kind === "Uzunluk", "kesitsiz ölçüm satırı ayrışır (kesit null)");
ok(parseMeasureLine("   ") === null, "boş satır null");

// ── 3. çok satır ve özet ──
const text = [
  "Kesit 12 · Uzunluk: 34.5 mm",
  "",
  "Kesit 12 · Açı: 45.0°",
  "Kesit 5 · Dikdörtgen ROI: A 1234.5 mm² · ort 42±8 HU",
  "Kesit 5 · Elips ROI: A 78.5 mm² · ort 35±12 HU",
  "Kesit 5 · Dikdörtgen ROI: A 200.0 mm²",
  "serbest not",
].join("\n");
const rows = parseMeasurements(text);
ok(rows.length === 6, `boş satır atlanır, 6 satır kalır (${rows.length})`);
const sum = measureSummary(rows);
ok(sum.rows === 6, "özet satır sayısı");
ok(sum.slices === 2, `farklı kesit 2 (${sum.slices})`);
ok(sum.kinds[0].count === 2 && (sum.kinds[0].kind === "Dikdörtgen ROI"), `en sık tür Dikdörtgen ROI ×2 (${sum.kinds[0].kind} ${sum.kinds[0].count})`);
ok(sum.kinds.some((k) => k.kind === "—" && k.count === 1), "türsüz satır '—' olarak sayılır");
const stext = measureSummaryText(sum);
ok(stext.startsWith("6 ölçüm · 2 kesit · "), `özet metni biçimli (${stext})`);
ok(stext.includes("Dikdörtgen ROI 2"), "özet tür adedini içerir");
ok(measureSummaryText(measureSummary([])) === "Ölçüm yok", "boş ölçümde 'Ölçüm yok'");
ok(parseMeasurements("").length === 0, "boş metin → satır yok");
ok(parseMeasurements("Kesit 1 · Uzunluk: 1 mm\nKesit 1 · Uzunluk: 2 mm").length === 2, "aynı kesitte iki ölçüm ayrı satır kalır");

if (failed) { console.error(`${failed} ölçüm tablosu testi başarısız`); process.exit(1); }
console.log("Ölçüm tablosu testleri geçti.");

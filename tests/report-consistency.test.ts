/**
 * Rapor metni ↔ ölçüm tutarlılığı (yeni fikir) — kural tabanlı eşleştirme testleri.
 * Sentetik metinlerdir; hasta verisi yoktur.
 */
import { parseUnitNumbers, withinTolerance, checkReportConsistency } from "../src/lib/reportConsistency";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── parseUnitNumbers ──
const t1 = parseUnitNumbers("Sol üst lobda 23 mm nodül; 450 HU iken zeminde -40 HU. Toplam 3.5 cm kitle, 145 mL.");
ok(t1.length === 5, `5 ölçü bulunur (${t1.length})`);
ok(t1.some((x) => x.cls === "length" && Math.abs(x.value - 35) < 1e-9), "3.5 cm → 35 mm normalize edilir");
ok(t1.some((x) => x.raw.includes("-40") || x.value === -40), "negatif HU okunur");
const comma = parseUnitNumbers("Kesit 12'de 34,5 mm ölçüldü.");
ok(comma.length === 1 && Math.abs(comma[0].value - 34.5) < 1e-9, "ondalık virgül desteklenir");
ok(parseUnitNumbers("Alan 25 mm² olan plak, 12 mm yükseklikte; basınç 120 mmHg").length === 1, "mm² ve mmHg uzunluk sayılmaz (yalnız 12 mm)");
ok(parseUnitNumbers("Hacim 245 mm³").length === 0, "mm³ hacim sayılmaz");
ok(parseUnitNumbers("").length === 0 && parseUnitNumbers("Ölçü yok").length === 0, "boş/ölçüsüz metin sıfır döner");

// ── withinTolerance ──
ok(withinTolerance(23, 24.5, "length"), "uzunluk toleransı %15/2 mm içinde");
ok(!withinTolerance(23, 30, "length"), "uzunluk dışında kalanlar eşleşmez");
ok(withinTolerance(420, 435, "hu") && !withinTolerance(420, 500, "hu"), "HU toleransı ±20");
ok(withinTolerance(145, 160, "ml") && !withinTolerance(145, 200, "ml"), "mL toleransı %15");

// ── checkReportConsistency ──
const meas = [
  "Kesit 12 · Uzunluk: 34.5 mm",
  "Kesit 5 · Dikdörtgen ROI: A 850 mm² · ort 42±8 HU · min/maks 10/90",
].join("\n");
const perfect = checkReportConsistency("Sol üst lobda 34 mm nodül; dansite 42 HU.", meas);
ok(perfect.textCount === 2 && perfect.matched === 2 && perfect.unmatchedText.length === 0, `metindeki ölçüler eşleşir (${perfect.note})`);
ok(perfect.unmatchedMeasurements.length === 0, "tüm ölçümler metinde geçiyor");

const hallucinated = checkReportConsistency("Sol üst lobda 99 mm nodül izleniyor; takip önerilir.", meas);
ok(hallucinated.unmatchedText.some((x) => x.value === 99), "metindeki uydurma/karşılıksız ölçü yakalanır");
ok(hallucinated.unmatchedMeasurements.length === 2, "eşleşmeyen ölçümler de listelenir");

const partial = checkReportConsistency("Nodül 34 mm; çevresel buzlu cam alanında 5 mm kalınlık artışı. Dansite için örnek 42 HU.", meas);
ok(partial.matched === 2 && partial.unmatchedText.some((x) => x.value === 5), `kısmi eşleşme: yalnız 5 mm karşılıksız (${partial.note})`);

const noMeas = checkReportConsistency("Nodül 12 mm ve 8 mm.", "");
ok(noMeas.matched === 0 && noMeas.unmatchedText.length === 2 && noMeas.unmatchedMeasurements.length === 0, "ölçüm bölümü yoksa tüm metin ölçüleri karşılıksız");

const empty = checkReportConsistency("Bulgu yok.", "Kesit 1 · Uzunluk: 10.0 mm");
ok(empty.unmatchedMeasurements.length === 1, "metinde hiç ölçü yoksa ölçüm metinde geçmiyor listelenir");

if (failed) { console.error(`${failed} tutarlılık testi başarısız`); process.exit(1); }
console.log("Tüm tutarlılık testleri geçti.");

/**
 * c-measure-history: sunucu ölçüm geçmişinin saf mantığı.
 *
 * Kapsam: lezyon kimliği, seri kurulumu (tarih sırası, aynı gün tekrarı,
 * bozuk satırlar), Δ mm/%/HU, gün aralığı, SVG trend noktaları, CSV ve özet metni.
 */
import {
  buildSeries, historyCsv, historyRows, seriesKey, seriesSummary, sparkPoints,
  type MeasurementRecord,
} from "../src/lib/measureHistory";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.log(`FAIL ${msg}`); }
};

const rec = (o: Partial<MeasurementRecord> & { studyDate: string; longMm: number }): MeasurementRecord => ({
  patientId: "P1", patientName: "TEST", label: "Nodül 1", anatomy: "sağ üst lob", kind: "solid", ...o,
});

// ── kimlik ──
ok(seriesKey({ label: "Nodül 1", anatomy: "Sağ Üst Lob" }) === seriesKey({ label: " nodül 1 ", anatomy: "sağ üst lob " }),
  "lezyon kimliği büyük/küçük harf ve boşluğa duyarsız");
ok(seriesKey({ label: "Nodül 1", anatomy: "sağ üst lob" }) !== seriesKey({ label: "Nodül 1", anatomy: "sağ alt lob" }),
  "farklı bölge ayrı seri");

// ── seri kurulumu ──
const records: MeasurementRecord[] = [
  rec({ studyDate: "2026-07-10", longMm: 9, hu: 30 }),
  rec({ studyDate: "2026-01-10", longMm: 6, hu: 20 }),
  rec({ studyDate: "2026-04-01", longMm: 7 }),
  rec({ studyDate: "2026-07-10", longMm: 9.5, hu: 35 }), // aynı gün düzeltme → son kazanır
  rec({ label: "Nodül 2", anatomy: "sol alt lob", studyDate: "2026-01-10", longMm: 20 }),
  rec({ label: "Nodül 2", anatomy: "sol alt lob", studyDate: "2026-07-10", longMm: 22 }),
];
const series = buildSeries(records);
ok(series.length === 2, "iki lezyon → iki seri");
ok(series[0].label === "Nodül 2", "seriler son çapa göre büyükten küçüğe");

const s1 = series.find((s) => s.label === "Nodül 1")!;
ok(s1.points.length === 3, "aynı gün gelen ölçüm mükerrer nokta üretmez");
ok(s1.points.map((p) => p.date).join(",") === "2026-01-10,2026-04-01,2026-07-10", "noktalar tarih sırasında");
ok(s1.points[2].longMm === 9.5 && s1.points[2].hu === 35, "aynı günün son ölçümü geçerli");
ok(s1.deltaMm === 3.5, "Δ mm ilk–son (3,5)");
ok(s1.pctChange === 58, "yüzde değişim (+%58)");
ok(s1.huDelta === 15, "HU değişimi (+15)");
ok(s1.spanDays === 181, "gün aralığı 181");

// ── tek nokta / bozuk satır ──
const one = buildSeries([rec({ studyDate: "2026-02-02", longMm: 5 })]);
ok(one.length === 1 && one[0].deltaMm === null && one[0].spanDays === null, "tek ölçümde Δ bilinmiyor");

const bad = buildSeries([
  rec({ studyDate: "", longMm: 5 }),
  rec({ studyDate: "2026-13-01", longMm: 5 }),
  rec({ studyDate: "2026-03-03", longMm: 0 }),
  rec({ studyDate: "2026-03-04", longMm: Number.NaN }),
  rec({ studyDate: "2026-03-05", longMm: 4, hu: Number.NaN }),
]);
ok(bad.length === 1 && bad[0].points.length === 1, "geçersiz tarih/çap atılır, geçerli kalan korunur");
ok(bad[0].points[0].hu === null, "NaN HU null'a çevrilir");

// ── trend noktaları ──
ok(sparkPoints([]) === "" && sparkPoints([{ date: "2026-01-01", longMm: 5, hu: null, suv: null }]) === "",
  "birden az noktada trend çizgisi yok");
const flat = sparkPoints([
  { date: "2026-01-01", longMm: 5, hu: null, suv: null },
  { date: "2026-06-01", longMm: 5, hu: null, suv: null },
], 120, 28);
ok(flat.split(" ").every((p) => {
  const [, y] = p.split(",").map(Number);
  return Math.abs(y - 14) < 0.6;
}), "sabit çaplarda çizgi yatay ortada");
const pts = sparkPoints([
  { date: "2026-01-01", longMm: 5, hu: null, suv: null },
  { date: "2026-06-01", longMm: 25, hu: null, suv: null },
], 120, 28, 2);
const coords = pts.split(" ").map((p) => p.split(",").map(Number));
ok(coords.length === 2, "iki nokta üretilir");
ok(coords.every(([x, y]) => x >= 2 && x <= 118 && y >= 2 && y <= 26), "noktalar kutu içinde");
ok(coords[1][0] > coords[0][0], "zaman soldan sağa");
ok(coords[1][1] < coords[0][1], "büyüyen çap yukarı gider");

// ── CSV ──
const csv = historyCsv([s1]);
const lines = csv.split("\n");
ok(lines[0] === "Lezyon;Bölge;Tip;Tarih;Çap (mm);HU;SUV", "CSV başlığı");
ok(lines.length === 4, "başlık + 3 ölçüm satırı");
ok(lines[1].startsWith("Nodül 1;sağ üst lob;solid;2026-01-10;6.0;20;"), "CSV satırı alanları ve biçimi");
ok(historyRows([s1]).length === 3, "tablo satırları CSV ile aynı sayıda");
const quoted = historyCsv(buildSeries([rec({ label: 'Nodül "A"; büyük', anatomy: "", studyDate: "2026-05-05", longMm: 3 })]));
ok(quoted.includes('"Nodül ""A""; büyük"'), "özel karakterler tırnaklanır");

// ── özet metni ──
const sum = seriesSummary(s1);
ok(sum.includes("Nodül 1 · sağ üst lob") && sum.includes("9.5 mm") && sum.includes("+3.5 mm") && sum.includes("3 ölçüm"),
  "özet metni lezyon, son çap, Δ ve ölçüm sayısını içerir");
ok(seriesSummary(one[0]).includes("ölçüm"), "tek ölçümlü seri özeti çökmez");

if (failed) { console.error(`${failed} ölçüm geçmişi testi başarısız`); process.exit(1); }
console.log("Tüm ölçüm geçmişi testleri geçti.");

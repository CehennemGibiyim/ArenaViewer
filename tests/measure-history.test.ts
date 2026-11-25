/**
 * c-measure-history: ölçüm geçmişi dönüşümü + trend matematiği.
 * Veritabanı gerektirmez: saf dönüşüm ve zaman serisi sınanır; API/DB
 * entegrasyonu PostgreSQL'li ortamda `npm run test:review` ile birlikte koşar.
 */
import { buildTrends, measurementsToRows, sparkline, trendSummary, type HistoryRow } from "../src/lib/measureHistory";
import type { Annotation, SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const series = {
  id: "S1", patientId: "P-1", patientName: "Test^Hasta", studyUid: "1.2.3", studyDate: "2026-01-05T09:00:00", modality: "CT",
} as unknown as SeriesData;

const length: Annotation = { id: "a1", kind: "length", slice: 3, points: [{ x: 0, y: 0 }, { x: 30, y: 40 }] };
const ellipsoid: Annotation = { id: "a2", kind: "ellipsoid", slice: 4, points: [{ x: 0, y: 0 }, { x: 20, y: 10 }], text: "3" };
const poly: Annotation = { id: "a3", kind: "polygon", slice: 5, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
const roi: Annotation = { id: "a4", kind: "ellipse", slice: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], stats: { mean: 42.5, std: 3, min: 30, max: 60, pixelCount: 78 } };
const zero: Annotation = { id: "a5", kind: "length", slice: 0, points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] };

const rows = measurementsToRows({ annotations: [length, ellipsoid, poly, roi, zero], series, pxMm: 0.5, labels: { a1: "Nodül A" } });
ok(rows.length === 5, "geçerli ölçümler satıra çevrildi, sıfır uzunluk atlandı");
const lenRow = rows.find((r) => r.label.startsWith("Uzunluk"))!;
ok(!!lenRow && near(lenRow.value, 25, 1e-9) && lenRow.unit === "mm", "uzunluk piksel → mm (50 px × 0,5 = 25 mm)");
ok(lenRow.label.includes("Nodül A"), "kullanıcı etiketi ölçüm adına ekleniyor");
ok(lenRow.patientId === "P-1" && lenRow.studyDate === "2026-01-05" && lenRow.seriesKey === "S1", "hasta/çalışma/seri kimliği taşınıyor");

const volRow = rows.find((r) => r.unit === "mL")!;
ok(!!volRow && near(volRow.value, (Math.PI / 6) * 10 * 5 * 3 / 1000, 1e-9), "elipsoid hacmi mm→mL (π/6·d1·d2·d3)");
const areaRow = rows.find((r) => r.label.startsWith("Çokgen"))!;
// Üçgen (0,0)-(10,0)-(10,10): piksel alanı 50, mm² = 50 × 0,5² = 12,5
ok(!!areaRow && near(areaRow.value, 12.5, 1e-9) && areaRow.unit === "mm2", "çokgen alanı mm² (50 px² × 0,25)");
const huRow = rows.find((r) => r.unit === "HU")!;
ok(!!huRow && near(huRow.value, 42.5), "ROI ortalama HU yazılıyor");

const petRows = measurementsToRows({ annotations: [roi], series, pxMm: 1, suvFactor: 2.5 });
ok(petRows.length === 2 && petRows.some((r) => r.unit === "SUV" && near(r.value, 106.25)), "PET'te ortalama SUV yazılıyor (HU yazılmaz)");
const noPatient = measurementsToRows({ annotations: [length], series: { ...series, patientId: "  " } as SeriesData, pxMm: 1 });
ok(noPatient.length === 0, "hasta kimliği yoksa geçmiş satırı üretilmez");

// ── trend ──
const mk = (studyDate: string, value: number, label = "Nodül A", unit: HistoryRow["unit"] = "mm"): HistoryRow =>
  ({ patientId: "P-1", studyUid: studyDate, studyDate, seriesKey: "S1", modality: "CT", label, kind: "length", value, unit, slice: 1 });

const t = buildTrends([mk("2026-03-01", 40), mk("2026-01-01", 10), mk("2026-02-01", 20)]);
ok(t.length === 1 && t[0].points.map((p) => p.value).join(",") === "10,20,40", "trend tarihe göre sıralanıyor");
ok(near(t[0].changePct!, 300, 1e-9), "ilk ölçüme göre yüzde değişim %300");
ok(t[0].direction === "artis", "belirgin artış yönü 'artis'");
ok(t[0].doublingDays === 30, "ikilenme süresi 10→40 (59 gün) ≈ 30 gün");
ok(t[0].points[1].deltaPct === 100 && t[0].points[2].deltaPct === 100, "nokta bazlı yüzde değişim önceki ölçüme göre");

const stable = buildTrends([mk("2026-01-01", 100), mk("2026-02-01", 103)]);
ok(stable[0].direction === "stabil" && stable[0].doublingDays === null, "%5 altı oynama stabil; ikilenme hesaplanmaz");
const down = buildTrends([mk("2026-01-01", 100), mk("2026-04-01", 50)]);
ok(down[0].direction === "azalma" && down[0].doublingDays === null, "azalma yönü doğru, ikilenme yok");

const blank = buildTrends([mk("", 7), mk("2026-01-01", 5)]);
ok(blank[0].points[1].studyDate === "" && blank[0].points[0].value === 5, "tarihsiz ölçüm sona atılıyor");
const filtered = buildTrends([mk("2026-01-01", 0), mk("2026-01-02", -3)]);
ok(filtered.length === 0, "sıfır/negatif değerler trende girmez (uydurma sıçrama yok)");
const multi = buildTrends([mk("2026-01-01", 10, "Nodül A"), mk("2026-01-01", 2, "Nodül B")]);
ok(multi.length === 2, "farklı etiketler ayrı seri");

ok(sparkline([]).length === 0 && sparkline([{ value: 5, studyDate: "", studyUid: "", deltaAbs: null, deltaPct: null }]).startsWith("60.0"), "tek nokta grafiği ortalanıyor");
const poly5 = sparkline([1, 2, 3, 4, 5].map((v, i) => ({ value: v, studyDate: `2026-01-0${i + 1}`, studyUid: "u", deltaAbs: null, deltaPct: null })));
ok(poly5.split(" ").length === 5 && poly5.split(" ").every((p) => { const [x, y] = p.split(",").map(Number); return x >= 0 && x <= 120 && y >= 0 && y <= 28; }), "grafik noktaları tuval içinde");
ok(trendSummary(t[0]).includes("%+300") && trendSummary(t[0]).includes("ikilenme"), "özet metni yüzde ve ikilenme süresini taşıyor");

if (failed) { console.error(`${failed} ölçüm geçmişi testi başarısız`); process.exit(1); }
console.log("Tüm ölçüm geçmişi (c-measure-history) testleri geçti.");

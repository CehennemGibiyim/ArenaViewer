/** İş akışı istatistikleri (F4) testleri. */
import {
  formatHours, percentile, summarizeStats, tatAlerts, tatTarget, turnaroundHours, weekStartOf,
  weeklyTrend, type ReportStatRow,
} from "../src/lib/workflowStats";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const NOW = new Date("2026-01-15T12:00:00Z");
const at = (iso: string) => new Date(iso).toISOString();

ok(turnaroundHours(at("2026-01-15T10:00:00Z"), at("2026-01-15T14:00:00Z")) === 4, "TAT saat farkı");
ok(turnaroundHours(null, at("2026-01-15T14:00:00Z")) === null, "Eksik oluşturulma → null");
ok(turnaroundHours(at("2026-01-15T14:00:00Z"), at("2026-01-15T10:00:00Z")) === null, "Negatif TAT dışlanır");
ok(percentile([1, 2, 3, 4, 5], 90) === 5, "p90 üst kuşak");
ok(formatHours(null) === "—" && formatHours(4.5).includes("sa"), "Biçimlendirme");

const rows: ReportStatRow[] = [
  { status: "onaylandi", modality: "CT", createdAt: at("2026-01-10T08:00:00Z"), approvedAt: at("2026-01-10T10:00:00Z"), approvedBy: "Dr A" },
  { status: "onaylandi", modality: "BT", createdAt: at("2026-01-10T08:00:00Z"), approvedAt: at("2026-01-10T20:00:00Z"), approvedBy: "Dr A" },
  { status: "onaylandi", modality: "MG", createdAt: at("2026-01-11T08:00:00Z"), approvedAt: at("2026-01-12T08:00:00Z"), approvedBy: "Dr B" },
  { status: "taslak", modality: "CT", createdAt: at("2026-01-01T08:00:00Z"), approvedAt: null, approvedBy: "" },
  { status: "onaylandi", modality: "MR", createdAt: null, approvedAt: null, approvedBy: "Dr C" },
];
const s = summarizeStats(rows, NOW);
ok(s.total === 5 && s.approved === 3, "Sayımlar doğru");
ok(s.medianHours === 12 && s.meanHours !== null, `Orta TAT ${s.medianHours} sa`);
ok(s.p90Hours === 24, `p90 ${s.p90Hours} sa`);
ok(s.byStatus["onaylandi"] === 4 && s.byModality["CT"] === 2, "Durum/modalite dağılımı");
ok(s.pendingDrafts === 1 && s.staleDrafts.count === 1 && s.staleDrafts.olderDays === 3, "Eski taslak tespiti");
ok(s.perRadiologist.length === 2 && s.perRadiologist[0].name === "Dr A" && s.perRadiologist[0].medianHours === 7, "Hekim başına kırılım");


// ───────── Haftalık trend ve hedef TAT (f-tat) ─────────

ok(weekStartOf(new Date("2026-01-15T00:00:00Z")) === "2026-01-12", "hafta başlangıcı pazartesi");
ok(weekStartOf(new Date("2026-01-12T23:59:00Z")) === "2026-01-12", "pazartesi kendi haftasında");
ok(weekStartOf(new Date("2026-01-18T10:00:00Z")) === "2026-01-12", "pazar günü hâlâ aynı haftada");

// NOW = 15 Ocak 2026 (perşembe) → 3 haftalık pencere: 29.12, 05.01, 12.01
const wkRows: ReportStatRow[] = [
  { status: "onaylandi", modality: "CT", createdAt: at("2026-01-13T08:00:00Z"), approvedAt: at("2026-01-13T12:00:00Z"), approvedBy: "Dr A" }, // 4 sa
  { status: "onaylandi", modality: "CT", createdAt: at("2026-01-14T08:00:00Z"), approvedAt: at("2026-01-14T16:00:00Z"), approvedBy: "Dr A" }, // 8 sa
  { status: "onaylandi", modality: "MR", createdAt: at("2026-01-06T08:00:00Z"), approvedAt: at("2026-01-07T08:00:00Z"), approvedBy: "Dr B" }, // 24 sa
  { status: "onaylandi", modality: "MR", createdAt: at("2025-12-30T08:00:00Z"), approvedAt: at("2025-12-31T08:00:00Z"), approvedBy: "Dr B" }, // 24 sa (pencere dışı)
  { status: "taslak", modality: "CT", createdAt: at("2026-01-13T08:00:00Z"), approvedAt: null, approvedBy: "" },
];
const trend = weeklyTrend(wkRows, 3, NOW);
ok(trend.length === 3, "3 haftalık kova döner");
ok(trend[0].weekStart === "2025-12-29" && trend[2].weekStart === "2026-01-12", "kovalar eskiden yeniye");
ok(trend[2].approved === 2 && trend[2].medianHours === 6, `son hafta medyanı 6 sa (${trend[2].medianHours})`);
ok(trend[1].approved === 1 && trend[1].medianHours === 24, "orta hafta 24 sa");
ok(trend[0].approved === 1 && trend[0].medianHours === 24, "31.12 onayı 29.12 haftasına düşer");
const outside = weeklyTrend(wkRows, 2, NOW);
ok(outside[0].approved === 1 && outside[0].weekStart === "2026-01-05", "pencere dışındaki haftalar listelenmez");
ok(weeklyTrend(wkRows.filter((r) => r.status === "taslak"), 2, NOW).every((w) => w.medianHours === null), "onaysız satırlar trende girmez");
ok(trend[0].label === "29.12", "etiket gün.ay");
ok(weeklyTrend(wkRows, 3, NOW)[2].p90Hours !== null, "p90 da hesaplanır");
ok(weeklyTrend([], 2, NOW).every((w) => w.medianHours === null), "boş kümede haftalar null");
ok(weeklyTrend(wkRows, 999, NOW).length === 52, "hafta sayısı 52 ile sınırlanır");

// hedef sınıflama
const inTarget = tatTarget(20, 24);
ok(inTarget.status === "hedef-icinde" && Math.abs(inTarget.ratio! - 20 / 24) < 1e-9, "hedef içinde");
ok(tatTarget(30, 24).status === "sinirda", "%25 sınırına kadar sınırda");
ok(tatTarget(30.1, 24).status === "hedef-disi", "hedefin %25 üstü hedef dışı");
ok(tatTarget(null, 24).status === "bilinmiyor" && tatTarget(null, 24).ratio === null, "ölçüm yoksa bilinmiyor");
ok(tatTarget(20, 0).targetHours === 24, "geçersiz hedef 24'e düşer");
ok(tatTarget(5, 24).note.includes("hedefin içinde"), "not metni hedef içinde");

// uyarılar
const alerts = tatAlerts(trend, tatTarget(48, 24));
ok(alerts.some((a) => a.includes("hedefin")), "hedef dışı uyarısı eklenir");
ok(tatAlerts(trend, tatTarget(30, 12)).some((a) => a.includes("haftası hedefi aştı")), "hedefi aşan hafta listelenir");
ok(!tatAlerts(trend, tatTarget(24, 24)).some((a) => a.includes("haftası hedefi aştı")), "hedefe eşit hafta aşım sayılmaz");
const slow = weeklyTrend(wkRows, 2, NOW);
const slowAlerts = tatAlerts(slow, tatTarget(6, 24), 2);
ok(slowAlerts.some((a) => a.includes("taslak")), "bayat taslak uyarısı eklenir");
ok(tatAlerts([], tatTarget(null, 24)).length === 0, "ölçüm yokken uyarı üretilmez");
const ctOnly = weeklyTrend(wkRows, 3, NOW, "CT");
ok(ctOnly[2].approved === 2 && ctOnly[1].approved === 0, "modalite süzgeci yalnız seçili modaliteyi sayar");
ok(weeklyTrend(wkRows, 3, NOW, "MR")[2].approved === 0, "MR süzgecinde son hafta boş");
const rising: typeof trend = [
  { weekStart: "2026-01-05", label: "5.01", approved: 2, medianHours: 4, p90Hours: 6 },
  { weekStart: "2026-01-12", label: "12.01", approved: 2, medianHours: 6, p90Hours: 8 },
];
ok(tatAlerts(rising, tatTarget(6, 24)).some((a) => a.includes("daha yavaş")), "haftalık %25 yavaşlama uyarısı");

if (failed) { console.error(`${failed} istatistik testi başarısız`); process.exit(1); }
console.log("Tüm istatistik testleri geçti.");

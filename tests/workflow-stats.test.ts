/** İş akışı istatistikleri (F4) testleri. */
import { formatHours, percentile, summarizeStats, turnaroundHours, type ReportStatRow } from "../src/lib/workflowStats";

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

if (failed) { console.error(`${failed} istatistik testi başarısız`); process.exit(1); }
console.log("Tüm istatistik testleri geçti.");

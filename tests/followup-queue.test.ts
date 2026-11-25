/**
 * d-followup: takip görevleri — kova/öncelik, yaklaşan uyarısı, iade eşleme.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { closeWithOutcome, daysLeft, dueBucket, followupAlert, followupCsv, matchReturnedResult, parseDue, summarizeFollowups, UPCOMING_DAYS, type FollowupTask } from "../src/lib/followupQueue";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

/** Sabit "bugün": 2026-11-23 */
const NOW = new Date("2026-11-23T12:00:00.000Z").getTime();
const t = (over: Partial<FollowupTask> & { id: number }): FollowupTask =>
  ({ status: "acik", dueDate: "", severity: "bilgi", message: `görev ${over.id}`, ...over });

// ── tarih ayrıştırma ──
ok(parseDue("2026-11-30") !== null, "geçerli ISO tarih");
ok(parseDue("30.11.2026") === null && parseDue("") === null && parseDue("2026-11-32") === null, "yalnız geçerli YYYY-MM-DD kabul (serbest metin/tanımsız gün reddedilir)");

// ── kovalar ──
ok(dueBucket(t({ id: 1, dueDate: "2026-11-20" }), NOW) === "geciken", "geçmiş tarih → geciken");
ok(dueBucket(t({ id: 2, dueDate: "2026-11-23" }), NOW) === "bugun", "bugün → bugun");
ok(dueBucket(t({ id: 3, dueDate: "2026-12-01" }), NOW) === "yaklasan", "8 gün sonra → yaklaşan");
ok(dueBucket(t({ id: 4, dueDate: "2027-03-01" }), NOW) === "ileri", "uzak tarih → ileri");
ok(dueBucket(t({ id: 5 }), NOW) === "tarihsiz", "tarih yok → tarihsiz");
ok(dueBucket(t({ id: 6, dueDate: "2026-11-01", status: "tamamlandi" }), NOW) === "kapali", "kapalı görev kovaya girmez");
ok(daysLeft(t({ id: 7, dueDate: "2026-12-03" }), NOW) === 10, "kalan gün hesabı");
ok(daysLeft(t({ id: 8, dueDate: "2026-11-20" }), NOW) === -3, "gecikme negatif gün");
ok(daysLeft(t({ id: 9 }), NOW) === null, "tarihsizde kalan gün null");

// ── özet ve öncelik ──
const tasks = [
  t({ id: 10, dueDate: "2026-11-19", severity: "orta" }),
  t({ id: 11, dueDate: "2026-11-23", severity: "kritik" }),
  t({ id: 12, dueDate: "2026-11-25", severity: "yuksek", modality: "BT", bodyRegion: "TORAKS" }),
  t({ id: 13, dueDate: "2027-01-10" }),
  t({ id: 14 }),
  t({ id: 15, dueDate: "2026-11-01", status: "tamamlandi" }),
];
const s = summarizeFollowups(tasks, NOW);
ok(s.open === 5 && s.buckets.kapali.length === 1, "açık/kapalı ayrımı");
ok(s.overdue === 1 && s.dueToday === 1 && s.upcoming === 1, "geciken/bugün/yaklaşan sayıları");
ok(s.ordered[0].id === 10 && s.ordered[1].id === 11, "sıralama: geciken önce, sonra bugün");
ok(s.ordered[s.ordered.length - 1].id === 14, "tarihsiz en sonda");
ok(s.alerting.length === 3 && s.alerting.every((x) => x.id !== 13), "uyarı yalnız geciken/bugün/yaklaşan");
const s2 = summarizeFollowups([t({ id: 20, dueDate: "2026-11-25", severity: "bilgi" }), t({ id: 21, dueDate: "2026-11-25", severity: "kritik" })], NOW);
ok(s2.ordered[0].id === 21, "aynı tarihte kritik öne geçer");
ok(UPCOMING_DAYS === 14, "yaklaşan penceresi 14 gün");

// ── uyarı metni ──
ok(followupAlert(t({ id: 30, dueDate: "2026-11-20" }), NOW)!.includes("GECİKTİ"), "geciken uyarısı");
ok(followupAlert(t({ id: 31, dueDate: "2026-11-23" }), NOW)!.includes("BUGÜN"), "bugün uyarısı");
ok(followupAlert(t({ id: 32, dueDate: "2026-11-28" }), NOW)!.includes("5 gün kaldı"), "yaklaşan uyarısı");
ok(followupAlert(t({ id: 33, dueDate: "2027-02-01" }), NOW) === null, "ileri tarihte uyarı yok");
ok(followupAlert(t({ id: 34, dueDate: "2026-11-01", status: "tamamlandi" }), NOW) === null, "kapalı görevde uyarı yok");

// ── iade eşleme ──
const open = [
  t({ id: 40, reportId: 7, studyUid: "1.2.3", modality: "BT", bodyRegion: "TORAKS" }),
  t({ id: 41, modality: "MR", bodyRegion: "BEYİN" }),
];
ok(matchReturnedResult({ reportId: 7, text: "x" }, open).task?.id === 40, "rapor kimliğiyle eşleşme");
ok(matchReturnedResult({ studyUid: "1.2.3", text: "x" }, open).task?.id === 40, "çalışma UID'siyle eşleşme");
ok(matchReturnedResult({ modality: "MR", bodyRegion: "BEYİN", text: "x" }, open).task?.id === 41, "tek aday (modalite+bölge)");
ok(matchReturnedResult({ modality: "BT", text: "x" }, [t({ id: 44, modality: "BT" }), t({ id: 45, modality: "MR" })]).task?.id === 44, "modalite tek adaya indirir");
ok(matchReturnedResult({ modality: "US", text: "x" }, open).reason.includes("Eşleşen"), "eşleşme yoksa gerekçe");
const ambig = [t({ id: 42, modality: "BT" }), t({ id: 43, modality: "BT" })];
ok(matchReturnedResult({ modality: "BT", text: "x" }, ambig).task === null && matchReturnedResult({ modality: "BT", text: "x" }, ambig).reason.includes("aday"), "çok aday → hekim seçmeli");

// ── sonuçla kapatma ──
const closed = closeWithOutcome(t({ id: 50, dueDate: "2026-11-20" }), { text: "  Kontrol BT: nodül stabil  " }, NOW);
ok(closed.status === "tamamlandi" && closed.outcome === "Kontrol BT: nodül stabil", "sonuç kaydı + kapanış");
ok(!!closed.completedAt && closed.outcomeAt === closed.completedAt, "zaman damgası sabit");
ok(dueBucket(closed, NOW) === "kapali", "kapalı görev uyarı üretmez");

// ── CSV ──
const csv = followupCsv(tasks, NOW);
ok(csv.split("\n").length === tasks.length + 2, "CSV başlık + satır sayısı");
ok(csv.includes("geciken") && csv.includes("2026-11-19"), "CSV kova ve tarih içerir");

// ── entegrasyon ──
const root = path.resolve(__dirname, "..");
const api = readFileSync(path.join(root, "src/app/api/notifications/route.ts"), "utf8");
ok(api.includes('sp.get("followup") === "summary"') && api.includes("summarizeFollowups"), "özet ucu bağlı");
ok(api.includes('followupCsv(tasks)') && api.includes("text/csv"), "CSV indirme ucu");
ok(api.includes('b.action === "outcome"') && api.includes("notify.followup_outcome"), "iade/sonuç bağlama denetime yazılıyor");
const bell = readFileSync(path.join(root, "src/components/NotificationsBell.tsx"), "utf8");
ok(bell.includes("İade bağla") && bell.includes("recordOutcome"), "arayüzde iade bağlama");
ok(bell.includes("gün gecikti") || bell.includes("gün kaldı"), "görev kartında kalan gün etiketi");

if (failed) { console.error(`${failed} takip kuyruğu testi başarısız`); process.exit(1); }
console.log("Tüm d-followup (takip görevleri + iade) testleri geçti.");

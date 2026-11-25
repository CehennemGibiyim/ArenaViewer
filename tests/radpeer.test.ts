/**
 * RADPEER örnekleme + uyuşmazlık istatistikleri (d-peer tamamlayıcısı).
 * DB gerekmez: seçim ve istatistik matematiği saf fonksiyonlarda sınanır.
 */
import { discordanceStats, pickSample, radpeerScore, sampleSize, statsHeadline, wilsonInterval, type Candidate } from "../src/lib/radpeer";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── RADPEER puan eşlemesi ──
ok(radpeerScore("uyumlu", "") === 1, "uyumlu → RADPEER 1");
ok(radpeerScore("kismen-uyumlu", "eksik bulgu") === "2a", "kısmen uyumlu → 2a");
ok(radpeerScore("uyumsuz", "yanlış yorum") === 3, "yanlış yorum → 3 (büyük fark)");
ok(radpeerScore("uyumsuz", "ölçüm/yerelizasyon hatası") === 3, "ölçüm hatası → 3");
ok(radpeerScore("uyumsuz", "teknik/kalite") === "2b", "teknik neden → 2b");
ok(radpeerScore("bilinmeyen", "") === null, "bilinmeyen sonuç puana çevrilmez");

// ── örneklem büyüklüğü ──
ok(sampleSize(0, 5) === 0, "boş havuzda örneklem yok");
ok(sampleSize(100, 5) === 5 && sampleSize(100, 10) === 10, "oran × toplam yuvarlanır");
ok(sampleSize(10, 5, 1) === 1, "en az 1 (aylık asgari)");
ok(sampleSize(1000, 50, 0, 50) === 50, "üst sınır uygulanır");
ok(sampleSize(100, 500) === 50, "oran 100'e kırpılır");

// ── seçim: deterministik, dışlamalı, uydurmasız ──
const cand = (id: number, over: Partial<Candidate> = {}): Candidate =>
  ({ reportId: id, studyId: 1000 + id, approvedAt: "2026-11-01T10:00:00Z", approvedBy: "Dr A", createdBy: 2, reviewedByMe: false, ...over });
const pool = [cand(1), cand(2), cand(3), cand(4), cand(5, { reviewedByMe: true })];
const s1 = pickSample(pool, 40, "2026-11-25", 0, 50);
const s2 = pickSample(pool, 40, "2026-11-25", 0, 50);
ok(s1.picked.map((p) => p.reportId).join(",") === s2.picked.map((p) => p.reportId).join(","), "aynı gün aynı örneklem (deterministik)");
ok(!s1.picked.some((p) => p.reportId === 5), "bu kullanıcının değerlendirdiği rapor aday değil");
ok(s1.eligible === 4 && s1.target === 2, "uygun havuz ve hedef doğru (4 × %40)");
const s3 = pickSample(pool, 100, "2026-11-26", 0, 50);
ok(s3.picked.length === 4, "tüm uygun adaylar seçilebilir");
const empty = pickSample([], 5, "g");
ok(empty.picked.length === 0 && empty.note.length > 0, "boş havuzda uydurma seçim yok, not döner");
const shortPool = [cand(9), cand(10)];
const short = pickSample(shortPool, 50, "g", 5, 50);
ok(short.picked.length === 2 && /Hedef 5/.test(short.note), "hedefe ulaşılamazsa açıkça söylenir");

// ── istatistikler ──
const rows = [
  { result: "uyumlu", discrepancyType: "", reviewedByName: "Dr A", createdAt: "2026-11-01" },
  { result: "uyumlu", discrepancyType: "", reviewedByName: "Dr A", createdAt: "2026-11-02" },
  { result: "kismen-uyumlu", discrepancyType: "eksik bulgu", reviewedByName: "Dr B", createdAt: "2026-11-03" },
  { result: "uyumsuz", discrepancyType: "yanlış yorum", reviewedByName: "Dr B", createdAt: "2026-11-04" },
  { result: "bozuk", discrepancyType: "", reviewedByName: "Dr C", createdAt: "2026-11-05" },
];
const st = discordanceStats(rows);
ok(st.total === 5 && st.known === 4, "bilinmeyen sonuç toplamda görünür, oranda sayılmaz");
ok(st.uyumlu === 2 && st.kismen === 1 && st.uyumsuz === 1, "sonuç dağılımı");
ok(near(st.agreementRate!, 0.75), "uyum oranı %75 (uyumlu + kısmen)");
ok(near(st.majorRate!, 0.25), "büyük fark oranı %25");
ok(st.byScore.find((x) => x.score === 1)!.count === 2 && st.byScore.find((x) => x.score === 3)!.count === 1, "RADPEER puan dağılımı");
ok(st.byType[0].type === "eksik bulgu" || st.byType[0].type === "yanlış yorum", "fark türleri sayılıyor");
const drA = st.reviewers.find((r) => r.reviewer === "Dr A")!;
ok(drA.total === 2 && drA.agreementRate === 1, "hekim bazında uyum");
ok(st.wilson !== null && st.wilson.low < 0.75 && st.wilson.high > 0.75, "Wilson aralığı nokta tahminini içerir");
ok(wilsonInterval(0, 0) === null, "n=0 için aralık yok");
ok(statsHeadline(st).includes("%75") && statsHeadline(st).includes("%95 GA"), "başlık oran ve güven aralığını taşıyor");
const zero = discordanceStats([]);
ok(zero.agreementRate === null && zero.wilson === null && zero.known === 0, "kayıt yoksa oran uydurulmaz");

if (failed) { console.error(`${failed} RADPEER testi başarısız`); process.exit(1); }
console.log("Tüm RADPEER (örneklem + uyuşmazlık istatistiği) testleri geçti.");

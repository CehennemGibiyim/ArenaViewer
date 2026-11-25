/** İkinci okuma / peer review (D) mantığı testleri. */
import {
  PEER_RESULTS, RADPEER_LABELS, RESULT_LABELS, isPeerResult, peerAdvice, peerSeedHash, peerStats,
  radpeerScore, samplingTarget, shouldSampleReport, summarizePeerReviews, validatePeerReview,
  type PeerReviewRow,
} from "../src/lib/peerReview";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

ok(PEER_RESULTS.length === 3 && RESULT_LABELS["uyumsuz"].length > 10, "Sonuç sözleşmesi ve etiketler");
ok(isPeerResult("kismen-uyumlu") && !isPeerResult("farklı"), "Sonuç doğrulama");

ok(validatePeerReview({ result: "uyumlu" }).ok, "Uyumlu kayıt kabul");
ok(!validatePeerReview({ result: "belirsiz" }).ok, "Geçersiz sonuç reddedilir");
ok(!validatePeerReview({ result: "uyumsuz", note: "" }).ok, "Uyumsuz kayıtta açıklama zorunlu");
ok(validatePeerReview({ result: "uyumlu", discrepancyType: "diğer", note: "x".repeat(50) }).ok, "Tür/not alanları kabul");

const rows = [
  { id: 1, reportId: 1, result: "uyumlu", discrepancyType: "", note: "", reviewedBy: 2, reviewedByName: "Dr B", contentHash: "h", createdAt: "2026-01-10T10:00:00Z" },
  { id: 2, reportId: 1, result: "kismen-uyumlu", discrepancyType: "eksik bulgu", note: "n", reviewedBy: 3, reviewedByName: "Dr C", contentHash: "h", createdAt: "2026-01-11T10:00:00Z" },
  { id: 3, reportId: 1, result: "uyumsuz", discrepancyType: "yanlış yorum", note: "fark", reviewedBy: 4, reviewedByName: "Dr D", contentHash: "h", createdAt: "2026-01-12T10:00:00Z" },
];
const s = summarizePeerReviews(rows as never);
ok(s.total === 3 && s.uyumlu === 1 && s.kismen === 1 && s.uyumsuz === 1, "Özet sayımları");
ok(Math.abs((s.agreementRate ?? 0) - 2 / 3) < 1e-9, `Uyum oranı ${s.agreementRate?.toFixed(2)}`);
ok(s.lastResult === "uyumsuz", "En son kayıt sonuç olarak döner");
ok(peerAdvice("uyumsuz").includes("yeniden onaylatın") && peerAdvice("uyumlu").includes("ek işlem gerekmez"), "Sonuca göre öneri");


// ───────── RADPEER puanlama, örnekleme ve gözetim istatistikleri (d-peer) ─────────

ok(radpeerScore("uyumlu") === 1 && radpeerScore("kismen-uyumlu") === 2 && radpeerScore("uyumsuz") === 3, "RADPEER puan eşlemesi (1/2/3)");
ok(radpeerScore("bilinmeyen") === null && radpeerScore(null) === null, "bilinmeyen sonuç puansız");
ok(RADPEER_LABELS[3].includes("anlamlı") && RADPEER_LABELS[1].startsWith("1"), "RADPEER etiketleri");

ok(peerSeedHash("abc") === peerSeedHash("abc") && peerSeedHash("abc") !== peerSeedHash("abd"), "tohum özeti deterministik");
const sampled = Array.from({ length: 5000 }, (_, i) => shouldSampleReport(i + 1, 10));
const share = sampled.filter(Boolean).length / sampled.length;
ok(Math.abs(share - 0.1) < 0.015, `%10 örnekleme dağılıma yansır (ölçülen %${(share * 100).toFixed(1)})`);
ok(sampled[10] === shouldSampleReport(11, 10), "aynı rapor her zaman aynı sonucu verir");
ok(shouldSampleReport(12345, 0) === false && shouldSampleReport(1, 100) === true, "uç oranlar (0 / 100)");
ok(shouldSampleReport(7, Number.NaN) === false, "geçersiz oran örneklemez");

const t1 = samplingTarget(200, 5, 4);
ok(t1.expected === 10 && t1.remaining === 6 && !t1.met, `hedef %5 → 200 raporda 10 okuma, 6 kaldı (${t1.expected}/${t1.remaining})`);
ok(t1.note.includes("6 rapor"), "hedef notu kalan sayıyı yazar");
const t2 = samplingTarget(200, 5, 12);
ok(t2.met && t2.remaining === 0 && t2.note.includes("karşılandı"), "hedef aşılınca kalan 0");
ok(samplingTarget(0, 5, 0).expected === 0 && samplingTarget(10, -5, 0).ratePct === 0, "sıfır/negatif oran güvenli");
ok(samplingTarget(10, 250, 0).ratePct === 100, "oran %100'e kırpılır");

// istatistikler
const mkRow = (o: Partial<PeerReviewRow> & { id: number }): PeerReviewRow => ({
  reportId: o.id, result: "uyumlu", discrepancyType: "", note: "", reviewedBy: 2, reviewedByName: "Dr B",
  contentHash: "h", createdAt: "2026-01-0" + ((o.id % 9) + 1) + "T10:00:00Z", ...o,
});
const peerRows: PeerReviewRow[] = [
  mkRow({ id: 1, result: "uyumlu" }),
  mkRow({ id: 2, result: "uyumlu" }),
  mkRow({ id: 3, result: "kismen-uyumlu", discrepancyType: "eksik bulgu" }),
  mkRow({ id: 4, result: "uyumsuz", discrepancyType: "yanlış yorum", note: "Yeniden değerlendirildi", reviewedByName: "Dr C" }),
  mkRow({ id: 5, result: "uyumsuz", discrepancyType: "yanlış yorum", note: "Fark anlamlı", reviewedByName: "Dr C" }),
];
const st = peerStats(peerRows);
ok(st.total === 5, "toplam kayıt");
ok(st.byScore[0].count === 2 && st.byScore[1].count === 1 && st.byScore[2].count === 2, "RADPEER 1/2/3 sayıları");
ok(Math.abs(st.byScore[0].pct - 40) < 1e-9 && Math.abs(st.byScore[2].pct - 40) < 1e-9, "puan yüzdeleri");
ok(Math.abs(st.agreementRate! - 0.6) < 1e-9, "uyum oranı: puan 1–2 uyumlu (%60)");
ok(st.byDiscrepancy.length === 1 && st.byDiscrepancy[0].type === "yanlış yorum" && st.byDiscrepancy[0].count === 2, "uyuşmazlık türleri yalnız puan 3 için sayılır");
ok(st.byReviewer[0].name === "Dr C" && st.byReviewer[0].count === 2 && st.byReviewer[0].disagreements === 2 && st.byReviewer[0].disagreementRate === 1
  || st.byReviewer.find((r) => r.name === "Dr C")!.disagreementRate === 1, "hekim başına uyumsuzluk oranı");
ok(st.needsFollowUp.length === 2 && st.needsFollowUp.every((r) => r.result === "uyumsuz"), "takip listesi yalnız uyumsuzlar");
ok(st.note.includes("uyum oranı"), "özet notu uyum oranını yazar");
const empty = peerStats([]);
ok(empty.total === 0 && empty.agreementRate === null && empty.byScore.every((b) => b.count === 0), "boş kümede oran null");
ok(empty.note.includes("kaydı yok") && peerStats(peerRows, 1).needsFollowUp.length === 1, "takip listesi sınırlanır");
ok(peerStats([mkRow({ id: 9, result: "bilinmeyen" })]).agreementRate === null, "bilinmeyen sonuç orana katılmaz");

if (failed) { console.error(`${failed} peer review testi başarısız`); process.exit(1); }
console.log("Tüm ikinci okuma testleri geçti.");

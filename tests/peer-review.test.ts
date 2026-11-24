/** İkinci okuma / peer review (D) mantığı testleri. */
import { PEER_RESULTS, RESULT_LABELS, isPeerResult, peerAdvice, summarizePeerReviews, validatePeerReview } from "../src/lib/peerReview";

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

if (failed) { console.error(`${failed} peer review testi başarısız`); process.exit(1); }
console.log("Tüm ikinci okuma testleri geçti.");

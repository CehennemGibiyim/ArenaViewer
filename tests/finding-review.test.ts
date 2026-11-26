/**
 * Bulgu gözden geçirme gerekçesi testleri (r-review).
 *
 * Sözleşme: reddedilen/düzenlenen her bulgu için gerekçe zorunludur; gerekçe
 * normalleştirilir, yalnız ilgili durumlar için saklanır ve yazdırma çıktısına
 * yalnız dolu gerekçeler girer.
 */
import {
  REVIEW_REASON_MAX,
  missingReviewReasons,
  needsReviewReason,
  normalizeReviewReason,
  reviewReasonLines,
  reviewTally,
  sanitizeReviewReasons,
} from "../src/lib/findingReview";
import type { Finding, FindingApprovalStatus } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function finding(id: string, label: string): Finding {
  return {
    id, label, detail: "", category: "Aday", severity: "orta", confidence: 0.5, confidenceKind: "heuristic",
    source: "ai-model", sliceIndex: 0, sliceStart: 0, sliceEnd: 0, keySliceNumber: 1, sliceRangeStr: "1",
    anatomicalLocation: "akciğer", densityOrSignal: "yumuşak doku", sizeMmStr: "8 mm", bbox: null,
  };
}

const findings = [finding("f1", "Nodül A"), finding("f2", "Nodül B"), finding("f3", "Lezyon C"), finding("f4", "Sistem")];
const approvals: Record<string, FindingApprovalStatus> = {
  f1: "onaylandi", f2: "reddedildi", f3: "duzenlendi", f4: "onaylandi",
};

// ── 1. gerekçe zorunlu durumlar ──
ok(needsReviewReason("reddedildi"), "reddedilen bulgu gerekçe ister");
ok(needsReviewReason("duzenlendi"), "düzenlenen bulgu gerekçe ister");
ok(!needsReviewReason("onaylandi"), "onaylanan bulgu gerekçe istemez");
ok(!needsReviewReason("bekliyor"), "bekleyen bulgu gerekçe istemez");

// ── 2. normalleştirme ──
ok(normalizeReviewReason("  yanlış   pozitif \n") === "yanlış pozitif", "boşluklar sadeleşir ve kırpılır");
ok(normalizeReviewReason(undefined) === "" && normalizeReviewReason(42) === "", "metin olmayan girdi boş döner");
const long = "a".repeat(REVIEW_REASON_MAX + 50);
ok(normalizeReviewReason(long).length === REVIEW_REASON_MAX, `gerekçe ${REVIEW_REASON_MAX} karakterle sınırlanır`);
ok(normalizeReviewReason("satır1\nsatır2") === "satır1 satır2", "satır sonu tek boşluğa iner");

// ── 3. saklama biçimi ──
const sanitized = sanitizeReviewReasons({ f1: "onaylanan için not", f2: " artefakt ", f3: "", f4: "  " }, approvals);
ok(Object.keys(sanitized).length === 1 && sanitized.f2 === "artefakt", "yalnız reddedilen/düzenlenen ve dolu gerekçe saklanır");
ok(sanitizeReviewReasons(undefined, approvals) !== null && Object.keys(sanitizeReviewReasons(undefined, approvals)).length === 0, "gerekçe haritası yokken boş nesne döner");
const statusChanged = sanitizeReviewReasons({ f2: "ret gerekçesi" }, { ...approvals, f2: "onaylandi" });
ok(Object.keys(statusChanged).length === 0, "durum onaylandıya dönerse eski gerekçe saklanmaz");

// ── 4. eksik gerekçeler ──
const missing = missingReviewReasons(findings, approvals, { f2: "artefakt" });
ok(missing.length === 1 && missing[0] === "f3", "gerekçesi boş düzenlenen bulgu eksik olarak bildirilir");
ok(missingReviewReasons(findings, approvals, { f2: "artefakt", f3: "yanlış sınır" }).length === 0, "iki gerekçe de yazılınca eksik kalmaz");
ok(missingReviewReasons(findings, { ...approvals, f2: "bekliyor", f3: "bekliyor" }, {}).length === 0, "bekleyen bulgu gerekçe listesine girmez");
ok(missingReviewReasons([], {}, {}) .length === 0, "bulgu yokken eksik listesi boş");

// ── 5. yazdırma satırları ──
const lines = reviewReasonLines(findings, approvals, { f2: " artefakt ", f3: "sınır yanlış", f1: "onaylanmış not" });
ok(lines.length === 2, "yazdırma listesi yalnız gerekçeli reddedilen/düzenlenen bulguları taşır");
ok(lines[0].id === "f2" && lines[0].reason === "artefakt" && lines[0].status === "reddedildi", "ilk satır sırayla reddedilen bulgu ve kırpılmış gerekçe");
ok(lines[1].id === "f3" && lines[1].status === "duzenlendi", "ikinci satır düzenlenen bulgu");
ok(reviewReasonLines(findings, approvals, {}).length === 0, "gerekçe yokken yazdırma listesi boş");

// ── 6. sayaçlar ──
const tally = reviewTally(findings, approvals, { f2: "artefakt" });
ok(tally.approved === 2 && tally.rejected === 1 && tally.edited === 1 && tally.pending === 0, `durum sayımı doğru (${tally.approved}/${tally.rejected}/${tally.edited}/${tally.pending})`);
ok(tally.withReason === 1, "gerekçe yazılan bulgu sayısı doğru");
const tallyEmpty = reviewTally(findings, {}, undefined);
ok(tallyEmpty.pending === 4 && tallyEmpty.withReason === 0, "durum yokken hepsi bekliyor sayılır");

if (failed) { console.error(`${failed} gözden geçirme gerekçesi testi başarısız`); process.exit(1); }
console.log("Gözden geçirme gerekçesi testleri geçti.");

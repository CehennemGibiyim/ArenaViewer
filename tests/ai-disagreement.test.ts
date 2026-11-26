/**
 * AI önerisi ↔ hekim kararı uyuşmazlığı testleri.
 *
 * Sözleşme: yalnız karar verilmiş (onay/ret/düzenleme) aday bulgular sayılır;
 * sistem/ROI satırları ve hekimin elle eklediği bulgular hesaba girmez; gerekçe
 * özeti yalnız reddedilen/düzenlenen ve gerekçesi dolu bulguları taşır; sıralama
 * deterministiktir.
 */
import { disagreementByCategory, disagreementTally, reasonDigest } from "../src/lib/aiDisagreement";
import type { Finding, FindingApprovalStatus } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function finding(id: string, category: string, label = id, source: Finding["source"] = "ai-model"): Finding {
  return {
    id, label, category, source, detail: "", severity: "orta", confidence: 0.6, confidenceKind: "heuristic",
    sliceIndex: 0, sliceStart: 0, sliceEnd: 0, keySliceNumber: 1, sliceRangeStr: "1",
    anatomicalLocation: "akciğer", densityOrSignal: "yumuşak doku", sizeMmStr: "8 mm", bbox: null,
  };
}

const findings = [
  finding("a1", "Nodül"),
  finding("a2", "Nodül"),
  finding("a3", "Nodül"),
  finding("b1", "Konsolidasyon"),
  finding("b2", "Konsolidasyon"),
  finding("s1", "Sistem"),
  finding("r1", "ROI"),
  finding("m1", "Nodül", "Hekim eklemesi", "manual"),
];
const approvals: Record<string, FindingApprovalStatus> = {
  a1: "onaylandi", a2: "reddedildi", a3: "bekliyor",
  b1: "duzenlendi", b2: "onaylandi",
  s1: "onaylandi", r1: "reddedildi", m1: "reddedildi",
};
const reasons = { a2: " artefakt ", b1: "sınır yanlış", a3: "henüz yok", m1: "elle eklendi" };
const sources = [{ findings, approvals, reasons, engine: "deep-nodule" }];

// ── 1. kategori bazlı oranlar ──
const cats = disagreementByCategory(sources);
const nodul = cats.find((c) => c.category === "Nodül")!;
const kons = cats.find((c) => c.category === "Konsolidasyon")!;
ok(cats.length === 2, `sistem/ROI ve elle eklenen bulgular hesaba girmez (kategori: ${cats.map((c) => c.category).join(", ")})`);
ok(nodul.decided === 2 && nodul.approved === 1 && nodul.rejected === 1, "bekleyen bulgu karar sayılmaz; Nodül: 2 karar");
ok(nodul.disagreementRate === 0.5, `Nodül uyuşmazlığı %50 (${nodul.disagreementRate})`);
ok(kons.decided === 2 && kons.edited === 1 && kons.disagreementRate === 0.5, "Konsolidasyon: 1 düzenleme → %50");
ok(cats[0].decided >= cats[1].decided, "eşit oranda daha çok karar verilen kategori önce gelir");
ok(disagreementByCategory([]).length === 0, "kayıt yokken liste boş");
ok(disagreementByCategory([{ findings: [], approvals: {} }]).length === 0, "bulgu yokken liste boş");
const half = disagreementByCategory([{ findings: [finding("x", "Kütle")], approvals: { x: "reddedildi" }, engine: "" }]);
ok(half[0].engine === "?" && half[0].disagreementRate === 1, "motor adı yoksa '?' yazılır; tek ret oranı %100");

// ── 2. gerekçe özeti ──
const digest = reasonDigest(sources);
ok(digest.length === 2, `gerekçe özeti yalnız dolu gerekçeleri taşır (${digest.length})`);
ok(digest[0].label === "a2" && digest[0].reason === "artefakt" && digest[0].status === "reddedildi", "ret gerekçesi kırpılarak gelir");
ok(digest[1].label === "b1" && digest[1].status === "duzenlendi", "düzenleme gerekçesi ikinci satır");
ok(!digest.some((d) => d.label === "s1" || d.label === "r1" || d.label === "m1"), "sistem/ROI/elle eklenen gerekçeleri özete girmez");
ok(reasonDigest(sources, 1).length === 1, "limit uygulanır");
ok(reasonDigest(sources, 0).length === 0, "limit 0 → boş liste");
ok(reasonDigest([{ findings, approvals, reasons: {} }]).length === 0, "gerekçe haritası boşken özet boş");

// ── 3. toplam ──
const tally = disagreementTally(cats, digest);
ok(tally.decided === 4 && tally.rejected === 1 && tally.edited === 1, `toplam karar/ret/düzenleme (${tally.decided}/${tally.rejected}/${tally.edited})`);
ok(tally.rate === 0.5, `toplam uyuşmazlık oranı %50 (${tally.rate})`);
ok(tally.withReason === 2, "gerekçe sayısı özetten gelir");
const empty = disagreementTally([], []);
ok(empty.decided === 0 && empty.rate === null, "veri yokken oran null (sıfır sanılmaz)");

if (failed) { console.error(`${failed} uyuşmazlık testi başarısız`); process.exit(1); }
console.log("Uyuşmazlık testleri geçti.");

/**
 * Rapor cümlesi → bulgu bağlama testleri (r-link).
 *
 * Sözleşme: açık «Kesit N» ifadesi kesit eşleşmesiyle kazanır; aksi halde bulgu
 * etiketiyle ortak sözcük (≥ 4 harf, stopword yok) aranır; eşleşme yoksa cümle
 * bağlanmaz (uydurma bağ kurulmaz).
 */
import { linkCoverage, linkSentences, linkTokens, sliceFromSentence, type LinkTarget } from "../src/lib/sentenceLinks";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const findings: LinkTarget[] = [
  { id: "f1", label: "Nodül sağ akciğer üst lob", keySliceNumber: 12, sliceIndex: 11 },
  { id: "f2", label: "Konsolidasyon", keySliceNumber: 30, sliceIndex: 29 },
  { id: "f3", label: "Plevral efüzyon", keySliceNumber: 45, sliceIndex: 44 },
];

// ── 1. sözcük ayıklama ──
ok(linkTokens("Nodül sağ akciğerde izlendi.").includes("nodül"), "anlamlı sözcük korunur");
ok(!linkTokens("Nodül sağ akciğerde izlendi.").includes("izlendi"), "stopword atılır");
ok(!linkTokens("Nodül 12 mm").includes("12"), "sayı sözcük olarak alınmaz");
ok(linkTokens("a b c").length === 0, "3 harften kısa sözcükler atılır");
ok(new Set(linkTokens("nodül NODÜL nodül")).size === 1, "tekrarlar tekilleşir");
ok(linkTokens("KONTROL kontrol").length === 1, "büyük/küçük harf farkı tekilleşir (Türkçe küçük harfe çevrilir)");

// ── 2. kesit numarası ──
ok(sliceFromSentence("Kesit 12'de nodül.") === 12, "«Kesit 12» → 12");
ok(sliceFromSentence("kesit:7 alanı") === 7, "«kesit:7» → 7");
ok(sliceFromSentence("Kesit #45 kontrol") === 45, "«Kesit #45» → 45");
ok(sliceFromSentence("Kesitler incelendi") === null, "«kesitler» eşleşmez");
ok(sliceFromSentence("nodül var") === null, "kesit ifadesi yoksa null");

// ── 3. bağlama ──
const links = linkSentences(
  "Kesit 12'de 9 mm nodül izlendi. Konsolidasyon sağ alt lobda belirgindir. Hastaya bilgi verildi. Kesit 45'te plevral efüzyon mevcut.",
  findings,
);
ok(links.length === 4, `4 cümle bölündü (${links.length})`);
ok(links[0].findingId === "f1" && links[0].matchedBy === "kesit", "«Kesit 12» → f1 (kesit eşleşmesi)");
ok(links[0].sliceNumber === 12, "bağlı cümlenin kesit numarası taşınır");
ok(links[1].findingId === "f2" && links[1].matchedBy === "etiket", "«Konsolidasyon» etiketle f2'ye bağlanır");
ok(links[2].findingId === null && links[2].matchedBy === null, "ilgisiz cümle bağlanmaz");
ok(links[3].findingId === "f3" && links[3].sliceNumber === 45, "«Kesit 45» → f3");
ok(linkSentences("Nodül ve efüzyon birlikte.", findings)[0].findingId === "f1", "iki etiket varsa listede önce gelen kazanır");

const cov = linkCoverage(links);
ok(cov.linked === 3 && cov.total === 4, `kapsam 3/4 (${cov.linked}/${cov.total})`);
ok(cov.ratio === 0.75, `oran %75 (${cov.ratio})`);
ok(linkCoverage([]).ratio === 0, "boş listede oran 0");
ok(linkSentences("", findings).length === 0, "boş metin → bağ yok");

// ── 4. sınır durumlar ──
ok(linkSentences("Kesit 99'da lezyon.", findings)[0].findingId === null, "var olmayan kesit numarası bağlanmaz");
ok(linkSentences("Kesit 99'da nodül.", findings)[0].sliceNumber === 99, "eşleşmese de kesit numarası korunur (gidilebilir)");
ok(linkSentences("nodül", [])[0].findingId === null, "bulgu listesi boşsa bağ yok");
const noKs = linkSentences("Nodül görüldü.", [{ id: "x", label: "Nodül" }]);
ok(noKs[0].findingId === "x" && noKs[0].sliceNumber === null, "kesit bilgisi olmayan bulgu bağlanır ama kesit null (tıklanamaz)");
const idxOnly = linkSentences("Nodül görüldü.", [{ id: "y", label: "Nodül", sliceIndex: 4 }]);
ok(idxOnly[0].sliceNumber === 5, "0 tabanlı indeks 1 tabanlı kesit numarasına çevrilir");
ok(linkSentences("kontrastlanma alanı", [{ id: "z", label: "kontrastlanma" }])[0].findingId === "z", "uzun tıbbi terim eşleşir");

if (failed) { console.error(`${failed} cümle bağlama testi başarısız`); process.exit(1); }
console.log("Cümle → bulgu bağlama testleri geçti.");

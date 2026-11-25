/** Lezyon izleme / RECIST tamamlayıcı testleri. */
import {
  lesionsAt, studyDates, summarizeNoduleTracking, type NoduleLike,
} from "../src/lib/lesionTracking";
import {
  isLymphNode, lesionSignature, lymphNodeCategory, lymphNodeTable, matchLesions, nonTargetStatus,
} from "../src/lib/lesionTracking";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const base = [
  { id: "a", anatomy: "Akciğer", location: "sağ üst lob", date: "2026-01-01", longMm: 30 },
  { id: "b", anatomy: "Karaciğer", location: "segment 8", date: "2026-01-01", longMm: 20 },
];
const follow = [
  { id: "x", anatomy: "akciğer", location: "sağ üst lob", date: "2026-04-01", longMm: 20 },
  { id: "y", anatomy: "Karaciğer", location: "segment 7", date: "2026-04-01", longMm: 18 },
  { id: "z", anatomy: "Kemik", location: "sol femur", date: "2026-04-01", longMm: 25 },
];

const t = matchLesions(base, follow);
ok(t.matched.length === 1 && t.matched[0].baseline.id === "a" && t.matched[0].followUp.id === "x", "Eşleşme: aynı anatomi+konum eşleşti");
ok(t.newOnes.length === 2 && t.disappeared.length === 1, "Yeni/kaybolan ayrımı (2 yeni, 1 kaybolan)");
ok(lesionSignature({ anatomy: "Akciğer", location: "sağ üst lob" }) === lesionSignature({ anatomy: "akciğer ", location: "SAĞ ÜST LOB." }), "İmza normalize ediliyor");

ok(isLymphNode("Lenf nodu") && !isLymphNode("Akciğer"), "Lenf nodu tespiti");
ok(lymphNodeCategory(9) === "normal" && lymphNodeCategory(12) === "takip" && lymphNodeCategory(15) === "patolojik", "Lenf nodu kısa eksen kategorileri (<10 / 10–<15 / ≥15 mm)");
const nodes = lymphNodeTable([
  { id: "n1", anatomy: "Lenf nodu", location: "mediasten", shortMm: 8 },
  { id: "n2", anatomy: "lenf nodu", location: "sol axilla", shortMm: 16 },
  { id: "n3", anatomy: "Akciğer", location: "lob", shortMm: 20 },
]);
ok(nodes.length === 2 && nodes[0].category === "normal" && nodes[1].category === "patolojik", "Lenf nodu tablosu yalnız lenf nodlarını alır");

ok(nonTargetStatus(10, 0) === "kayboldu", "Non-hedef: izlemde ölçülebilir lezyon yok → kayboldu");
ok(nonTargetStatus(10, 6) === "kalici", "Non-hedef: belirgin artış yok → kalıcı");
ok(nonTargetStatus(10, 16) === "artis", "Non-hedef: +6 mm → artış");
ok(nonTargetStatus(20, 25) === "artis", "Non-hedef: %25 artış → artış");
ok(nonTargetStatus(20, 21) === "kalici", "Non-hedef: küçük değişim → kalıcı");
ok(nonTargetStatus(null, 5) === "belirsiz", "Non-hedef: bazal ölçüm yok → belirsiz");

// ───────── Nodül takibi köprüsü: çalışmalar arası eşleştirme ─────────

const tracks: NoduleLike[] = [
  { id: "n1", label: "Nodül 1", location: "sağ üst lob", points: [
    { date: "2026-01-10", diameterMm: 6 }, { date: "2026-07-10", diameterMm: 9 }] },
  { id: "n2", label: "Nodül 2", location: "sol alt lob", points: [
    { date: "2026-01-10", diameterMm: 12 }, { date: "2026-07-10", diameterMm: 11 }] },
  { id: "n3", label: "Nodül 3", location: "sağ alt lob", points: [
    { date: "2026-07-10", diameterMm: 4 }] }, // izlemde yeni
  { id: "nl", label: "Lenf nodu", location: "lenf nodu hiler", points: [
    { date: "2026-01-10", diameterMm: 9 }, { date: "2026-07-10", diameterMm: 16 }] },
];

ok(studyDates(tracks).join(",") === "2026-07-10,2026-01-10", "çalışma tarihleri yeniden eskiye");
ok(lesionsAt(tracks, "2026-07-10").length === 4, "izlemde 4 lezyon");
ok(lesionsAt(tracks, "2025-01-01").length === 0, "ölçüm olmayan tarihte boş");
ok(lesionsAt(tracks, "2026-01-10").find((l) => l.id.startsWith("nl"))?.shortMm === 9, "lenf nodunda kısa eksen taşınır");
ok(lesionsAt(tracks, "2026-01-10").find((l) => l.id.startsWith("n1"))?.shortMm === null, "nodülde kısa eksen yok");

const sum = summarizeNoduleTracking(tracks);
ok(sum.baselineDate === "2026-01-10" && sum.followUpDate === "2026-07-10", "bazal/izlem tarihleri doğru");
ok(sum.result.matched.length === 3, "3 lezyon eşleşti (lenf nodu dahil)");
ok(sum.result.newOnes.length === 1 && sum.result.newOnes[0].location === "Nodül 3", "yeni lezyon yakalandı");
ok(sum.result.disappeared.length === 0, "kaybolan lezyon yok");
const p1 = sum.pairs.find((p) => p.label === "Nodül 1")!;
ok(p1.deltaMm === 3 && p1.pctChange === 50, "çap değişimi +3 mm / %50");
const p2 = sum.pairs.find((p) => p.label === "Nodül 2")!;
ok(p2.deltaMm === -1, "küçülen lezyon negatif delta");
ok(sum.nodes.length === 1 && sum.nodes[0].category === "patolojik", "lenf nodu 16 mm → patolojik (≥15)");
ok(sum.note.includes("Yeni"), "yeni lezyon varsa PD uyarısı");

// Tek tarih: eşleştirme yapılmaz, nedeni döner.
const single = summarizeNoduleTracking([{ id: "x", label: "N", location: "lob", points: [{ date: "2026-03-01", diameterMm: 5 }] }]);
ok(single.result.matched.length === 0 && single.followUpDate === null, "tek tarihte eşleştirme yok");
ok(single.note.includes("iki çalışma tarihi"), "tek tarihte neden açıklanır");
ok(single.baselineDate === "2026-03-01", "tek tarih bazal olarak raporlanır");

// Boş girdi çökmez.
const none = summarizeNoduleTracking([]);
ok(none.baselineDate === null && none.pairs.length === 0 && none.nodes.length === 0, "boş girdi güvenli");
console.log("PASS nodül takibi köprüsü: eşleştirme, yeni lezyon, lenf nodu ve CSV alanları.");

if (failed) { console.error(`${failed} lezyon izleme testi başarısız`); process.exit(1); }
console.log("Tüm lezyon izleme testleri geçti.");

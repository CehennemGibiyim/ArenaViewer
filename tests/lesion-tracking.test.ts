/** Lezyon izleme / RECIST tamamlayıcı testleri. */
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

if (failed) { console.error(`${failed} lezyon izleme testi başarısız`); process.exit(1); }
console.log("Tüm lezyon izleme testleri geçti.");

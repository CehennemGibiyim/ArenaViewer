/**
 * c-recist-full: hedef seçim/limit denetimi, non-hedef ve genel yanıt testleri.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fullRecist, lymphNodeSelection, nonTargetResponse, overallResponse, RECIST_LIMITS, validateTargets, type CandidateLesion } from "../src/lib/recistFull";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const c = (id: string, organ: string, size: number | null, extra: Partial<CandidateLesion> = {}): CandidateLesion =>
  ({ id, label: id, organ, sizeMm: size, selected: true, ...extra });

// ── ölçüt denetimi ──
const s1 = validateTargets([c("A", "akciğer", 12), c("B", "akciğer", 8), c("C", "karaciğer", null)]);
ok(s1.targetCount === 1 && s1.targets[0].id === "A", "≥10 mm olan tek lezyon hedef oldu");
ok(s1.issues.length === 2 && s1.issues.every((i) => i.severity === "hata"), "küçük ve ölçüsüz lezyon hata verir");
ok(s1.issues[0].message.includes("10 mm"), "hata metni eşiği belirtir");

// organ limiti
const many = validateTargets([
  c("A", "akciğer", 20), c("B", "akciğer", 18), c("C", "akciğer", 16),
  c("D", "karaciğer", 20), c("E", "karaciğer", 20),
]);
ok(many.perOrgan["akciğer"] === 3, "organ sayacı tüm seçimleri sayar");
ok(many.targetCount === 4 && many.issues.some((i) => i.message.includes("en fazla 2")), "organ başına 2 hedef sınırı uygulanır");

// toplam limit
const total = validateTargets(Array.from({ length: 8 }, (_, i) => c(`L${i}`, `organ${i}`, 20)));
ok(total.targetCount === RECIST_LIMITS.total, "toplam 5 hedef sınırı");
ok(total.issues.filter((i) => i.message.includes("toplam")).length === 3, "kalan lezyonlar toplam sınırı nedeniyle dışlanır");

// lenf nodu kuralı
const node = validateTargets([c("N1", "mediasten", 12, { lymphNode: true }), c("N2", "mediasten", 16, { lymphNode: true })]);
ok(node.targetCount === 1 && node.targets[0].id === "N2", "lenf nodu hedefi için kısa eksen ≥15 mm");
ok(node.issues[0].message.includes("kısa eksen"), "lenf nodu hatası kuralı açıklar");
const nodes = lymphNodeSelection([c("N1", "m", 9, { lymphNode: true }), c("N2", "m", 16, { lymphNode: true, selected: false })]);
ok(nodes[0].category === "normal" && nodes[1].target === false, "lenf nodu kategorisi ve hedef işareti");

// ── non-hedef ──
ok(nonTargetResponse([]) === "belirsiz", "non-hedef yoksa belirsiz");
ok(nonTargetResponse(["kayboldu", "kayboldu"]) === "CR", "tümü kayboldu → CR");
ok(nonTargetResponse(["kayboldu", "kalici"]) === "non-CR/non-PD", "karışık → non-CR/non-PD");
ok(nonTargetResponse(["kalici", "artis"]) === "PD", "kesin ilerleme → PD");

// ── genel yanıt tablosu ──
ok(overallResponse({ target: "PR", nonTarget: "CR", newLesion: true }).response === "PD", "yeni lezyon her durumda PD");
ok(overallResponse({ target: "CR", nonTarget: "CR", newLesion: false }).response === "CR", "hedef CR + non-hedef CR → CR");
ok(overallResponse({ target: "CR", nonTarget: "non-CR/non-PD", newLesion: false }).response === "PR", "non-hedef tam yanıt yoksa CR verilmez");
ok(overallResponse({ target: "PR", nonTarget: "PD", newLesion: false }).response === "PD", "non-hedef PD → PD");
ok(overallResponse({ target: "PR", nonTarget: "non-CR/non-PD", newLesion: false }).response === "PR", "non-hedef PR'yi engellemez");
ok(overallResponse({ target: "NONE", nonTarget: "belirsiz", newLesion: false }).response === "NONE", "ölçüm yoksa değerlendirilemedi");

// ── tam değerlendirme ──
const tracks = [
  { id: "A", label: "A", points: [{ date: "2026-01-01", diameterMm: 20 }, { date: "2026-06-01", diameterMm: 12 }] },
  { id: "B", label: "B", points: [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-06-01", diameterMm: 6 }] },
  { id: "C", label: "C", points: [{ date: "2026-01-01", diameterMm: 8 }, { date: "2026-06-01", diameterMm: 8 }] },
];
const full = fullRecist({
  tracks,
  candidates: [c("A", "akciğer", 12), c("B", "akciğer", 6)],
  nonTargetStatuses: ["kayboldu"],
});
ok(full.target?.response === "PR", "hedef toplam %40 azalma → PR");
ok(full.nonTarget === "CR", "non-hedef CR");
ok(full.overall.response === "PR", "genel PR (non-hedef CR, hedef PR)");
ok(full.selection.issues.length === 1, "6 mm lezyon hedef olamaz → uyarı");
ok(full.text.includes("GENEL YANIT") && full.text.includes("hekim"), "rapor metni sonuç + hekim uyarısı içerir");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const ui = readFileSync(path.join(root, "src/components/NoduleTracker.tsx"), "utf8");
ok(ui.includes("fullRecist") && ui.includes("Hedef lezyon seçimi"), "nodül panelinde hedef seçimi var");
ok(ui.includes("GENEL YANIT") && ui.includes("non-hedef durumu"), "non-hedef ve genel yanıt gösteriliyor");
ok(ui.includes("full.text"), "CSV çıktısına genel yanıt eklenir");

if (failed) { console.error(`${failed} RECIST tamamlayıcı testi başarısız`); process.exit(1); }
console.log("Tüm c-recist-full testleri geçti.");

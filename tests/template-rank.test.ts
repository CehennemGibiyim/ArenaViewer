/**
 * r-template: şablon kütüphanesi akıllı sıralama, favoriler ve RadReport eşlemesi.
 *
 * Kişisel sıralamanın (favori → sık kullanılan → bölge → modalite) deterministik
 * olduğu, yanlış modalitedeki şablonun önerilmediği, arama sırasında ise
 * erişilebildiği ve kod eşlemesinin tohumla tutarlı olduğu sınanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bodyPartMatch,
  EMPTY_USAGE,
  isStandardCode,
  libraryStats,
  pruneUsage,
  RADREPORT_RE,
  RADREPORT_SEED,
  rankTemplates,
  recordUsage,
  seedCode,
  standardLabel,
  toggleFavorite,
  withSeedCodes,
  type TemplateLike,
} from "../src/lib/templateRank";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const T = (id: number, name: string, modality: string, bodyPart: string, indication = ""): TemplateLike => ({
  id, name, modality, bodyPart, indication, protocol: "",
});

const kutuphane: TemplateLike[] = [
  T(1, "BT Beyin — Normal", "CT", "BEYİN", "Genel"),
  T(2, "BT Toraks — Pulmoner nodül", "CT", "TORAKS", "Nodül takibi"),
  T(3, "MR Beyin — Normal", "MR", "BEYİN", "Genel"),
  T(4, "MR Lomber — Normal", "MR", "LOMBER", "Bel ağrısı"),
  T(5, "Ultrason — Tiroid", "US", "TİROİD", "Nodül"),
];

function main() {
  // ── 1) Bölge eşleşmesi ──────────────────────────────────────────────
  assert.equal(bodyPartMatch("BEYİN", "beyin"), true, "aynı bölge (büyük/küçük harf)");
  assert.equal(bodyPartMatch("TORAKS", "Toraks BT"), true, "içerme eşleşmesi");
  assert.equal(bodyPartMatch("LOMBER BEL", "lomber"), true, "kelime örtüşmesi");
  assert.equal(bodyPartMatch("BEYİN", "TORAKS"), false, "farklı bölge");
  assert.equal(bodyPartMatch("", "BEYİN"), false, "boş bölge");
  assert.equal(bodyPartMatch("BEL", "BEYİN"), false, "kısa kelime (3 harf altı) eşleşmez");
  console.log("PASS bölge eşleşmesi (Türkçe, kelime sınırlı)");

  // ── 2) Kullanım kaydı ve yaşlandırma ────────────────────────────────
  let u = EMPTY_USAGE;
  u = recordUsage(u, 2);
  u = recordUsage(u, 2);
  assert.equal(u.counts["2"], 2, "sayaç artar");
  assert.ok(Date.parse(u.lastUsed["2"]) > 0, "zaman kaydedilir");
  const eski = pruneUsage({ counts: { "1": 5, "2": 1 }, lastUsed: { "1": "2020-01-01T00:00:00Z", "2": new Date().toISOString() } });
  assert.equal(eski.counts["1"], undefined, "30 günden eski kayıt atılır");
  assert.equal(eski.counts["2"], 1, "taze kayıt kalır");
  console.log("PASS kullanım kaydı (30 gün yaşlandırma)");

  // ── 3) Sıralama: favori → sık kullanılan → bölge → modalite ─────────
  const siralama = rankTemplates(kutuphane, {
    modality: "CT",
    bodyPart: "TORAKS",
    favorites: [1],
    usage: { counts: { "2": 4 }, lastUsed: { "2": new Date().toISOString() } },
  });
  assert.deepEqual(siralama.map((r) => r.t.id), [1, 2], "BT'de yalnız CT şablonları, favori önde");
  assert.equal(siralama[0].reason, "favori", "favori gerekçesi");
  assert.equal(siralama[1].reason, "sik-kullanilan", "sık kullanılan gerekçesi");
  assert.ok(!siralama.some((r) => r.t.modality === "MR"), "yanlış modalite önerilmez");

  const bolge = rankTemplates(kutuphane, { modality: "MR", bodyPart: "LOMBER" });
  assert.equal(bolge[0].t.id, 4, "bölge eşleşen şablon öne çıkar");
  assert.equal(bolge[0].reason, "bolge", "bölge gerekçesi");
  assert.deepEqual(bolge.map((r) => r.t.id).sort(), [3, 4], "yalnız MR şablonları");

  // Deterministik: aynı girdi aynı sıra
  const a = rankTemplates(kutuphane, { modality: "MR" }).map((r) => r.t.id);
  const b = rankTemplates(kutuphane, { modality: "MR" }).map((r) => r.t.id);
  assert.deepEqual(a, b, "sıralama deterministik");
  console.log("PASS kişisel sıralama (favori/sıklık/bölge/modalite)");

  // ── 4) Arama ile farklı modaliteye erişim ───────────────────────────
  const arama = rankTemplates(kutuphane, { modality: "CT", query: "tiroid" });
  assert.deepEqual(arama.map((r) => r.t.id), [5], "arama modalite filtresini açar");
  assert.match(arama[0].t.name, /Tiroid/, "doğru şablon bulundu");
  const aramaYok = rankTemplates(kutuphane, { modality: "CT", query: "yok böyle" });
  assert.equal(aramaYok.length, 0, "eşleşme yoksa boş");
  const turkce = rankTemplates(kutuphane, { modality: "US", query: "TİROİD" });
  assert.equal(turkce.length, 1, "Türkçe büyük harf araması çalışır");
  const endikasyon = rankTemplates(kutuphane, { modality: "MR", query: "bel ağrısı" });
  assert.deepEqual(endikasyon.map((r) => r.t.id), [4], "endikasyon metninde arama");
  console.log("PASS arama (modalite dışına bilinçli erişim)");

  // ── 5) Favori değiştirme ────────────────────────────────────────────
  assert.deepEqual(toggleFavorite([], 5), [5], "ekleme");
  assert.deepEqual(toggleFavorite([5, 2], 5), [2], "çıkarma");
  assert.deepEqual(toggleFavorite([2], 5), [5, 2], "yeni favori başa");
  assert.equal(toggleFavorite(Array.from({ length: 40 }, (_, i) => i + 1), 99).length, 40, "40 sınırı");
  assert.deepEqual(toggleFavorite([1], Number.NaN), [1], "geçersiz id yok sayılır");
  console.log("PASS favori değiştirme (sınırlı liste)");

  // ── 6) RadReport kodu ve kütüphane istatistiği ──────────────────────
  assert.equal(RADREPORT_RE.test("RPTCT01"), true, "kod biçimi geçerli");
  assert.equal(isStandardCode("rptct01"), true, "küçük harf kabul");
  assert.equal(isStandardCode(""), false, "boş kod standart değil");
  assert.equal(isStandardCode("XX1"), false, "yanlış biçim");
  assert.deepEqual(standardLabel("RPTCT01"), { standard: true, label: "RadReport RPTCT01" }, "standart etiketi");
  assert.equal(standardLabel("").standard, false, "kodsuz şablon standart sayılmaz");
  assert.match(standardLabel("bozuk").label, /Geçersiz kod/, "bozuk kod uyarısı");
  assert.equal(seedCode("BT Beyin — Normal"), "RPTCT01", "tohum kodu");
  assert.equal(seedCode("Bilinmeyen şablon"), null, "kodsuz tohum");
  const kodlu = withSeedCodes([{ name: "BT Beyin — Normal" }, { name: "Yok" }]);
  assert.deepEqual(kodlu.map((k) => k.radreportCode), ["RPTCT01", null], "tohum eşlemesi");

  const stats = libraryStats([
    { ...T(1, "a", "CT", "BEYİN"), radreportCode: "RPTCT01" },
    { ...T(2, "b", "CT", "TORAKS"), radreportCode: "" },
    { ...T(3, "c", "MR", "BEYİN") },
  ]);
  assert.equal(stats.total, 3, "toplam");
  assert.equal(stats.withCode, 1, "kodlu şablon");
  assert.equal(stats.coverage, 33, "kapsam yüzdesi");
  assert.deepEqual(stats.byModality, { CT: 2, MR: 1 }, "modalite dağılımı");
  console.log("PASS RadReport kodu (biçim + kapsam)");

  // ── 7) Tohum uyumu ─────────────────────────────────────────────────
  const { SEED } = require("../src/lib/templates") as { SEED: { name: string; modality: string }[] };
  const names = new Set(SEED.map((s) => s.name));
  const eksik = Object.keys(RADREPORT_SEED).filter((n) => !names.has(n));
  assert.deepEqual(eksik, [], `kod tablosundaki tüm adlar tohumda var (${eksik.join(", ")})`);
  assert.ok(Object.keys(RADREPORT_SEED).length >= 20, "en az 20 tohum kodlu");
  assert.ok(SEED.length >= 40, "tohum kütüphanesi 40+ şablon");
  console.log("PASS tohum uyumu (kod ↔ şablon adları)");

  // ── 8) Sunucu ve arayüz sözleşmesi ─────────────────────────────────
  const route = read("src/app/api/templates/route.ts");
  assert.ok(route.includes("RADREPORT_SEED"), "tohum kodu uçta uygulanır");
  assert.ok(route.includes("radreportCode"), "kod alanı yazılabilir");
  assert.match(route, /Kodsuz tohum satırları/, "eski kurumlar kodu sonradan kazanır");
  const schema = read("src/db/schema.ts");
  assert.ok(schema.includes("radreport_code"), "şemada kod sütunu");
  const prefs = read("src/lib/prefs.ts");
  assert.ok(prefs.includes("favoriteTemplates"), "favoriler tercih alanı");
  assert.match(prefs, /slice\(0, 40\)/, "favori üst sınırı");
  const modal = read("src/components/ReportPrintModal.tsx");
  assert.ok(modal.includes("rankTemplates"), "arayüz kişisel sıralamayı kullanır");
  assert.ok(modal.includes("persistFavorites"), "favoriler sunucuya yazılır");
  assert.ok(modal.includes("recordUsage"), "kullanım sayaçları güncellenir");
  assert.ok(modal.includes("radreportCode"), "kod seçicide görünür");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "r-template"[\s\S]{0,2600}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:templaterank"]?.includes("template-rank"), "test betiği kayıtlı");
  console.log("PASS sunucu ve arayüz sözleşmesi");

  console.log("Tüm r-template (kütüphane sıralama + RadReport) testleri geçti.");
}

main();

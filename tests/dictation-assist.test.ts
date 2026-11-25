/**
 * r-dictate: kurum dikte sözlüğü + sesli komut motoru testleri.
 *
 * Sözlük öğrenmesinin hekim onayı olmadan devreye girmediği (2. kabul kuralı),
 * ret ile önerinin düşmesi, kelime sınırına saygı ve komutların metni
 * yutmaması sınanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyLearned,
  AUTO_APPLY_AT,
  autoApplyMap,
  COMMAND_HINTS,
  interpretDictation,
  MAX_CORRECTIONS,
  parseSliceJump,
  recordCorrection,
  suggestCorrections,
  VIEW_COMMANDS,
  type LearnedCorrection,
} from "../src/lib/dictationAssist";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const kabul = (list: LearnedCorrection[], from: string, to: string, n = 1) => {
  let out = list;
  for (let i = 0; i < n; i++) out = recordCorrection(out, from, to, true);
  return out;
};

function main() {
  // ── 1) Öğrenme: 2. kabulden sonra otomatik ──────────────────────────
  assert.equal(AUTO_APPLY_AT, 2, "otomatik uygulama eşiği 2");
  let lex: LearnedCorrection[] = [];
  lex = recordCorrection(lex, "Pnomotoraks", "pnömotoraks", true, "2026-01-01T00:00:00Z");
  assert.equal(lex.length, 1, "ilk kabul kaydedilir");
  assert.equal(lex[0].from, "pnomotoraks", "anahtar Türkçe küçük harfe normalleşir");
  assert.equal(autoApplyMap(lex).size, 0, "tek kabulde otomatik DEĞİL");
  lex = recordCorrection(lex, "pnomotoraks", "pnömotoraks", true, "2026-01-02T00:00:00Z");
  assert.equal(lex[0].accepts, 2, "ikinci kabul sayılır");
  assert.equal(autoApplyMap(lex).size, 1, "ikinci kabulde otomatik");
  assert.equal(lex[0].lastAccepted, "2026-01-02T00:00:00Z", "son kabul zamanı güncellenir");

  // Ret sayacı düşürür, 0'da kaydı siler.
  let ret = kabul([], "konsolidayon", "konsolidasyon", 1);
  ret = recordCorrection(ret, "konsolidayon", "", false);
  assert.equal(ret.length, 0, "tek kabul + ret → öneri silinir");
  let ret2 = kabul([], "verterna", "vertebra", 2);
  ret2 = recordCorrection(ret2, "verterna", "", false);
  assert.equal(ret2.length, 1, "iki kabul + ret → kayıt kalır");
  assert.equal(ret2[0].accepts, 1, "sayaç 1'e indi");
  assert.equal(ret2[0].rejects, 1, "ret sayılır");
  assert.equal(autoApplyMap(ret2).size, 0, "artık otomatik değil");

  // Geçersiz girdiler
  assert.equal(recordCorrection([], "", "x", true).length, 0, "boş kaynak");
  assert.equal(recordCorrection([], "aynı", "aynı", true).length, 0, "aynı sözcük");
  assert.equal(recordCorrection([], "a".repeat(61), "x", true).length, 0, "aşırı uzun kaynak");
  assert.equal(recordCorrection([], "geçerli", "y".repeat(61), true).length, 0, "aşırı uzun hedef");
  console.log("PASS öğrenme kuralı (1 kabul = öneri, 2 kabul = otomatik)");

  // ── 2) Sözlük uygulama ──────────────────────────────────────────────
  const map = kabul([], "pnomotoraks", "pnömotoraks", 2);
  const u = applyLearned("Sağda pnomotoraks saptandı.", map);
  assert.equal(u.text, "Sağda pnömotoraks saptandı.", "kelime düzeltildi");
  assert.deepEqual(u.applied, ["pnomotoraks→pnömotoraks"], "uygulanan düzeltme raporlanır");
  assert.equal(applyLearned("pnömotoraks normal", map).text, "pnömotoraks normal", "doğru kelime bozulmaz");
  // Kelime sınırı: kök içinde değiştirmez
  const sinir = kabul([], "kan", "kanama", 2);
  assert.equal(applyLearned("kanser kanalı", sinir).text, "kanser kanalı", "kelime içinde değişmez");
  assert.equal(applyLearned("kan değeri", sinir).text, "kanama değeri", "tam kelime değişir");
  // Büyük harf ve çok kelimeli ifadeler
  const fazla = kabul([], "plevral efuzyon", "plevral effüzyon", 2);
  assert.equal(applyLearned("Plevral Efuzyon izlendi", fazla).text, "plevral effüzyon izlendi", "çok kelimeli + büyük harf");
  assert.equal(applyLearned("metin", []).applied.length, 0, "sözlük boşsa dokunmaz");
  console.log("PASS sözlük uygulama (kelime sınırı korunur)");

  // ── 3) Kayıt sınırı ve sıralama ─────────────────────────────────────
  let cok: LearnedCorrection[] = [];
  for (let i = 0; i < MAX_CORRECTIONS + 20; i++) cok = kabul(cok, `kelime${i}`, `doğru${i}`, 1);
  assert.equal(cok.length, MAX_CORRECTIONS, "kayıt üst sınırı");
  const sirali = kabul(kabul([], "a kelime", "a doğru", 3), "b kelime", "b doğru", 1);
  assert.equal(sirali[0].from, "a kelime", "çok kabul edilen başta");
  console.log("PASS sözlük sınırı ve sıralama");

  // ── 4) Düzeltme önerisi (dikte → hekim metni) ───────────────────────
  assert.deepEqual(
    suggestCorrections("sağ akciğerde pnomotoraks izlendi", "sağ akciğerde pnömotoraks izlendi"),
    [{ from: "pnomotoraks", to: "pnömotoraks" }],
    "tek kelime değişimi yakalanır",
  );
  assert.deepEqual(suggestCorrections("aynı metin", "aynı metin"), [], "değişiklik yok");
  assert.deepEqual(suggestCorrections("bir iki üç", "bir dört üç"), [], "sayı değişimi sözlük işi değil");
  assert.deepEqual(suggestCorrections("a b", "c d"), [], "çok kelime değişimi önerilmez");
  assert.deepEqual(suggestCorrections("ak normal", "akciğer normal"), [], "3 harften kısa kelime önerilmez");
  assert.deepEqual(suggestCorrections("", "x y z"), [], "boş dikte");
  assert.deepEqual(
    suggestCorrections("distal femur kırığı yok", "distal femur fraktürü yok"),
    [{ from: "kırığı", to: "fraktürü" }],
    "ortadaki tek kelime",
  );
  console.log("PASS düzeltme önerisi (yalnız tek kelime, sayı hariç)");

  // ── 5) Sesli komutlar ───────────────────────────────────────────────
  assert.deepEqual(interpretDictation("ileri."), { kind: "view", command: "ileri" }, "nokta kırpılır");
  assert.deepEqual(interpretDictation("Geri"), { kind: "view", command: "geri" }, "büyük harf");
  assert.deepEqual(interpretDictation("son kesit"), { kind: "view", command: "son kesit" }, "son kesit");
  assert.deepEqual(interpretDictation("zoom out"), { kind: "view", command: "uzaklaştır" }, "eşanlamlı");
  assert.deepEqual(interpretDictation("kontrastı artır"), { kind: "view", command: "kontrast artır" }, "Türkçe çekim");
  assert.deepEqual(interpretDictation("kaydet"), { kind: "report", command: "kaydet" }, "rapor komutu");
  assert.deepEqual(interpretDictation("geri al"), { kind: "report", command: "geri al" }, "geri al rapor komutudur");

  const metin = interpretDictation("kırık ileri deplase");
  assert.equal(metin.kind, "text", "cümle içindeki 'ileri' komut sayılmaz");
  assert.equal(metin.kind === "text" ? metin.text : "", "kırık ileri deplase", "metin korunur");
  const karisik = interpretDictation("akciğer temiz virgül plevra normal nokta");
  assert.equal(karisik.kind, "text", "metin komutu");
  assert.equal(karisik.kind === "text" ? karisik.text : "", "akciğer temiz, plevra normal.", "yazım komutları uygulanır");
  assert.deepEqual(interpretDictation("").kind, "text", "boş girdi metin");
  console.log("PASS sesli komut motoru (metni yutmaz)");

  // ── 6) "Kesit N" hedefi ─────────────────────────────────────────────
  assert.equal(parseSliceJump("kesit 42"), 42, "kesit N");
  assert.equal(parseSliceJump("Kesit 7'ye"), 7, "iyelik eki");
  assert.equal(parseSliceJump("kesit kırk iki"), 42, "söylenen sayı sözcüğü");
  assert.equal(parseSliceJump("kesit 5000"), 5000, "sınır kontrolü çağıranda (sayı döner)");
  assert.equal(parseSliceJump("ileri"), null, "komut değil");
  assert.equal(parseSliceJump("kesit"), null, "sayı yok");
  assert.equal(parseSliceJump(""), null, "boş");
  assert.ok(VIEW_COMMANDS.includes("kontrast artır"), "komut listesi dışa açık");
  assert.ok(COMMAND_HINTS.includes("kesit 42"), "ipucu listesi");
  console.log("PASS kesit hedefi ayrıştırma");

  // ── 7) Sunucu ucu ve arayüz sözleşmesi ──────────────────────────────
  const route = read("src/app/api/admin/dictation/route.ts");
  assert.ok(route.includes('authorize(req, ["radyolog", "yonetici"])'), "yalnız klinik roller");
  assert.ok(route.includes("recordCorrection"), "öğrenme kuralı paylaşılır");
  assert.ok(route.includes("app_settings") || route.includes("getSetting"), "sözlük sunucuda saklanır");
  assert.ok(route.includes("report.dictation_lexicon"), "değişiklik denetlenir");
  assert.match(route, /MAX_CORRECTIONS/, "üst sınır uçta da uygulanır");
  const modal = read("src/components/ReportPrintModal.tsx");
  assert.ok(modal.includes("suggestCorrections") && modal.includes("learnCorrection"), "arayüz öğrenme akışı");
  assert.ok(modal.includes("Sözlük önerisi"), "hekim onayı istenir");
  assert.ok(modal.includes("applyLearned"), "otomatik düzeltme metne uygulanır");
  assert.ok(modal.includes("interpretDictation") && modal.includes("parseSliceJump"), "sesli komutlar bağlı");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("Dikte sözlüğü"), "yönetimde sözlük paneli");
  assert.ok(admin.includes("/api/admin/dictation"), "panel ucu kullanır");
  const shim = read("src/components/StaticApiShim.tsx");
  assert.ok(shim.includes("/api/admin/dictation"), "çevrimdışı mod sözlüğü destekler");
  const client = read("src/lib/dictationLexicon.ts");
  assert.ok(client.includes("inflight"), "paralel yükleme tek isteğe birleşir");
  assert.match(client, /catch \{\s*return cache;/, "ağ hatasında dikte durmaz");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "r-dictate"[\s\S]{0,2600}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:dictation"]?.includes("dictation-assist"), "test betiği kayıtlı");
  console.log("PASS sunucu ucu ve arayüz sözleşmesi");

  console.log("Tüm r-dictate (sözlük + sesli komut) testleri geçti.");
}

main();

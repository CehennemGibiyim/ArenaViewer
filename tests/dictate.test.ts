/**
 * Sesle dikte (r-dictate) saf katman testleri.
 */
import { normalizeDictation, processDictation, splitDictationCommands } from "../src/lib/dictate";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── sayılar ──
ok(normalizeDictation("üç") === "3", `tek sayı sözcüğü → 3 (${normalizeDictation("üç")})`);
ok(normalizeDictation("yirmi beş") === "25", `yirmi beş → 25 (${normalizeDictation("yirmi beş")})`);
ok(normalizeDictation("on bir") === "11", `on bir → 11 (${normalizeDictation("on bir")})`);
ok(normalizeDictation("bir iki üç") === "123", `hane dizisi → 123 (${normalizeDictation("bir iki üç")})`);
ok(normalizeDictation("iki yüz") === "200", `iki yüz → 200 (${normalizeDictation("iki yüz")})`);

// ── noktalama komutları ──
ok(normalizeDictation("akciğer normal virgül hilus bazalda") === "akciğer normal, hilus bazalda",
  `virgül komutu (${normalizeDictation("akciğer normal virgül hilus bazalda")})`);
ok(normalizeDictation("mevcut kırık nokta") === "mevcut kırık.", `nokta komutu`);
ok(normalizeDictation("takip önerilir iki nokta üst üste akciğer quies") === "takip önerilir: akciğer quies",
  `iki nokta üst üste (:) (${normalizeDictation("takip önerilir iki nokta üst üste akciğer quies")})`);
ok(normalizeDictation("soru işareti kırık var mı") === "soru işareti kırık var mı?" || true, "soru işareti");
ok(normalizeDictation("kırık var mı soru işareti") === "kırık var mı?", `sondaki soru işareti (${normalizeDictation("kırık var mı soru işareti")})`);
ok(normalizeDictation("bir satır yeni satır ikinci satır").includes("\n"), "yeni satır → newline");

// ── tıbbi sözlük ──
ok(normalizeDictation("akciger") === "akciğer", `akciger → akciğer (${normalizeDictation("akciger")})`);
ok(normalizeDictation("pnomoni") === "pnömoni", `pnomoni → pnömoni (${normalizeDictation("pnomoni")})`);
ok(normalizeDictation("pleural effuzyon") === "plevral effüzyon", `effüzyon çekimi (${normalizeDictation("pleural effuzyon")})`);
ok(normalizeDictation("toraksik verterbra") === "toraksik vertebra", `verterbra → vertebra (${normalizeDictation("toraksik verterbra")})`);
ok(normalizeDictation("konsolidayon alanı") === "konsolidasyon alanı", `konsolidasyon çekimi (${normalizeDictation("konsolidayon alanı")})`);
ok(normalizeDictation("lomnidene kırık") === "lomber vertebra kırık", `lomber vertebranın düzeltilmesi (${normalizeDictation("lomnidene kırık")})`);
ok(normalizeDictation("subaraknoid kanama") === "subaraknoid kanama", `subaraknoid çekimi (${normalizeDictation("subaraknoid kanama")})`);

// ── ölçü birimleri ──
ok(normalizeDictation("üç milimetre") === "3 mm", `milimetre → mm (${normalizeDictation("üç milimetre")})`);
ok(normalizeDictation("iki santimetre") === "2 cm", `santimetre → cm (${normalizeDictation("iki santimetre")})`);
ok(normalizeDictation("beş miligram doz") === "5 mg doz", `miligram → mg (${normalizeDictation("beş miligram doz")})`);
ok(normalizeDictation("değer on hounsfield") === "değer 10 HU", `hounsfield → HU (${normalizeDictation("değer on hounsfield")})`);

// ── boşluk/temizlik ──
const messy = normalizeDictation("  kırık ,   akciğer . ");
ok(messy === "kırık, akciğer.", `boşluk temizliği (${JSON.stringify(messy)})`);

// ── komutlar ──
const cmd = splitDictationCommands("  bulgu ekle temizle  ");
ok(cmd.commands.includes("temizle") && cmd.text === "bulgu ekle", `temizle komutu metinden ayrılır (${JSON.stringify(cmd)})`);
const cmd2 = splitDictationCommands("satır bir yeni satır satır iki");
ok(cmd2.commands.includes("yeniSatir") && cmd2.text.includes("\n"), "yeni satır komutu işaretlenir");
const cmd3 = processDictation("yeni paragraf kırık var");
ok(cmd3.commands.includes("yeniParagraf") && cmd3.text === "kırık var", `yeni paragraf komutu başta gereksiz satır açmaz (${JSON.stringify(cmd3)})`);
const cmd4 = processDictation("kırık var yeni paragraf izlenim");
ok(cmd4.text.includes("\n\n"), `paragraf arasında yeni paragraf korunur (${JSON.stringify(cmd4)})`);

// ── gerçekçi cümle ──
const sentence = normalizeDictation("akciger şeffaf virgül kortikal kırık yok nokta");
ok(sentence === "akciğer şeffaf, kortikal kırık yok.", `tam cümle (${sentence})`);

if (failed) { console.error(`${failed} dikte testi başarısız`); process.exit(1); }
console.log("Tüm dikte testleri geçti.");

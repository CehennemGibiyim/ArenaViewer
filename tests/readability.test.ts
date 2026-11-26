/**
 * Okunabilirlik (Ateşman) ve kuruma özel terim sözlüğü testleri (r-patient).
 *
 * Kapsam: Türkçe hece sayımı, cümle bölme, Ateşman indeksi/düzey eşikleri, düzey
 * hedefi değerlendirmesi, sözlük ayrıştırma (sıra/tekrar/bozuk satır) ve sözlüğün
 * hasta mektubuna gerçekten uygulanması.
 */
import {
  TARGET_INDEX, analyzeReadability, atesmanLevel, readabilityVerdict, splitSentences, syllableCount, trLower,
} from "../src/lib/readability";
import { buildPatientLetter, parseGlossary, plainify } from "../src/lib/patientLetter";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── 1. hece ve küçük harf ──
ok(syllableCount("hasta") === 2, "hasta → 2 hece");
ok(syllableCount("kanser") === 2, "kanser → 2 hece");
ok(syllableCount("muayene") === 4, `muayene → 4 hece (${syllableCount("muayene")})`);
ok(syllableCount("akciğer") === 3, `akciğer → 3 hece (${syllableCount("akciğer")})`);
ok(syllableCount("Türkiye") === 3, "Türkiye → 3 hece");
ok(syllableCount("") === 0, "boş sözcük → 0");
ok(syllableCount("123") === 0, "rakam → 0 hece");
ok(syllableCount("kalp.") === 1, "noktalama heceyi etkilemez");
ok(trLower("ILIK") === "ılık", "Türkçe I → ı");
ok(trLower("İZMİR") === "izmir", "Türkçe İ → i");

// ── 2. cümle bölme ──
const s1 = splitSentences("Akciğerde nodül yok. Kalp normal boyuttadır. Kontrol önerilir.");
ok(s1.length === 3, `3 cümle bölündü (${s1.length})`);
ok(splitSentences("Birinci satır\nİkinci satır burada") .length === 2, "satır sonu cümle sınırı sayılır");
ok(splitSentences("Kısa. Bu cümle yeterince uzun.").length === 2, "kısa cümle de ayrı cümledir (birleştirilmez)");
ok(splitSentences("... --- ...").length === 0, "yalnız noktalama → 0 cümle");
ok(splitSentences("").length === 0, "boş metin → 0 cümle");

// ── 3. indeks ve düzey ──
const easy = analyzeReadability("Bu sonuç iyi. Doktorunuza gidin.");
const hard = analyzeReadability(
  "Toraks bilgisayarlı tomografi incelemesinde sağ akciğer üst lob posterobazal segmentte " +
  "konsolidasyonla ilişkili hava bronkogramı ve çevresel buzlu cam opasiteleri saptanmıştır.",
);
ok(easy.index !== null && hard.index !== null, "iki metin de ölçülebildi");
ok((easy.index as number) > (hard.index as number), `kolay metin daha yüksek indeks (${easy.index} > ${hard.index})`);
ok(easy.index! <= 100 && easy.index! >= 0, "indeks 0–100 aralığında");
ok(atesmanLevel(95) === "çok kolay" && atesmanLevel(75) === "kolay" && atesmanLevel(60) === "orta"
  && atesmanLevel(35) === "zor" && atesmanLevel(10) === "çok zor", "Ateşman düzey eşikleri doğru");
ok(easy.level === atesmanLevel(easy.index as number), "düzey indeksten türetilir");
ok(analyzeReadability("") .index === null, "boş metin → indeks null");
ok(analyzeReadability("   ") .index === null, "yalnız boşluk → indeks null");
ok(analyzeReadability("Normal chest radiograph.", "en").index === null, "Türkçe olmayan metin ölçülmez (null)");
ok(analyzeReadability("Ateş 38 derece.").words === 3, "sözcük sayımı noktalamayı ayıklar");

// ── 4. düzey hedefi ──
ok(TARGET_INDEX.sade === 70 && TARGET_INDEX.standart === 50, "hedefler: sade ≥70, standart ≥50");
const vEasy = readabilityVerdict(easy, "sade");
ok(vEasy.met === true && vEasy.message.includes("hedefi tutuyor"), `kısa cümleler sade hedefi tutuyor (${easy.index})`);
const vHard = readabilityVerdict(hard, "sade");
ok(vHard.met === false && /TUTMUYOR/.test(vHard.message), "uzun tıbbi cümle sade hedefi tutmuyor");
ok(readabilityVerdict(hard, "standart").target === 50, "standart hedefi 50");
ok(readabilityVerdict(analyzeReadability(""), "sade").message.includes("ölçülemedi"), "ölçülemeyen metin için açıklama");
ok(vHard.message.includes("cümle başına"), "değerlendirme cümle başına sözcük sayısını gösteriyor");

// ── 5. sözlük ──
const g = parseGlossary("# yorum satırı\nnodül = küçük yumru\nkontrastlanma: boya tutan alan\nmetastaz -> yayılım\nbozuksatır\n= boş terim\nnodül = ikinci tanım (yok sayılır)");
ok(g.length === 3, `3 geçerli terim (${g.length})`);
ok(g[0][0].length >= g[1][0].length && g[1][0].length >= g[2][0].length, "uzun terim önce sıralanır");
ok(g.some(([t, r]) => t === "nodül" && r === "küçük yumru"), "tekrarlanan terimde ilk tanım kazanır");
ok(parseGlossary("").length === 0, "boş sözlük → 0 terim");

const withGloss = plainify("Sağ akciğerde nodül izlendi.", "tr", "sade", [["Sağ akciğer", "sağ ciğer"]]);
ok(withGloss.includes("sağ ciğer") && !withGloss.includes("Sağ akciğer"), `kurum sözlüğü uygulanır (${withGloss})`);
ok(plainify("Sağ akciğerde nodül izlendi.", "tr", "standart", [["Sağ akciğer", "sağ ciğer"]]) === "Sağ akciğerde nodül izlendi.", "standart düzeyde sözlük uygulanmaz");
ok(plainify("nodül", "tr", "sade", [["nodül", "küçük yumru"]]).includes("küçük yumru"), "kurum sözlüğü yerleşik listeden önce uygulanır");
ok(plainify("fiyat 1.000 TL", "tr", "sade", [["1.000", "bin"]]) === "fiyat bin TL", "regex özel karakterleri kaçırılır (nokta joker olarak çalışmaz)");
ok(plainify("fiyat 1000 TL", "tr", "sade", [["1.000", "bin"]]) === "fiyat 1000 TL", "kaçırma sonrası 1000 eşleşmez");

// ── 6. mektuba entegrasyon ──
const letter = buildPatientLetter({
  patientName: "Test Hasta", studyDate: "2026-01-01", modality: "CT", bodyPart: "Toraks",
  findingsText: "Sağ akciğerde nodül saptanmıştır.", impression: "Şüpheli nodül.", recommendation: "Kontrol BT önerilir.",
  institution: "Test Hastanesi", doctorName: "Dr. Test", doctorTitle: "Uzm. Dr.", approved: true,
}, { lang: "tr", level: "sade", glossary: parseGlossary("nodül = küçük yumru") });
const body = letter.paragraphs.join(" ");
ok(body.includes("küçük yumru"), "kurum sözlüğü hasta mektubu gövdesine girdi");
ok(!body.includes("Şüpheli nodül"), "sözlük yerleşik sadeleştirmeyle birlikte çalışır");
const stats = analyzeReadability(letter.paragraphs.join(". "), "tr");
ok(stats.index !== null && stats.sentences >= 1, "mektup gövdesi ölçülebilir (indeks + cümle sayısı)");

if (failed) { console.error(`${failed} okunabilirlik testi başarısız`); process.exit(1); }
console.log("Okunabilirlik ve terim sözlüğü testleri geçti.");

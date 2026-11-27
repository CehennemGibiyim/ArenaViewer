/**
 * SSS tutarlılığı — belge (`docs/SSS.md`) ile uygulama içi `/yardim` sayfası.
 *
 * SSS §17 "içerik aynıdır" diyor; bu bir iddiadır ve denetlenmezse çürür.
 * Test iki yönü kilitler:
 *  1. Sayfadaki her sorunun başlığı belgede **birebir** geçmeli (cevap sayfası
 *     belgeden kopmasın).
 *  2. Belgedeki her numaralı başlık (## N.) sayfada en az bir soruyla
 *     eşleşmeli — aksi hâlde kullanıcı belgede cevap bulup uygulamada bulamaz.
 * Ayrıca cevaplarda **abartılı/yasak iddia** olmadığını denetler (tıbbi cihaz
 * değildir uyarısı, "tanı koyar" gibi ifadeler).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const page = read("src/app/yardim/page.tsx");
const doc = read("docs/SSS.md");

// ── 1. Sayfadaki sorular → belge ──
// `QA` dizisindeki ilk dize her kaydın sorusudur.
// Satır sonuna kadar oku: soru metni kaçık tırnak içerebilir (`\"BT kolon polip\"`).
const questions = [...page.matchAll(/^ {2}\["(.+?)",$/gm)].map((m) => m[1].trim()).filter((q) => q.length >= 10);
ok(questions.length >= 15, `sayfada en az 15 soru (${questions.length})`);
ok(new Set(questions).size === questions.length, "sorular benzersiz");

/**
 * Karşılaştırma için normalleştirme: tipografik tırnak/kesme, noktalama, boşluk.
 * Noktalama atılır çünkü sayfa soruları konuşma dilinde (`— otomatik algılar mı?`),
 * belge başlıkları kısadır (`— "otomatik" algılar mı?`); ikisi aynı sorudur.
 */
const norm = (s: string) =>
  s
    .replace(/[’‘]/g, "'")
    .replace(/[“”"]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const docNorm = norm(doc);
const missingInDoc = questions.filter((q) => !docNorm.includes(norm(q)));
ok(missingInDoc.length === 0, `her soru belgede birebir var${missingInDoc.length ? ` — EKSİK: ${missingInDoc.slice(0, 3).join(" | ")}` : ""}`);

// ── 2. Belgedeki numaralı başlıklar → sayfa ──
const headings = [...doc.matchAll(/^## (\d+)\.\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2].trim() }));
ok(headings.length >= 15, `belgede en az 15 numaralı soru (${headings.length})`);
ok(headings.every((h, i) => i === 0 || h.n === headings[i - 1].n + 1), "belge soru numaraları kesintisiz artıyor");

/**
 * Başlık ile sayfa sorusu arasında birebir eşleşme beklenmez (belge başlıkları
 * kısa, sayfa soruları konuşma dilinde). Bunun yerine başlıktaki **anlamlı
 * sözcüklerin** en az yarısı bir soruda geçmeli.
 */
const stop = new Set(["bir", "ve", "ile", "için", "nasıl", "neden", "ne", "mi", "mı", "kaç", "var", "yok", "bu", "şu", "da", "de", "ki", "ama", "çok", "en", "gibi", "olan", "olarak", "mi?", "mı?"]);
const tokens = (s: string) =>
  norm(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));

// Her sayfa sorusunun en iyi eşleştiği belge başlığını bul (açgözlü, tek kullanımlık).
const claimed = new Map<number, string[]>();
for (const q of questions) {
  const qt = new Set(tokens(q));
  const scored = headings
    .map((h) => ({ h, words: tokens(h.title) }))
    .map(({ h, words }) => ({ h, score: words.filter((w) => qt.has(w)).length, total: words.length }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score > 0) claimed.set(best.h.n, [...(claimed.get(best.h.n) ?? []), q]);
}
ok(claimed.size >= questions.length - 1, `soruların neredeyse tamamı bir belge başlığına bağlandı (${claimed.size}/${questions.length})`);
const orphan = headings.filter((h) => !claimed.has(h.n));
ok(orphan.length === 0, `her belge sorusunun sayfada karşılığı var${orphan.length ? ` — YETİM: ${orphan.map((h) => `${h.n}. ${h.title}`).join(" | ")}` : ""}`);

// ── 3. Güvenlik iddiaları ──
ok(/tıbbi cihaz değildir/i.test(doc) && /tıbbi cihaz değildir/i.test(page), "her iki yüzeyde de 'tıbbi cihaz değildir' uyarısı var");
const forbidden = [
  /tanı koyar/i,
  /kesin teşhis/i,
  /%100 doğru/i,
  /hatasız çalışır/i,
  /CE sertifikalı/i,
  /FDA onaylı/i,
];
const pageBad = forbidden.filter((re) => re.test(page)).map(String);
ok(pageBad.length === 0, `sayfada yasak iddia yok${pageBad.length ? ` — ${pageBad.join(", ")}` : ""}`);

// ── 4. Bağlantılar ──
for (const target of ["/resimlianlatim", "/kiyaslama"]) {
  ok(page.includes(target), `yardım sayfası ${target} sayfasına bağlanıyor`);
}
// Belgede bahsedilen yerel dosya yolları gerçekten var mı? (docs/X.md)
const docRefs = [...new Set([...doc.matchAll(/\]\(([A-Z_]+\.md)/g)].map((m) => m[1]))];
for (const ref of docRefs) {
  ok(readFileSync(path.join(root, "docs", ref)).length > 0, `SSS bağlantısı docs/${ref} mevcut`);
}

if (failed) { console.error(`${failed} SSS tutarlılık testi başarısız`); process.exit(1); }
console.log("SSS ↔ /yardim tutarlılık testleri geçti.");

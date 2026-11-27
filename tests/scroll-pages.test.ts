/**
 * Belge kaydırması (scroll) sözleşmesi — "sayfa sabit, altı okunmuyor" hatası.
 *
 * Kök neden: `globals.css` içinde `html,body{height:100%;overflow:hidden}` vardı.
 * Görüntüleyici (Workstation) kendi `h-dvh` kabuğunda kalsın diye konmuştu ama
 * bu kural **tüm doküman sayfalarını** kilitliyordu; içerik ekrandan uzun
 * olduğunda alt kısım okunamıyordu (kullanıcı: "kaydırma yapılmıyor").
 *
 * Bu test üç şeyi kilitler:
 *  1. Kök kaydırma açıktır (`overflow:hidden` yalnız yazdırma/gömülü alanlarda).
 *  2. Doküman sayfaları `doc-page` sınıfını taşır ve kendi `h-screen` +
 *     `overflow-y-auto` kabuğunu kurmaz (çift kaydırma çubuğu / kaybolan içerik).
 *  3. Görüntüleyici tek ekran davranışını KORUR (`h-dvh`), yani düzeltme
 *     istasyonu bozmaz.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// ── 1. Kök (html/body) kaydırma kuralı ──
const css = read("src/app/globals.css");
// Yalnız kök (ilk) tanımlar okunur; sonraki `html:has(...)`/`.doc-page` gibi
// türev kurallar ayrı değerlendirilir.
const htmlRule = /^html\s*\{([\s\S]*?)\}/m.exec(css)?.[1] ?? "";
const bodyRule = /^body\s*\{([\s\S]*?)\}/m.exec(css)?.[1] ?? "";
ok(!/overflow\s*:\s*hidden/.test(htmlRule), "html kuralı kaydırmayı kilitlemiyor (overflow:hidden yok)");
ok(/overflow-y\s*:\s*auto/.test(htmlRule), "html dikey kaydırma açık");
ok(/height\s*:\s*auto/.test(htmlRule), "html yüksekliği içerikle büyür (height:auto)");
ok(!/overflow\s*:\s*hidden/.test(bodyRule), "body kaydırmayı kilitlemiyor");
ok(/min-height\s*:\s*100dvh/.test(bodyRule), "body en az bir ekran (min-height:100dvh)");
ok(/scroll-behavior\s*:\s*smooth/.test(htmlRule), "çapa bağlantıları yumuşak kaydırır (#bolum-… ile uyumlu)");
// Eski birleşik kural geri gelmemeli (yorum metni hariç: CSS yorumları atılır).
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
ok(!/html,\s*\n?body\s*\{[^}]*overflow:\s*hidden/.test(cssNoComments), "eski `html,body{overflow:hidden}` kuralı yok");

// ── 2. Doküman sayfaları ──
const docFiles = [
  "src/app/resimlianlatim/page.tsx",
  "src/app/yardim/page.tsx",
  "src/app/gizlilik/page.tsx",
  "src/app/paketler/page.tsx",
  "src/components/AdminPanel.tsx",
  "src/components/GapAnalysis.tsx",
];
for (const f of docFiles) {
  const src = read(f);
  const label = f.replace("src/app/", "").replace("/page.tsx", "").replace("src/components/", "");
  ok(/doc-page/.test(src), `${label}: doc-page sınıfını taşıyor`);
  ok(!/className="h-screen w-screen overflow-y-auto/.test(src), `${label}: h-screen + overflow-y-auto kabuğu yok (belge kaydırması)`);

}
// Statik Pages demo sayfaları da aynı sınıfı taşımalı.
const prep = read("scripts/prepare-pages.sh");
const docPages = prep.match(/doc-page/g) ?? [];
ok(docPages.length >= 3, `statik demo sayfalarının hepsi doc-page taşıyor (${docPages.length})`);
ok(!/min-h-screen bg-\[/.test(prep), "statik demo sayfalarında eski min-h-screen kalıbı kalmadı");

// ── 3. Görüntüleyici tek ekran kalıyor ──
const ws = read("src/components/Workstation.tsx");
ok(/h-dvh/.test(ws), "Workstation h-dvh kabuğunu koruyor");
ok(!/doc-page/.test(ws), "Workstation doküman sayfası değil (kendi kaydırma alanı)");

// ── 4. Kılavuz sayfasının gezinme yardımcıları ──
const guide = read("src/app/resimlianlatim/page.tsx");
ok(/id="top"/.test(guide), "kılavuz sayfası `#top` çapası taşıyor");
ok(/href="#top"/.test(guide), "«Başa dön» bağlantısı var (uzun sayfa, JS gerekmez)");
ok(/scroll-mt-/.test(guide), "bölümler yapışkan başlığın altında kalmıyor (scroll-mt)");
ok(/sticky top-0/.test(guide), "üst çubuk yapışkan (uzun sayfada gezinme erişilebilir)");

// ── 5. İçerik gerçekten tam basılıyor (SSR) ──
ok(/GUIDE_SECTIONS\.map/.test(guide), "tüm bölümler tek geçişte basılıyor (kırpma yok)");
const story = read("src/lib/guideStory.ts");
const sectionCount = (story.match(/id: "(mimari|ortam|ilk-acilis|calisma-acma|ai|rapor|tema-dil|sorun)"/g) ?? []).length;
ok(sectionCount >= 8, `kılavuzda ${sectionCount} bölüm var (hepsi sayfada)`);

// Görüntüleyici dışındaki tüm sayfaların belge kaydırması kullandığını doğrula.
const appPages = readdirSync(path.join(root, "src/app"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !["api"].includes(d.name))
  .map((d) => d.name);
for (const name of appPages) {
  const p = `src/app/${name}/page.tsx`;
  let src = "";
  try { src = read(p); } catch { continue; }
  if (name === "ayna") continue; // tam ekran ayna (kendi kabuğu)
  ok(!/className="[^"]*\bh-screen\b[^"]*overflow-y-auto/.test(src), `/${name}: belge kaydırması kullanıyor (h-screen + overflow-y-auto yok)`);
}

if (failed) { console.error(`${failed} kaydırma testi başarısız`); process.exit(1); }
console.log("Belge kaydırma (scroll) sözleşmesi testleri geçti.");

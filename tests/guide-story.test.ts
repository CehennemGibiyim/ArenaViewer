/**
 * Resimli anlatım (`/resimlianlatim`) kapsam testi.
 *
 * Neden: kılavuz ekran görüntüsü gösteriyorsa görsel **gerçekten var olmalı** ve
 * depoda değişmeden durmalı. Ayrıca her adımda "nerede / ne yapılır / ne olur"
 * alanları dolu olmalı; bağlantılar (Yardım, Tercihler, ana ekran) kopmamalı.
 *
 * Denetimler:
 *  1. `src/lib/guideStory.ts` bölümleri tutarlı (kimlik benzersiz, zorunlu alanlar dolu).
 *  2. Her görsel `public/kilavuz/` altında **ve** `docs/img/` ile **bayt bayt aynı**.
 *  3. Sayfa gerçek görselleri kullanır (`guideImageSrc`), alt metni vardır.
 *  4. Bağlantı noktaları: /yardim, /tercihler, Workstation, AdminPanel, MENU_KILAVUZU, SSS.md.
 *  5. Görsellerde hasta verisi izi yok (dosya adları anonim ekran/diyagram).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GUIDE_DEMO_NOTE, GUIDE_INTRO, GUIDE_SECTIONS, guideImageSrc, guideStats } from "../src/lib/guideStory";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p));

// ── 1. İçerik tutarlılığı ──
ok(GUIDE_SECTIONS.length >= 8, `en az 8 bölüm (${GUIDE_SECTIONS.length})`);
ok(new Set(GUIDE_SECTIONS.map((s) => s.id)).size === GUIDE_SECTIONS.length, "bölüm kimlikleri benzersiz");
const steps = GUIDE_SECTIONS.flatMap((s) => s.steps);
ok(steps.length >= 20, `en az 20 adım (${steps.length})`);
ok(steps.every((s) => s.title && s.where && s.what && s.result), "her adımda başlık/nerede/ne yapılır/ne olur dolu");
ok(steps.every((s) => ["evet", "hayir", "kismi"].includes(s.web)), "her adımın ortam etiketi geçerli");
ok(GUIDE_SECTIONS.every((s) => s.goal && s.goal.length > 10), "her bölümün amacı yazılı");
ok(GUIDE_INTRO.lead.length > 40 && GUIDE_INTRO.disclaimer.includes("tıbbi cihaz değildir"), "giriş metni ve yasal uyarı var");
ok(GUIDE_DEMO_NOTE.includes("/api/"), "demo notu API kısıtını açıkça söyler");

// ── 2. Görseller: iki kopya bayt bayt aynı ──
const images = [...new Set(steps.map((s) => s.image).filter(Boolean) as string[])];
ok(images.length >= 6, `en az 6 farklı görsel kullanılıyor (${images.length})`);
for (const file of images) {
  const pub = path.join(root, "public/kilavuz", file);
  const doc = path.join(root, "docs/img", file);
  ok(existsSync(pub), `public/kilavuz/${file} mevcut`);
  ok(existsSync(doc), `docs/img/${file} mevcut`);
  if (existsSync(pub) && existsSync(doc)) {
    ok(Buffer.compare(readFileSync(pub), readFileSync(doc)) === 0, `${file}: iki kopya bayt bayt aynı (bayatlama yok)`);
    const size = readFileSync(pub).length;
    ok(size > 1000 && size < 200_000, `${file}: boyut makul (${(size / 1024).toFixed(0)} KB, < 200 KB)`);
  }
}
// Sayfada olmayan ama kılavuz klasörüne kopyalanmış artık dosya bırakılmamalı.
const pubDir = path.join(root, "public/kilavuz");
const present = existsSync(pubDir) ? require("node:fs").readdirSync(pubDir) : [];
ok(present.every((f: string) => existsSync(path.join(root, "docs/img", f))), "public/kilavuz'da docs/img'de olmayan dosya yok");

// ── 2b. Akış şeması (fotoğrafsız adımlar için özgün SVG) ──
const flow = GUIDE_INTRO.flowImage;
ok(existsSync(path.join(root, "public/kilavuz", flow)), `akış şeması public/kilavuz/${flow} mevcut`);
ok(existsSync(path.join(root, "docs/img", flow)), `akış şeması docs/img/${flow} mevcut`);
ok(Buffer.compare(readFileSync(path.join(root, "public/kilavuz", flow)), readFileSync(path.join(root, "docs/img", flow))) === 0, "akış şeması iki kopya aynı");
ok(images.every((f) => f !== flow), "akış şeması bir adımın ekran görüntüsü yerine kullanılmaz (yanlış kanıt olmaz)");
const svg = readFileSync(path.join(root, "public/kilavuz", flow)).toString("utf8");
ok(/viewBox="0 0 940 230"/.test(svg), "akış şeması beklenen tuvali taşır (GUIDE_IMAGE_WIDTHS ile uyumlu)");
ok(/role="img"/.test(svg) && /aria-label="[^"]{20,}"/.test(svg), "SVG erişilebilirlik etiketleri var");

// ── 3. Sayfa görselleri gerçekten basıyor ──
const page = read("src/app/resimlianlatim/page.tsx").toString("utf8");
ok(page.includes("guideImageSrc(step.image") && page.includes("guideImageSrc(GUIDE_INTRO.flowImage"), "sayfa görsel yolunu guideImageSrc ile üretir (basePath uyumlu)");
ok(page.includes("alt={step.alt"), "sayfa alt metin (erişilebilirlik) yazıyor");
ok(page.includes("process.env.NEXT_PUBLIC_BASE_PATH"), "GitHub Pages alt yolu kullanılıyor");
ok(!/<img[^>]+src="\/docs\//.test(page), "sayfa docs/ altına doğrudan bağlanmıyor (Pages'te yoktur)");
ok(guideImageSrc("a.jpg", "/ArenaViewer") === "/ArenaViewer/kilavuz/a.jpg", "guideImageSrc alt yolu ekler");

// ── 4. Bağlantı noktaları ──
const yardim = read("src/app/yardim/page.tsx").toString("utf8");
const prefs = read("src/components/PreferencesPanel.tsx").toString("utf8");
const ws = read("src/components/Workstation.tsx").toString("utf8");
const admin = read("src/components/AdminPanel.tsx").toString("utf8");
for (const [name, src] of [["/yardim", yardim], ["/tercihler (Ayarlar)", prefs], ["Workstation", ws], ["AdminPanel", admin]] as const) {
  ok(src.includes("/resimlianlatim"), `${name} → /resimlianlatim bağlantısı var`);
}
const guide = read("docs/MENU_KILAVUZU.md").toString("utf8");
const sss = read("docs/SSS.md").toString("utf8");
const manifest = JSON.parse(read("docs/menu-kilavuzu.manifest.json").toString("utf8")) as string[];
ok(guide.includes("/resimlianlatim"), "MENU_KILAVUZU.md resimli anlatım sayfasını listeler");
ok(sss.includes("/resimlianlatim"), "SSS.md resimli anlatım sayfasını anar");
ok(manifest.includes("/resimlianlatim"), "menü manifestosunda sayfa anchor'ı var");

// ── 5. İstatistik ve güvenlik ──
const stats = guideStats();
ok(stats.steps === steps.length && stats.images === images.length, "özet sayıları içerikle uyumlu");
ok(stats.web + stats.local + stats.partial === steps.length, "ortam dağılımı toplamı adım sayısına eşit");
const allPaths = images.map((f) => `public/kilavuz/${f}`).join(" ");
ok(!/hasta|patient|hasta-/i.test(allPaths), "görsel dosya adlarında hasta verisi iması yok");

if (failed) { console.error(`${failed} resimli anlatım testi başarısız`); process.exit(1); }
console.log("Resimli anlatım kapsam testleri geçti.");

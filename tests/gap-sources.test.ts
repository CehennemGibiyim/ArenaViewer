/**
 * Kıyaslama tablosu kaynak denetimi (sahte veri yok).
 *
 * Bu test üç şeyi garanti eder:
 *  1. Tablodaki her satırın en az bir **kaynağı** var; kaynağı olmayan ürün adı olamaz.
 *  2. "Bizde şu an" metinlerinde geçen **depo dosya yollarının hepsi gerçekten var**
 *     (dosya sistemi kontrolü) — uydurma dosya/özellik iddiası yakalanır.
 *  3. Kaynak kayıtları tutarlı: https adres, ISO doğrulama tarihi, doğrulanmamış
 *     kayıtta açıklama notu, gelecek tarih yok.
 */
import { existsSync } from "node:fs";
import { GAP_ITEMS, COMPETITORS } from "../src/lib/gapAnalysis";
import { GAP_SOURCES, PRODUCT_SOURCES, SOURCES_UPDATED, competitorLink, itemSources, sourceSummary } from "../src/lib/gapSources";
import { gapProgress } from "../src/lib/gapProgress";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const entries = Object.values(GAP_SOURCES);

// ── 1. kayıt defteri tutarlılığı ──
ok(entries.length >= 20, `kayıt defteri dolu (${entries.length} kaynak)`);
ok(entries.every((x) => x.key && x.label && x.basis.length > 10), "her kaydın anahtar/etiket/dayanak metni var");
ok(entries.every((x) => x.key === GAP_SOURCES[x.key].key), "anahtar alanı sözlük anahtarıyla aynı");
ok(entries.every((x) => !x.url || /^https:\/\//.test(x.url)), "dış adresler https");
ok(entries.every((x) => !x.url || (() => { try { const u = new URL(x.url!); return !!u.hostname.includes("."); } catch { return false; } })()), "dış adresler geçerli alan adı taşır");
ok(entries.every((x) => x.checkedAt === null || (ISO.test(x.checkedAt) && x.checkedAt <= SOURCES_UPDATED)), "doğrulama tarihleri ISO ve gözden geçirme tarihinden sonra değil");
ok(ISO.test(SOURCES_UPDATED), "gözden geçirme tarihi ISO");
ok(entries.every((x) => x.checkedAt !== null || (x.note && x.note.length > 15)), "doğrulanmamış kaydın açıklaması var");
ok(entries.every((x) => x.checkedAt === null || x.checkMethod !== "yok"), "doğrulanmış kaydın yöntemi var");
ok(entries.filter((x) => x.kind === "kod").every((x) => !!x.path && existsSync(x.path)), "kod kayıtlarının dosyası mevcut");

// ── 2. ürün → kaynak eşlemesi ──
const products = new Set<string>();
for (const it of GAP_ITEMS) for (const m of it.market) products.add(m);
const unmappedProducts = [...products].filter((p) => !PRODUCT_SOURCES[p] || !GAP_SOURCES[PRODUCT_SOURCES[p]]);
ok(unmappedProducts.length === 0, `her ürün adı bir kaynağa bağlı (${products.size} ad, kaynaksız: ${unmappedProducts.join(", ") || "yok"})`);
ok(Object.values(PRODUCT_SOURCES).every((k) => !!GAP_SOURCES[k]), "eşleme tablosundaki tüm anahtarlar kayıt defterinde");

// ── 3. her satırın kaynağı var ──
const noSource = GAP_ITEMS.filter((i) => itemSources(i).external.length === 0);
ok(noSource.length === 0, `her satırın en az bir dış kaynağı var (eksik: ${noSource.map((i) => i.id).join(", ") || "yok"})`);
const unmappedItems = GAP_ITEMS.filter((i) => itemSources(i).unmapped.length > 0);
ok(unmappedItems.length === 0, "hiçbir satırda kaynaksız ürün adı kalmaz");

// ── 4. depo dosya referansları gerçek ──
const missing: string[] = [];
let refCount = 0;
for (const it of GAP_ITEMS) {
  for (const p of itemSources(it).code) {
    refCount++;
    if (!existsSync(p)) missing.push(`${it.id} → ${p}`);
  }
}
ok(refCount >= 40, `depo referansı sayısı anlamlı (${refCount})`);
ok(missing.length === 0, `tüm depo referansları mevcut (eksik: ${missing.slice(0, 5).join(" | ") || "yok"})`);
const refs = GAP_ITEMS.flatMap((i) => itemSources(i).code);
ok(new Set(refs).size >= 20, `farklı dosyaya atıf çeşitliliği (${new Set(refs).size})`);
ok(refs.every((p) => /^(src|tests|scripts|ai-worker|docs|public|packaging|windows)\//.test(p)), "referanslar depo kökünden göreli yol");

// ── 5. özet ve bileşen senkronu ──
const sum = sourceSummary(GAP_ITEMS);
ok(sum.unmapped.length === 0 && sum.usedSources > 15, `özet: ${sum.usedSources} kaynak, ${sum.externalLinks} bağlantı, ${sum.codeRefs} dosya`);
ok(sum.unverified >= 0 && sum.unverified <= sum.externalLinks, "doğrulanmamış sayısı bağlantı sayısını aşmaz");
ok(sum.updatedAt === SOURCES_UPDATED, "özet tarihi kayıt defteriyle aynı");

// ── 6. rakip kartları kaynaklı ──
const competitorNoSite = COMPETITORS.filter((c) => !competitorLink(c.name));
ok(competitorNoSite.length === 0, `her rakip kartının doğrulanmış bağlantısı var (eksik: ${competitorNoSite.map((c) => c.name).join(", ") || "yok"})`);
ok(COMPETITORS.every((c) => /^https:\/\//.test(competitorLink(c.name)!.url)), "rakip bağlantıları https");
ok(competitorLink("PowerScribe")!.official === false, "resmî sayfası doğrulanmayan ürün ikincil kaynağa bağlanır ve etiketlenir");
ok(competitorLink("RadiAnt")!.official === true, "üretici sitesi olan ürün resmî bağlantı alır");
ok(COMPETITORS.length >= 12, `rakip kartı sayısı (${COMPETITORS.length})`);

// ── 7. tablo kodla senkron (sayfada sabit yüzde yok) ──
const progress = gapProgress(GAP_ITEMS);
ok(progress.var + progress.kismi + progress.yok === GAP_ITEMS.length, "durum toplamı madde sayısına eşit");
ok(progress.completedPercent === Math.round((progress.var / progress.total) * 100), "tamamlanan yüzde var sayısından hesaplanır");
const pageSource = require("node:fs").readFileSync("src/components/GapAnalysis.tsx", "utf8") as string;
ok(pageSource.includes("gapProgress(GAP_ITEMS)") && pageSource.includes("{progress.completedPercent}"), "sayfa yüzdeleri koddan okuyor");
ok(pageSource.includes("itemSources(i)") && pageSource.includes("SOURCES_UPDATED"), "sayfa satır kaynaklarını ve gözden geçirme tarihini gösteriyor");
ok(!/SOURCES\.map/.test(pageSource), "eski doğrulanmamış kaynak listesi kaldırıldı");

if (failed) { console.error(`${failed} kaynak denetimi başarısız`); process.exit(1); }
console.log("Tüm kıyaslama kaynak denetimleri geçti.");

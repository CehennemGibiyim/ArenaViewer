/**
 * Cihaz tercih katmanı (`src/lib/prefsStore.ts`) + statik demo `/tercihler` sayfası.
 *
 * Neden: kullanıcı GitHub Pages'te `/tercihler/` adresinde **404** görüyordu.
 * Neden 404: `scripts/prepare-pages.sh` sayfayı sunucu sürümüyle birlikte
 * siliyordu (sayfa `getCurrentUser()` ile giriş kapısı kullanıyor, DB yok).
 * Çözüm iki katmanlı ve bu test onu kilitliyor:
 *
 *   1. Sayfa statik derlemede **silinmez**; giriş kapısı yerine demo sarmalayıcı
 *      yazılır ve `/api/profile/preferences` `StaticApiShim` ile karşılanır.
 *   2. Tercihler ayrıca cihazda (`localStorage`) saklanır — çevrimdışı/oturumsuz
 *      durumda da seçim kaybolmaz; "kaydedildi" deyip saklamamak yasak.
 *
 * Depolama davranışı sahte bir `localStorage` ile (bozuk JSON, kota hatası,
 * depolama yok) gerçekten çalıştırılarak doğrulanır — kaynak taramasıyla değil.
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

// ── 1. Sahte tarayıcı: window + localStorage ────────────────────────────────
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  quotaFull = false;
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) {
    if (this.quotaFull) throw new DOMException("kota dolu", "QuotaExceededError");
    this.map.set(k, v);
  }
}

const store = new FakeStorage();
const win = { localStorage: store as Storage } as unknown as Window & typeof globalThis;
(globalThis as unknown as { window: unknown }).window = win;
const doc = {
  documentElement: {
    attrs: new Map<string, string>(),
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    removeAttribute(k: string) { this.attrs.delete(k); },
    getAttribute(k: string) { return this.attrs.get(k) ?? null; },
  },
} as unknown as Document;
(globalThis as unknown as { document: unknown }).document = doc;

const {
  PREFS_STORAGE_KEY, THEME_STORAGE_KEY, applyTheme, clearStoredPrefs, loadStoredPrefs,
  mergeSources, readStoredTheme, saveStoredPrefs,
} = require("../src/lib/prefsStore.ts") as typeof import("../src/lib/prefsStore");
const { DEFAULT_PREFS, mergePrefs } = require("../src/lib/prefs.ts") as typeof import("../src/lib/prefs");

// ── 2. Cihaz katmanı: yaz → oku ──
ok(loadStoredPrefs() === null, "kayıt yokken null döner (uydurma varsayılan yok)");
const mine = mergePrefs(DEFAULT_PREFS, { layout: "2x2", theme: "clinic-blue", defaultWindow: "beyin" });
ok(saveStoredPrefs(mine) === true, "yazma başarılı → true");
const back = loadStoredPrefs();
ok(back?.layout === "2x2" && back?.theme === "clinic-blue" && back?.defaultWindow === "beyin", "yazılan değerler geri okunur");
ok(store.getItem(PREFS_STORAGE_KEY) !== null, "anahtar gerçekten depoda");

// Beyaz liste dışı alanlar diske de yazılmaz.
saveStoredPrefs({ ...mine, layout: "9x9" as never, gizli: "x" } as never);
const raw = JSON.parse(store.getItem(PREFS_STORAGE_KEY)!) as Record<string, unknown>;
ok(!("gizli" in raw), "beyaz liste dışı alan depoya yazılmaz");
ok(raw.layout === "2x2", "geçersiz alan yazılırken önceki geçerli değer korunur");

// Bozuk JSON → null (çökmez, varsayım üretmez).
store.setItem(PREFS_STORAGE_KEY, "{bozuk");
ok(loadStoredPrefs() === null, "bozuk JSON → null");
// Geçerli JSON ama beyaz liste dışı → null.
store.setItem(PREFS_STORAGE_KEY, JSON.stringify({ saçma: 1 }));
ok(loadStoredPrefs() === null, "tümüyle geçersiz kayıt → null");
// Kota dolu → false (arayüz 'kaydedildi' dememeli).
saveStoredPrefs(mine);
store.quotaFull = true;
ok(saveStoredPrefs(mine) === false, "kota dolu → false (sessiz başarı yok)");
store.quotaFull = false;

// ── 3. Kaynak önceliği ──
ok(mergeSources(null).source === "cihaz", "sunucu yokken cihaz kopyası kullanılır");
const merged = mergeSources({ layout: "3x1" });
ok(merged.source === "sunucu" && merged.prefs.layout === "3x1", "sunucu kopyası kazanır");
ok(merged.prefs.theme === "clinic-blue", "sunucuda olmayan alan cihazdan tamamlanır (birleştirme)");
clearStoredPrefs();
const empty = mergeSources(null);
ok(empty.source === "varsayılan" && empty.prefs.layout === DEFAULT_PREFS.layout, "hiç kayıt yokken varsayılan ve kaynak açıkça 'varsayılan'");

// Depolama tamamen yoksa: uyarı verilir, çökmez.
const saved = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage;
(globalThis as unknown as { window: { localStorage: unknown } }).window.localStorage = {
  getItem() { throw new Error("erişim yok"); },
  setItem() { throw new Error("erişim yok"); },
  removeItem() { throw new Error("erişim yok"); },
} as unknown as Storage;
ok(loadStoredPrefs() === null, "depolama erişilemezse null");
ok(saveStoredPrefs(mine) === false, "depolama erişilemezse false");
ok(mergeSources(null).warning?.includes("depolaması kapalı") === true, "depolama yoksa kullanıcıya uyarı metni üretilir");
(globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage = saved;

// ── 4. Tema uygulaması ──
applyTheme("clinic-blue");
ok(doc.documentElement.getAttribute("data-theme") === "clinic-blue", "tema belgeye uygulanır ([data-theme])");
ok(readStoredTheme() === "clinic-blue", "tema cihaza yazılır");
ok(store.getItem(THEME_STORAGE_KEY) === "clinic-blue", "anahtar görüntüleyicinin okuduğu anahtarla aynı (atik-theme)");
applyTheme("koyu");
ok(doc.documentElement.getAttribute("data-theme") === null, "varsayılan temada nitelik kaldırılır (koyu = temel görünüm)");

// ── 5. Statik demo sözleşmesi ──
const prep = read("scripts/prepare-pages.sh");
ok(!/rm -rf[^\n]*src\/app\/tercihler/.test(prep), "prepare-pages.sh `/tercihler` sayfasını SİLMİYOR");
ok(/cat > src\/app\/tercihler\/page\.tsx/.test(prep), "statik derlemede /tercihler için demo sayfası yazılıyor");
ok(/StaticApiShim/.test(prep.slice(prep.indexOf("src/app/tercihler/page.tsx"))), "demo sayfası prefs shim'ini yükler");
const shim = read("src/components/StaticApiShim.tsx");
ok(shim.includes('p === "/api/profile/preferences"'), "shim tercih ucunu karşılıyor");
ok(/GET[\s\S]{0,400}DEFAULT_PREFS/.test(shim), "GET kayıt yokken varsayılanları döner");
ok(/saveStoredPrefs\(next\)\) return fail\([^)]*503\)/.test(shim), "yazma başarısızsa 503 (kaydedildi taklidi yok)");
ok(/clearStoredPrefs\(\)/.test(shim), "DELETE cihaz kopyasını siler");
const panel = read("src/components/PreferencesPanel.tsx");
// Panel açılışta kendiliğinden yüklenir: ilk boyama cihaz katmanından (lazy
// state), sunucu kopyası ref korumalı effect ile birleştirilir.
ok(/useState<UserPrefs \| null>\(\(\) =>/.test(panel) && /loadStoredPrefs\(\)/.test(panel), "ilk boyama cihaz katmanından (boş ekran yok)");
ok(/useRef\(false\)/.test(panel) && /void load\(\)/.test(panel), "sunucu kopyası açılışta bir kez yüklenir");
ok(/Kaynak:/.test(panel), "hangi katmandan okunduğu kullanıcıya yazılır");
ok(/saveStoredPrefs\(next\)/.test(panel) && /applyTheme\(next\.theme\)/.test(panel), "kaydet hem cihaza yazar hem temayı uygular");
ok(/kaydedilemedi|Kaydedilemedi/i.test(panel), "başarısızlık açıkça bildirilir");
ok(/Görünüm teması/.test(panel), "panelde tema seçici var (tercih hesaba da yazılır)");

if (failed) { console.error(`${failed} tercih katmanı testi başarısız`); process.exit(1); }
console.log("Cihaz tercih katmanı + /tercihler demo sayfası testleri geçti.");

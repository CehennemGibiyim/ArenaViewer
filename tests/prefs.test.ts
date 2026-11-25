/** Kullanıcı tercihleri doğrulaması testleri. */
import { DEFAULT_PREFS, LAYOUTS, THEMES, WINDOW_PRESETS, mergePrefs, sanitizePrefs, themeAttr } from "../src/lib/prefs";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

ok(sanitizePrefs(null).constructor === Object || Object.keys(sanitizePrefs(null)).length === 0, "null girdisi boş patch");
ok(Object.keys(sanitizePrefs({ layout: "9x9", defaultWindow: "uçak" })).length === 0, "Beyaz liste dışı alanlar atılır");
ok(Object.keys(sanitizePrefs({ layout: "2x2" })).length === 1 && sanitizePrefs({ layout: "2x2" }).layout === "2x2", "Geçerli düzen kabul edilir");
const winName = WINDOW_PRESETS[1];
ok(winName !== undefined && (sanitizePrefs({ defaultWindow: winName }) as { defaultWindow?: string }).defaultWindow === winName, "Pencere ön ayarı beyaz listede");
ok(WINDOW_PRESETS.length >= 6, "Pencere ön ayarı seçenekleri mevcut");
ok(LAYOUTS.length >= 8, "Düzen seçenekleri mevcut");
ok(sanitizePrefs({ autoHangingProtocol: true, theme: "aydinlik" }).theme === undefined, "Beyaz listede olmayan tema reddedilir");
ok(sanitizePrefs({ theme: "high-contrast" }).theme === "high-contrast", "Yüksek kontrast tema kabul edilir");
ok(sanitizePrefs({ theme: "clinic-blue" }).theme === "clinic-blue" && sanitizePrefs({ theme: "slate-light" }).theme === "slate-light", "Klinik mavi/açık tema kabul edilir");
ok(THEMES.every((t) => typeof t.attr === "string"), "her tema bir data-theme değeri taşır");
ok(themeAttr("koyu") === "" && themeAttr("high-contrast") === "high-contrast" && themeAttr(undefined) === "", "themeAttr data-theme değerine çevirir");
ok(sanitizePrefs({ reducedMotion: true }).reducedMotion === true && sanitizePrefs({ reducedMotion: "evet" }).reducedMotion === undefined, "reducedMotion yalnız boolean kabul eder");
ok(sanitizePrefs({ shortcuts: { rotate: "j", flipH: "j" } }).shortcuts?.rotate === "j" && sanitizePrefs({ shortcuts: { rotate: "j", flipH: "j" } }).shortcuts?.flipH === undefined, "kısayol çakışması tercih katmanında da çözülür");
ok(Object.keys(sanitizePrefs({ shortcuts: { rotate: "r+k" } }).shortcuts ?? {}).length === 0, "geçersiz kısayol tercihe yazılmaz");
ok(sanitizePrefs({ shortcuts: [] }).shortcuts === undefined, "dizi kısayol nesnesi sayılmaz");
ok(mergePrefs(DEFAULT_PREFS, { theme: "high-contrast" }).theme === "high-contrast" && mergePrefs(DEFAULT_PREFS, { theme: "high-contrast" }).shortcuts !== undefined, "mergePrefs tema/kısayolları korur");
ok(mergePrefs(DEFAULT_PREFS, { layout: "3x2" }).layout === "3x2" && mergePrefs(DEFAULT_PREFS, { layout: "3x2" }).defaultWindow === "", "mergePrefs korur + uygular");

if (failed) { console.error(`${failed} tercih testi başarısız`); process.exit(1); }
console.log("Tüm tercih testleri geçti.");

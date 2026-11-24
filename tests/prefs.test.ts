/** Kullanıcı tercihleri doğrulaması testleri. */
import { DEFAULT_PREFS, LAYOUTS, WINDOW_PRESETS, mergePrefs, sanitizePrefs } from "../src/lib/prefs";

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
ok(sanitizePrefs({ autoHangingProtocol: true, theme: "aydinlik" }).theme === undefined, "Aydınlık tema henüz yok (geçersiz)");
ok(mergePrefs(DEFAULT_PREFS, { layout: "3x2" }).layout === "3x2" && mergePrefs(DEFAULT_PREFS, { layout: "3x2" }).defaultWindow === "", "mergePrefs korur + uygular");

if (failed) { console.error(`${failed} tercih testi başarısız`); process.exit(1); }
console.log("Tüm tercih testleri geçti.");

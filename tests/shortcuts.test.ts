/**
 * i-a11y + f-prefs: klavye kısayolu motoru testleri.
 * Saf fonksiyonlar: atama ayrıştırma, olay eşleştirme, çakışma çözümü.
 */
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, findConflicts, formatShortcut, matchShortcut,
  normalizeBinding, parseBinding, resolveShortcuts, sanitizeShortcuts, serializeBinding,
  shortcutFor, shortcutRows,
} from "../src/lib/shortcuts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── Ayrıştırma / normalizasyon ──
ok(normalizeBinding("R") === "r", "büyük harf küçültülür");
ok(normalizeBinding(" Shift + R ") === "shift+r", "boşluklar ve büyük harf normalize edilir");
ok(normalizeBinding("r+shift") === "shift+r", "değiştirici sırası önemsiz");
ok(normalizeBinding("up") === "arrowup", "ok tuşu takma adı");
ok(normalizeBinding("?") === "?", "soru işareti geçerli");
ok(normalizeBinding("+") === "+", "artı tuşu ayırıcıyla karışmaz");
ok(normalizeBinding("ctrl+") === null, "tuşsuz değiştirici reddedilir");
ok(normalizeBinding("r+k") === null, "çok adımlı dizi desteklenmez");
ok(normalizeBinding("shift+alt+meta+ctrl+a") === "ctrl+alt+shift+meta+a", "kanonik değiştirici sırası");
ok(parseBinding("") === null && normalizeBinding("bilinmeyen") === null, "boş/anlamsız tuş reddedilir");

const b = parseBinding("shift+r");
ok(b?.key === "r" && b.shift && !b.ctrl, "parseBinding alanları doğru");
ok(b ? serializeBinding(b) === "shift+r" : false, "serializeBinding gidiş-dönüş");

// ── Varsayılanlar: çakışma yok, her eylem tanımlı ──
ok(Object.keys(DEFAULT_SHORTCUTS).length === SHORTCUT_ACTIONS.length, "her eylem için varsayılan tuş var");
ok(findConflicts(DEFAULT_SHORTCUTS).length === 0, "varsayılan atamalarda çakışma yok");
const allValid = Object.values(DEFAULT_SHORTCUTS).every((v) => normalizeBinding(v) !== null);
ok(allValid, "tüm varsayılan atamalar geçerli");

// ── Olay eşleştirme ──
ok(matchShortcut({ key: "r" }, DEFAULT_SHORTCUTS.rotate), "küçük harf eşleşir");
ok(matchShortcut({ key: "R", shiftKey: true }, DEFAULT_SHORTCUTS.rotate) === false, "shift basılıysa düz tuş eşleşmez");
ok(matchShortcut({ key: "ArrowUp" }, DEFAULT_SHORTCUTS.slicePrev), "ok tuşu eşleşir");
ok(matchShortcut({ key: "ArrowUp", shiftKey: true }, DEFAULT_SHORTCUTS.slicePrev) === false, "shift'li ok eşleşmez");
ok(matchShortcut({ key: "?" , shiftKey: true }, DEFAULT_SHORTCUTS.help), "? shift ile üretilse de eşleşir");
ok(matchShortcut({ key: "r", ctrlKey: true }, DEFAULT_SHORTCUTS.rotate) === false, "ctrl basılıysa eşleşmez");
ok(matchShortcut({ key: "r" }, "shift+r") === false, "shift gerektiren atama düz tuşla eşleşmez");
ok(matchShortcut({ key: "r", shiftKey: true }, "shift+r"), "shift gerektiren atama shift ile eşleşir");
ok(matchShortcut({ key: "r" }, "") === false && matchShortcut({ key: "r" }, null) === false, "boş atama hiçbir şeyle eşleşmez");
ok(matchShortcut({ key: "0" }, DEFAULT_SHORTCUTS.resetView), "rakam tuşu eşleşir");

// ── Beyaz liste / temizlik ──
ok(Object.keys(sanitizeShortcuts({ rotate: "x" })).length === 1, "geçerli özel atama kabul edilir");
ok(Object.keys(sanitizeShortcuts({ uydurma: "x" })).length === 0, "bilinmeyen eylem atılır");
ok(Object.keys(sanitizeShortcuts({ rotate: "r+k" })).length === 0, "geçersiz tuş atılır");
ok(Object.keys(sanitizeShortcuts({ rotate: 42 })).length === 0, "sayısal değer atılır");
ok(Object.keys(sanitizeShortcuts(null)).length === 0 && Object.keys(sanitizeShortcuts([])).length === 0, "null/dizi boş döner");
const dup = sanitizeShortcuts({ rotate: "j", flipH: "j" });
ok(dup.rotate === "j" && dup.flipH === undefined, "yinelenen atamada ilk eylem kazanır");

// ── Çakışma çözümü ──
const resolved = resolveShortcuts({ rotate: "arrowup" });
ok(resolved.rotate === "arrowup", "özel atama korunur");
ok(resolved.slicePrev !== "arrowup", "çakışan eylem aynı tuşu kullanmaz");
ok(findConflicts(resolveShortcuts({ rotate: "arrowup" })).length === 0, "çözüm sonrası çakışma kalmaz");
const disabled = resolveShortcuts({});
ok(Object.values(disabled).every((v) => v === "" || normalizeBinding(v) !== null), "çözüm sonrası tüm atamalar geçerli veya boş");
ok(shortcutFor({ rotate: "j" }, "rotate") === "j", "shortcutFor özel atamayı döndürür");
ok(shortcutFor({}, "rotate") === DEFAULT_SHORTCUTS.rotate, "shortcutFor varsayılana düşer");

// ── Biçimlendirme / yardım tablosu ──
ok(formatShortcut("shift+r") === "Shift + R", "okunur biçim: Shift + R");
ok(formatShortcut("arrowdown") === "↓", "ok simgesi");
ok(formatShortcut("?" ) === "?", "soru işareti biçimi");
ok(formatShortcut("") === "—" && formatShortcut(null) === "—", "boş atama — gösterir");
const rows = shortcutRows({ rotate: "j" });
ok(rows.length === SHORTCUT_ACTIONS.length, "yardım tablosu tüm eylemleri listeler");
ok(rows.find((r) => r.id === "rotate")?.binding === "j", "yardım tablosu özel atamayı gösterir");
ok(rows.every((r) => typeof r.label === "string" && r.label.length > 0), "her satırda etiket var");

if (failed) { console.error(`${failed} kısayol testi başarısız`); process.exit(1); }
console.log("Tüm klavye kısayolu testleri geçti.");

/**
 * Klavye kısayolu testleri (v-geo).
 *
 * Sözleşme: tuş adları normalize edilir (tek harf küçük, " " → Space), bozuk
 * tercih kaydı varsayılana düşer, çakışma bildirilir ve çakışmada listedeki ilk
 * eylem kazanır; eylem başına en çok 4 tuş atanır.
 */
import {
  DEFAULT_SHORTCUTS, MAX_KEYS_PER_ACTION, SHORTCUT_ACTIONS, SHORTCUT_LABELS,
  formatKeyList, normalizeKey, parseKeyList, resolveAction, sanitizeShortcuts, shortcutConflicts,
} from "../src/lib/shortcuts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── 1. normalleştirme ──
ok(normalizeKey("R") === "r" && normalizeKey("r") === "r", "tek harf küçük harfe iner (R → r)");
ok(normalizeKey("ArrowUp") === "ArrowUp" && normalizeKey("arrowup") === "ArrowUp", "özel tuş adları tek biçime gelir");
ok(normalizeKey(" ") === "Space", "boşluk tuşu Space olur");
ok(normalizeKey("  x  ") === "x", "baştaki/sondaki boşluk kırpılır");
ok(normalizeKey("") === "", "boş tuş adı boş döner");

// ── 2. metin ayrıştırma ──
ok(parseKeyList("r, R").join("|") === "r", "yinelenen tuş bir kez sayılır");
ok(parseKeyList("ArrowUp; ArrowLeft").join("|") === "ArrowUp|ArrowLeft", "noktalı virgül de ayırıcıdır");
ok(parseKeyList("a,b,c,d,e").length === MAX_KEYS_PER_ACTION, `eylem başına en çok ${MAX_KEYS_PER_ACTION} tuş`);
ok(parseKeyList("").length === 0, "boş metin → tuş yok (kısayol kapalı)");
ok(formatKeyList(["r", "ArrowUp"]) === "r, ArrowUp", "düzenleme kutusu biçimi");

// ── 3. varsayılanlar ──
ok(SHORTCUT_ACTIONS.every((a) => DEFAULT_SHORTCUTS[a].length > 0), "her eylemde varsayılan tuş var");
ok(Object.keys(SHORTCUT_LABELS).length === SHORTCUT_ACTIONS.length, "her eylemin Türkçe etiketi var");
ok(shortcutConflicts(DEFAULT_SHORTCUTS).length === 0, "varsayılan haritada çakışma yok");

// ── 4. çözümleme ──
ok(resolveAction("R", DEFAULT_SHORTCUTS) === "rotate", "R döndürmeye gider (küçük/büyük harf)");
ok(resolveAction("ArrowLeft", DEFAULT_SHORTCUTS) === "sliceUp", "sol ok önceki kesit");
ok(resolveAction("ArrowRight", DEFAULT_SHORTCUTS) === "sliceDown", "sağ ok sonraki kesit");
ok(resolveAction("z", DEFAULT_SHORTCUTS) === null, "atanmamış tuş eylem üretmez");
const custom = { ...DEFAULT_SHORTCUTS, rotate: ["t"], flipH: [] };
ok(resolveAction("t", custom) === "rotate", "kullanıcı tuşu geçerli");
ok(resolveAction("r", custom) === null, "eski tuş kaldırıldığında çalışmaz");
ok(resolveAction("h", custom) === null, "boş bırakılan eylem kısayolsuz");

// ── 5. çakışma ──
const clash = { ...DEFAULT_SHORTCUTS, rotate: ["h"] };
const conflicts = shortcutConflicts(clash);
ok(conflicts.length === 1 && conflicts[0].key === "h", "aynı tuş iki eylemde çakışma olarak bildirilir");
ok(conflicts[0].actions.length === 2, "çakışan iki eylem listelenir");
ok(resolveAction("h", clash) === "rotate", "çakışmada listedeki ilk eylem kazanır (rotate)");

// ── 6. bozuk kayıt ──
ok(sanitizeShortcuts(null).rotate.join() === DEFAULT_SHORTCUTS.rotate.join(), "bozuk kayıt varsayılana döner");
ok(sanitizeShortcuts({ rotate: "r" }).rotate.join() === "r", "dizi olmayan alan varsayılanda kalır");
ok(sanitizeShortcuts({ rotate: ["T", " T ", 5] }).rotate.join() === "t", "geçersiz üyeler atılır, tuş normalize edilir");
ok(sanitizeShortcuts({ flipH: [] }).flipH.length === DEFAULT_SHORTCUTS.flipH.length, "boş dizi varsayılanı ezmez");
ok(Object.keys(sanitizeShortcuts({ bilinmeyen: ["x"] })).length === SHORTCUT_ACTIONS.length, "bilinmeyen eylem yok sayılır");

if (failed) { console.error(`${failed} kısayol testi başarısız`); process.exit(1); }
console.log("Kısayol testleri geçti.");

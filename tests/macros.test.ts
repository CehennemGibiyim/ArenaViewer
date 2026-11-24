/** Makro kütüphanesi testleri. */
import assert from "node:assert/strict";
import { MACROS, MACRO_GROUPS, macroById, macrosByGroup } from "../src/lib/macros";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const ids = MACROS.map((m) => m.id);
ok(new Set(ids).size === ids.length, "Makro id'leri benzersiz");
ok(MACROS.every((m) => m.label.trim().length > 2 && m.text.trim().length > 10), "Tüm makrolarda etiket ve metin var");
ok(MACROS.every((m) => m.group in MACRO_GROUPS), "Geçerli grup kullanımı");
ok(macroById("b-nodul")?.group === "bulgu" && macroById("yok") === null, "macroById bulma/bilinmeyen");
ok(macrosByGroup("oneri").every((m) => m.group === "oneri") && macrosByGroup("oneri").length >= 3, "Grup filtresi ve öneri makroları");

if (failed) { console.error(`${failed} makro testi başarısız`); process.exit(1); }
console.log("Tüm makro testleri geçti.");

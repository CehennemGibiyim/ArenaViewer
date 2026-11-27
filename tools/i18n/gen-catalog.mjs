#!/usr/bin/env node
/**
 * ISO 639-3 yaşayan diller kataloğu üreticisi → `src/i18n/catalog.json`
 *
 * Katalog, dil seçicisinin listelediği "dünyadaki her yaşayan dili" sağlar.
 * Çevirisi hazır olmayan diller İngilizce arayüzle (yedek) açılır; çeviri
 * katkısı geldiğinde paket eklenir (bkz. docs/CEVIRI_KATKI.md).
 *
 * Kaynak: `iso-639-3` npm paketi (ISO 639-3, SIL) — `type === "living"`,
 * `scope !== "special"` (özel kodlar qaa..qtz / und / mul / zxx dışlanır).
 * Alanlar: c = ISO 639-3 kodu, n = İngilizce ad, p1 = ISO 639-1 (varsa).
 */
import { iso6393, iso6393To1 } from "iso-639-3";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const p1 = new Map(Object.entries(iso6393To1).map(([c3, c2]) => [c3, c2]));

const living = iso6393
  .filter((e) => e.type === "living" && e.scope !== "special")
  .map((e) => {
    const entry = { c: e.iso6393, n: e.name };
    const p = p1.get(e.iso6393);
    if (p) entry.p1 = p;
    return entry;
  })
  .sort((a, b) => a.n.localeCompare(b.n, "en"));

const seen = new Set();
for (const e of living) {
  if (seen.has(e.c)) throw new Error(`yinelenen ISO 639-3 kodu: ${e.c}`);
  seen.add(e.c);
}

const out = path.join(root, "src", "i18n", "catalog.json");
writeFileSync(out, JSON.stringify(living));
console.log(`catalog.json: ${living.length} yaşayan dil yazıldı (${(JSON.stringify(living).length / 1024).toFixed(0)} KB)`);

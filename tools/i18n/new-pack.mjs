#!/usr/bin/env node
/**
 * Yeni dil paketi iskelesi: `en.json`'u hedef koda kopyalar ve `src/lib/i18n.ts`
 * kayıtlarını (LANGUAGES + lazy registry) otomatik ekler.
 *
 * Kullanım: npm run i18n:new -- <kod> "<Native ad>" "<İngilizce ad>" [rtl|ltr]
 *   kod: ISO 639-1 (2 harf) veya ISO 639-3 (3 harf), küçük harf — ör. "quc", "tr"
 *
 * Sonra: paketi çevirin (en.json kopyasıdır — 32 anahtarın tamamı dolu olmalı),
 * `npm run test:i18n` koşun ve kılavuzdaki dil sayısı notlarını güncelleyin
 * (docs/KILAVUZ_BAKIMI.md zorunluluğu).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [code, native, english, dirArg] = process.argv.slice(2);
const fail = (msg) => { console.error("HATA:", msg); process.exit(1); };

if (!code || !native || !english) {
  fail('Kullanım: npm run i18n:new -- <kod> "<Native ad>" "<İngilizce ad>" [rtl|ltr]');
}
if (!/^[a-z]{2,3}$/.test(code)) fail(`kod küçük harf 2–3 olmalı: "${code}"`);
const dir = (dirArg ?? "ltr").toLowerCase() === "rtl" ? "rtl" : "ltr";

const packPath = `src/i18n/${code}.json`;
if (existsSync(packPath)) fail(`${packPath} zaten var`);

// Katalogda yaşayan ISO dili mi? (yalnız uyarı — engel değil)
try {
  const catalog = JSON.parse(readFileSync("src/i18n/catalog.json", "utf8"));
  if (!catalog.some((e) => e.c === code || e.p1 === code)) {
    console.warn(`UYARI: "${code}" yaşayan ISO 639-3 kataloğunda bulunamadı — kodu doğrulayın.`);
  }
} catch { /* katalog yoksa uyarma */ }

copyFileSync("src/i18n/en.json", packPath);

let lib = readFileSync("src/lib/i18n.ts", "utf8");
const infoAnchor = "];\n\nexport const DEFAULT_LOCALE";
const regAnchor = "};\n\nlet active:";
const langLine = `  { code: "${code}", native: "${native.replace(/"/g, '\\"')}", english: "${english.replace(/"/g, '\\"')}", dir: "${dir}" },\n`;
const regLine = `  ${code}: () => import("@/i18n/${code}.json"),\n`;
if (!lib.includes(infoAnchor)) fail("LANGUAGES kapanış çapası bulunamadı (src/lib/i18n.ts değişmiş olabilir) — kayıt satırını elle ekleyin.");
if (!lib.includes(regAnchor)) fail("registry kapanış çapası bulunamadı (src/lib/i18n.ts değişmiş olabilir) — import satırını elle ekleyin.");
lib = lib.replace(infoAnchor, langLine + infoAnchor).replace(regAnchor, regLine + regAnchor);
writeFileSync("src/lib/i18n.ts", lib);

console.log(`✔ ${packPath} (en.json kopyası) oluşturuldu`);
console.log(`✔ src/lib/i18n.ts kayıtları eklendi (LANGUAGES + lazy registry, dir=${dir})`);
console.log(`Sonraki adımlar:`);
console.log(`  1) ${packPath} içindeki 32 anahtarı "${native}" diline çevirin (boş değer bırakmayın)`);
console.log(`  2) npm run test:i18n`);
console.log(`  3) Kılavuzdaki dil sayısı notlarını güncelleyin — docs/KILAVUZ_BAKIMI.md`);

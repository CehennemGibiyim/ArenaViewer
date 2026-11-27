/**
 * Dil paketi denetimi — dil paketlerinin kaydı ve yedek zinciri bozulamaz.
 *
 * Kontrol eder:
 *  1. Her `src/i18n/<kod>.json` anahtar kümesi `en.json` ile birebir aynıdır,
 *  2. Değerler boş değildir (yalnız boşluk değil),
 *  3. `src/lib/i18n.ts` LANGUAGES kaydı her paketi listelemektedir,
 *  4. tr/en dışındaki her paket `registry` içinde dinamik `import()` ile kayıtlıdır,
 *  5. `DEFAULT_LOCALE`/`FALLBACK_LOCALE` dosyaları mevcuttur.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const i18nDir = path.join(root, "src", "i18n");
const libSrc = readFileSync(path.join(root, "src", "lib", "i18n.ts"), "utf8");

let failures = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) console.log("PASS", label);
  else {
    failures += 1;
    console.error("FAIL", label);
  }
};

const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
const enKeys = Object.keys(en).sort();
ok(enKeys.length >= 20, `referans en.json en az 20 anahtar (${enKeys.length})`);

// catalog.json çeviri paketi değil, ISO 639-3 canlı diller kataloğudur (aşağıda denetlenir)
const packFiles = readdirSync(i18nDir).filter((f) => f.endsWith(".json") && f !== "catalog.json");
ok(packFiles.length >= 20, `en az 20 dil paketi (${packFiles.length})`);

for (const file of packFiles) {
  const code = file.replace(/\.json$/, "");
  let pack: Record<string, string>;
  try {
    pack = JSON.parse(readFileSync(path.join(i18nDir, file), "utf8")) as Record<string, string>;
  } catch (e) {
    ok(false, `${code}: JSON ayrıştırılamadı — ${(e as Error).message}`);
    continue;
  }
  const keys = Object.keys(pack).sort();
  const missing = enKeys.filter((k) => !(k in pack));
  const extra = keys.filter((k) => !(k in en));
  ok(missing.length === 0 && extra.length === 0,
    `${code}: anahtar eşleşmesi (eksik ${missing.length}, fazla ${extra.length})${missing.length ? " — " + missing.join(",") : ""}`);
  const empty = Object.entries(pack).filter(([, v]) => typeof v !== "string" || v.trim() === "");
  ok(empty.length === 0, `${code}: boş değer yok (${empty.map(([k]) => k).join(",") || "0"})`);
}

for (const file of packFiles) {
  const code = file.replace(/\.json$/, "");
  ok(new RegExp(`code:\\s*"${code}"`).test(libSrc), `${code}: LANGUAGES kaydında listeleniyor`);
  if (code !== "tr" && code !== "en") {
    ok(libSrc.includes(`"@/i18n/${code}.json"`), `${code}: registry lazy import mevcut`);
  }
}

ok(/DEFAULT_LOCALE\s*=\s*"tr"/.test(libSrc), "DEFAULT_LOCALE = tr");
ok(/FALLBACK_LOCALE\s*=\s*"en"/.test(libSrc), "FALLBACK_LOCALE = en");

// --- ISO 639-3 canlı diller kataloğu -------------------------------------
// Seçicide "dünyadaki tüm canlı diller" bu kayıttan listelenir; çevirisi
// olmayan diller İngilizce yedeğiyle açılır. Katalog üretimi: tools/i18n/gen-catalog.mjs
const catalogPath = path.join(i18nDir, "catalog.json");
try {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { c: string; n: string; p1?: string }[];
  ok(Array.isArray(catalog) && catalog.length >= 6500, `katalog en az 6500 canlı dil (${catalog.length})`);
  const codes = new Set<string>();
  let malformed = 0, emptyName = 0, dup = 0, badP1 = 0;
  for (const e of catalog) {
    if (!/^[a-z]{3}$/.test(e.c)) malformed += 1;
    if (!e.n || !e.n.trim()) emptyName += 1;
    if (codes.has(e.c)) dup += 1;
    codes.add(e.c);
    if (e.p1 !== undefined && !/^[a-z]{2}$/.test(e.p1)) badP1 += 1;
  }
  ok(malformed === 0, `katalog kodları 3 harf küçük (hatalı: ${malformed})`);
  ok(emptyName === 0, `katalog adları boş değil (boş: ${emptyName})`);
  ok(dup === 0, `katalog kodları benzersiz (yinelenen: ${dup})`);
  ok(badP1 === 0, `ISO 639-1 alanları 2 harf küçük (hatalı: ${badP1})`);
  // Çevirisi hazır her dil katalogda bir canlı dil olarak doğrulanır
  const catalogSet = new Set<string>();
  for (const e of catalog) { catalogSet.add(e.c); if (e.p1) catalogSet.add(e.p1); }
  const translated = [...libSrc.matchAll(/code:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  const unmapped = translated.filter((code) => !catalogSet.has(code));
  ok(unmapped.length === 0, `LANGUAGES kodları canlı ISO dilleriyle eşleşiyor${unmapped.length ? " — " + unmapped.join(",") : ""}`);
} catch (e) {
  ok(false, `catalog.json okunamadı — ${(e as Error).message}`);
}

if (failures > 0) {
  console.error(`\ni18n coverage: ${failures} hata`);
  process.exit(1);
}
console.log("\ni18n coverage: PASS");

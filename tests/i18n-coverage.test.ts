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

const packFiles = readdirSync(i18nDir).filter((f) => f.endsWith(".json"));
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

if (failures > 0) {
  console.error(`\ni18n coverage: ${failures} hata`);
  process.exit(1);
}
console.log("\ni18n coverage: PASS");

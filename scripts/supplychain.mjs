#!/usr/bin/env node
/**
 * SBOM & tedarik zinciri yardımcıları (g-supplychain).
 *
 * `npm run supplychain:verify` — bir sürüm klasöründeki (release varlıkları)
 * bileşen listesi, sağlama toplamı, köken kanıtı ve SBOM'u doğrular. CI'da
 * yayın adımından sonra, kurumda ise indirilen sürümü denetlemek için çalışır.
 *
 * Kullanım:
 *   node scripts/supplychain.mjs verify --dir dist [--sbom sbom.json] [--strict]
 *   node scripts/supplychain.mjs manifest --dir dist          # SHA256SUMS üret
 *   node scripts/supplychain.mjs check-purl --sbom sbom.json  # CycloneDX biçim denetimi
 *
 * Doğrulama adımları:
 *   1. `SHA256SUMS` içindeki her satır: dosya var mı, özet eşleşiyor mu?
 *   2. Klasördeki her dağıtım dosyası `SHA256SUMS`'ta listelenmiş mi? (eksik özet = uyarı)
 *   3. `sbom.json` geçerli CycloneDX mi (specVersion, components, purl alanları)?
 *   4. `provenance.json` varsa: SLSA biçimi, `subject[].digest.sha256` gerçek
 *      dosyayla uyuşuyor mu, imza alanı dolu mu?
 *
 * `--strict` ile uyarılar da hata sayılır (CI için).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);

/** Bir dosyanın SHA-256 özeti (büyük dosyalar akışla okunur). */
/**
 * @param {string} file
 * @returns {string}
 */
export function sha256File(file) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** `sha256sum` biçimindeki satırları ayrıştırır: "<özet>  <dosya>". */
/**
 * @param {string} text
 * @returns {{ digest: string, file: string }[]}
 */
export function parseSums(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.push({ digest: m[1].toLowerCase(), file: m[2].trim() });
  }
  return out;
}

/** Klasördeki dosyalar için SHA256SUMS metni üretir (alt klasörler atlanır). */
/**
 * @param {string} dir
 * @param {string[]} [files]
 * @returns {string}
 */
export function buildSums(dir, files) {
  const list = files ?? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  return (
    list
      .filter((f) => f !== "SHA256SUMS")
      .sort()
      .map((f) => `${sha256File(path.join(dir, f))}  ${f}`)
      .join("\n") + "\n"
  );
}

/**
 * CycloneDX SBOM'u temel alanlar açısından doğrular.
 * @param {unknown} sbom
 * @returns {{ errors: string[], warns: string[] }}
 */
export function checkSbom(sbom) {
  const errors = [];
  const warns = [];
  if (!sbom || typeof sbom !== "object") return { errors: ["SBOM okunamadı"], warns };
  if (sbom.bomFormat !== "CycloneDX") errors.push("bomFormat CycloneDX değil");
  const ver = String(sbom.specVersion ?? "");
  if (!/^1\.[4-9]$/.test(ver)) errors.push(`specVersion desteklenmiyor: ${ver || "(yok)"}`);
  const comps = Array.isArray(sbom.components) ? sbom.components : [];
  if (comps.length === 0) errors.push("components boş");
  const noPurl = comps.filter((c) => !(c && typeof c.purl === "string" && c.purl.startsWith("pkg:")));
  if (noPurl.length) warns.push(`${noPurl.length} bileşende purl yok`);
  const noVersion = comps.filter((c) => !(c && typeof c.version === "string" && c.version));
  if (noVersion.length) warns.push(`${noVersion.length} bileşende sürüm yok`);
  if (!sbom.metadata?.timestamp) warns.push("metadata.timestamp yok");
  // Bağımlılık grafiği tutarlılığı: `dependencies` varsa kök bileşen var mı?
  if (Array.isArray(sbom.dependencies) && sbom.dependencies.length && !sbom.metadata?.component) {
    warns.push("metadata.component yok (kök bileşen tanımsız)");
  }
  // Lisans bilgisi: tıbbi yazılımda dağıtım öncesi denetim için önemli.
  const noLicense = comps.filter((c) => !c?.licenses?.length && !c?.license);
  if (noLicense.length) warns.push(`${noLicense.length} bileşende lisans alanı yok`);
  return { errors, warns };
}

/**
 * SLSA köken kanıtı (provenance) doğrulaması.
 *
 * İki biçim kabul edilir:
 *  - `https://slsa.dev/provenance/v1` (GitHub `actions/attest-build-provenance`
 *    çıktısının JSON hâli veya `slsa-verifier` özeti),
 *  - in-toto Statement sarmalı (`predicateType` = slsa.dev/provenance/v1).
 * İmza doğrulaması burada YAPILMAZ (anahtar yönetimi CI'a aittir); yalnız
 * biçim ve **özet bağlantısı** denetlenir — indirilen dosya gerçekten kanıtın
 * konusu mu?
 */
/**
 * @param {unknown} prov
 * @param {(name: string) => string | null} digestOf
 * @returns {{ errors: string[], warns: string[] }}
 */
export function checkProvenance(prov, digestOf) {
  const errors = [];
  const warns = [];
  if (!prov || typeof prov !== "object") return { errors: ["provenance okunamadı"], warns };
  const stmt = prov.predicateType ? prov : prov.statement ?? prov;
  const predType = String(stmt.predicateType ?? prov.predicateType ?? "");
  if (!/slsa\.dev\/provenance\/v1/.test(predType)) errors.push(`predicateType SLSA v1 değil: ${predType || "(yok)"}`);
  if (!Array.isArray(stmt.subject) || stmt.subject.length === 0) errors.push("subject boş");
  const missing = [];
  for (const s of stmt.subject ?? []) {
    const name = s?.name ?? "";
    const want = s?.digest?.sha256;
    if (!name || !want) { errors.push("subject ögesinde name/digest eksik"); continue; }
    const got = digestOf(name);
    if (!got) missing.push(name);
    else if (got !== String(want).toLowerCase()) errors.push(`özet uyuşmuyor: ${name}`);
  }
  if (missing.length) warns.push(`${missing.length} subject dosyası klasörde yok: ${missing.slice(0, 3).join(", ")}`);
  const builder = stmt.predicate?.runDetails?.builder?.id ?? stmt.predicate?.builder?.id ?? "";
  if (!builder) warns.push("builder kimliği yok (köken zinciri izlenemez)");
  if (!stmt.predicate && !prov.predicate) warns.push("predicate yok (build detayları eksik)");
  // İmzalı mı? DSSE zarfı (envelope) veya `signatures` dizisi beklenir.
  const signed = Boolean(prov.envelope ?? prov.signatures?.length ?? stmt.signatures?.length);
  if (!signed) warns.push("imza alanı yok — kanıt yalnız bilgi amaçlı");
  return { errors, warns };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main(argv) {
  const [cmd = "verify", ...rest] = argv;
  const arg = (name, def = "") => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] ?? def : def;
  };
  const flag = (name) => rest.includes(`--${name}`);
  const dir = path.resolve(arg("dir", "dist"));
  const strict = flag("strict");
  let errors = 0;
  let warnings = 0;
  const fail = (m) => { bad(m); errors++; };
  const soft = (m) => { warn(m); warnings++; };

  if (cmd === "manifest") {
    if (!fs.existsSync(dir)) { console.error(`Klasör yok: ${dir}`); process.exit(1); }
    const text = buildSums(dir);
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), text);
    console.log(`SHA256SUMS yazıldı (${text.trim().split("\n").length} dosya): ${path.join(dir, "SHA256SUMS")}`);
    return;
  }

  if (cmd === "check-purl" || cmd === "sbom") {
    const sbomFile = arg("sbom", path.join(dir, "sbom.json"));
    const sbom = readJson(sbomFile);
    if (!sbom) { fail(`SBOM okunamadı: ${sbomFile}`); }
    else {
      const r = checkSbom(sbom);
      r.errors.forEach(fail);
      r.warns.forEach(soft);
      if (!r.errors.length) ok(`SBOM geçerli (${sbom.components?.length ?? 0} bileşen, spec ${sbom.specVersion})`);
    }
    finish();
    return;
  }

  if (cmd !== "verify") {
    console.error(`Bilinmeyen komut: ${cmd} (verify | manifest | check-purl)`);
    process.exit(2);
  }

  // 1) SHA256SUMS
  if (!fs.existsSync(dir)) { console.error(`Klasör yok: ${dir}`); process.exit(1); }
  const sumsFile = path.join(dir, "SHA256SUMS");
  const listed = new Map();
  if (!fs.existsSync(sumsFile)) {
    strict ? fail("SHA256SUMS yok") : soft("SHA256SUMS yok — sağlama toplamı doğrulanamadı");
  } else {
    const entries = parseSums(fs.readFileSync(sumsFile, "utf8"));
    if (!entries.length) fail("SHA256SUMS boş/biçimsiz");
    for (const e of entries) {
      const f = path.join(dir, e.file);
      listed.set(e.file, e.digest);
      if (!fs.existsSync(f)) { fail(`listelenen dosya yok: ${e.file}`); continue; }
      const got = sha256File(f);
      if (got !== e.digest) fail(`özet uyuşmuyor: ${e.file}`);
    }
    if (!errors) ok(`SHA256SUMS doğrulandı (${entries.length} dosya)`);
    // Listede olmayan dağıtım dosyaları
    const extra = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => !listed.has(n) && n !== "SHA256SUMS" && !/^sbom/.test(n) && !/^provenance/.test(n));
    if (extra.length) soft(`özet listesinde olmayan dosyalar: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? "…" : ""}`);
  }

  const digestOf = (name) => {
    if (listed.has(name)) return listed.get(name);
    const f = path.join(dir, path.basename(name));
    return fs.existsSync(f) ? sha256File(f) : null;
  };

  // 2) SBOM
  const sbomFile = arg("sbom", path.join(dir, "sbom.json"));
  const sbom = readJson(sbomFile);
  if (!sbom) strict ? fail(`SBOM yok: ${sbomFile}`) : soft(`SBOM yok: ${sbomFile}`);
  else {
    const r = checkSbom(sbom);
    r.errors.forEach(fail);
    r.warns.forEach(soft);
    if (!r.errors.length) ok(`SBOM geçerli (${sbom.components?.length ?? 0} bileşen, spec ${sbom.specVersion})`);
    // SBOM'un kendisi değiştirilmedi mi? Varsa `sbom.json.sha256` yan dosyası denetlenir.
    const sumSide = `${sbomFile}.sha256`;
    if (fs.existsSync(sumSide)) {
      const want = fs.readFileSync(sumSide, "utf8").trim().split(/\s+/)[0].toLowerCase();
      want === sha256File(sbomFile) ? ok("SBOM sağlama toplamı eşleşiyor") : fail("SBOM sağlama toplamı uyuşmuyor");
    }
  }

  // 3) Köken kanıtı
  const provFile = arg("provenance", path.join(dir, "provenance.json"));
  const prov = readJson(provFile);
  if (!prov) strict ? fail(`provenance yok: ${provFile}`) : soft(`provenance yok: ${provFile}`);
  else {
    const r = checkProvenance(prov, digestOf);
    r.errors.forEach(fail);
    r.warns.forEach(soft);
    if (!r.errors.length) ok(`köken kanıtı bağlantısı doğrulandı (${prov.subject?.length ?? prov.statement?.subject?.length ?? 0} konu)`);
  }

  finish();

  function finish() {
    if (warnings) console.log(`\n${warnings} uyarı${strict ? " (--strict: hata sayıldı)" : ""}`);
    if (errors || (strict && warnings)) {
      console.error(`\nTedarik zinciri doğrulaması BAŞARISIZ (${errors} hata, ${warnings} uyarı)`);
      process.exit(1);
    }
    console.log("\nTedarik zinciri doğrulaması geçti.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

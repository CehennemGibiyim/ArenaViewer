/**
 * g-supplychain: SBOM + sağlama toplamı + SLSA köken kanıtı doğrulaması.
 *
 * `scripts/supplychain.mjs` gerçek bir `dist/` klasörüne karşı çalıştırılır
 * (geçici klasörde, depoya çöp bırakmadan). Ayrıca iş akışlarının beklenen
 * adımları (attestation, `gh attestation verify`, `--strict`) içerdiği
 * kaynak sözleşmesiyle denetlenir.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSums, checkProvenance, checkSbom, parseSums, sha256File } from "../scripts/supplychain.mjs";

const script = path.join(__dirname, "..", "scripts", "supplychain.mjs");
const root = path.join(__dirname, "..");

/** Betiği çalıştırır; çıkış kodu + çıktı döner (hata fırlatmaz). */
function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function writeSbom(file: string, over: Record<string, unknown> = {}) {
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { timestamp: "2026-01-15T10:00:00Z", component: { type: "application", name: "atikviewer", version: "0.1.0" } },
    components: [
      { type: "library", name: "next", version: "16.4.2", purl: "pkg:npm/next@16.4.2", licenses: [{ license: { id: "MIT" } }] },
      { type: "library", name: "react", version: "19.2.6", purl: "pkg:npm/react@19.2.6", licenses: [{ license: { id: "MIT" } }] },
    ],
    ...over,
  };
  fs.writeFileSync(file, JSON.stringify(sbom, null, 2));
  return sbom;
}

async function main() {
  // ── 1) Sağlama toplamı yardımcıları ────────────────────────────────────
  assert.equal(sha256File(__filename), sha(fs.readFileSync(__filename, "utf8")), "sha256File dosya özetiyle aynı");
  const sums = parseSums(`${"a".repeat(64)}  bir.zip\n${"B".repeat(64)} *iki.tar.gz\nbozuk satır\n`);
  assert.deepEqual(sums, [
    { digest: "a".repeat(64), file: "bir.zip" },
    { digest: "b".repeat(64), file: "iki.tar.gz" },
  ], "sha256sum biçimi ayrıştırılır (yıldız işareti + büyük harf)");
  console.log("PASS sağlama toplamı yardımcıları");

  // ── 2) SBOM biçim denetimi ─────────────────────────────────────────────
  const good = checkSbom({ bomFormat: "CycloneDX", specVersion: "1.6", metadata: {}, components: [{ name: "x", version: "1", purl: "pkg:npm/x@1", licenses: [{}] }] });
  assert.deepEqual(good.errors, [], "geçerli SBOM hatasız");
  const bad = checkSbom({ bomFormat: "SPDX", specVersion: "2.3", components: [] });
  assert.ok(bad.errors.some((e) => /bomFormat/.test(e)), "bomFormat denetlenir");
  assert.ok(bad.errors.some((e) => /specVersion/.test(e)), "specVersion denetlenir");
  assert.ok(bad.errors.some((e) => /components boş/.test(e)), "boş bileşen listesi hata");
  const noPurl = checkSbom({
    bomFormat: "CycloneDX", specVersion: "1.5", metadata: { timestamp: "x", component: {} },
    components: [{ name: "a", version: "1" }, { name: "b", version: "1", purl: "pkg:npm/b@1" }],
  });
  assert.ok(noPurl.warns.some((w) => /purl/.test(w)), "purl eksikliği uyarı");
  assert.ok(checkSbom(null).errors.length > 0, "boş SBOM hata");
  console.log("PASS SBOM biçim denetimi");

  // ── 3) Köken kanıtı denetimi ───────────────────────────────────────────
  const digests: Record<string, string> = { "paket.tar.gz": sha("paket") };
  const prov = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "paket.tar.gz", digest: { sha256: digests["paket.tar.gz"] } }],
    predicate: { runDetails: { builder: { id: "https://github.com/actions/runner" } } },
    signatures: [{ sig: "abc" }],
  };
  const okProv = checkProvenance(prov, (n: string) => digests[n] ?? null);
  assert.deepEqual(okProv.errors, [], "geçerli köken kanıtı hatasız");
  assert.deepEqual(okProv.warns.filter((w) => /imza/.test(w)), [], "imza varsa uyarı yok");
  const wrongDigest = checkProvenance(prov, () => "0".repeat(64));
  assert.ok(wrongDigest.errors.some((e) => /özet uyuşmuyor/.test(e)), "özet uyuşmazlığı hata");
  const missingFile = checkProvenance(prov, () => null);
  assert.ok(missingFile.warns.some((w) => /klasörde yok/.test(w)), "eksik dosya uyarı");
  const notSlsa = checkProvenance({ predicateType: "https://example.com/baska", subject: [] }, () => null);
  assert.ok(notSlsa.errors.some((e) => /SLSA v1/.test(e)), "SLSA olmayan kanıt reddedilir");
  assert.ok(notSlsa.errors.some((e) => /subject boş/.test(e)), "boş subject hata");
  const unsigned = checkProvenance({ ...prov, signatures: undefined }, (n: string) => digests[n] ?? null);
  assert.ok(unsigned.warns.some((w) => /imza alanı yok/.test(w)), "imzasız kanıt uyarı verir");
  // in-toto Statement sarmalı da kabul edilir.
  const wrapped = checkProvenance({ statement: { ...prov, signatures: undefined }, envelope: { payloadType: "application/vnd.in-toto+json" } }, (n: string) => digests[n] ?? null);
  assert.deepEqual(wrapped.errors, [], "in-toto sarmalı kabul edilir");
  console.log("PASS SLSA köken kanıtı denetimi");

  // ── 4) Uçtan uca: gerçek klasör ────────────────────────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "av-sc-"));
  try {
    fs.writeFileSync(path.join(dir, "ATIKVIEWER-0.1.0-kurulum.zip"), "kurulum");
    fs.writeFileSync(path.join(dir, "ATIKVIEWER-0.1.0-setup.exe"), "setup");

    // manifest: SHA256SUMS üretir
    const man = run(["manifest", "--dir", dir]);
    assert.equal(man.code, 0, "manifest başarılı");
    const sumsText = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
    assert.equal(sumsText.trim().split("\n").length, 2, "iki dosya özetlendi");
    assert.equal(buildSums(dir), sumsText, "buildSums aynı çıktıyı üretir");

    // SBOM yok, provenance yok → katı olmayan kipte yalnız uyarı
    const loose = run(["verify", "--dir", dir]);
    assert.equal(loose.code, 0, "eksik SBOM/kanıt normal kipte hata değil");
    assert.match(loose.out, /SBOM yok/, "SBOM eksikliği bildirilir");
    const strict = run(["verify", "--dir", dir, "--strict"]);
    assert.equal(strict.code, 1, "--strict eksikleri hataya çevirir");
    console.log("PASS SHA256SUMS üretimi + katı/gevşek kip");

    // Geçerli SBOM + kanıt → tam doğrulama
    writeSbom(path.join(dir, "sbom.json"));
    const provFile = path.join(dir, "provenance.json");
    fs.writeFileSync(provFile, JSON.stringify({
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: "ATIKVIEWER-0.1.0-kurulum.zip", digest: { sha256: sha256File(path.join(dir, "ATIKVIEWER-0.1.0-kurulum.zip")) } }],
      predicate: { runDetails: { builder: { id: "https://github.com/actions/runner" } } },
      signatures: [{ sig: "x" }],
    }));
    const full = run(["verify", "--dir", dir, "--strict"]);
    assert.equal(full.code, 0, `tam doğrulama geçer: ${full.out.slice(-400)}`);
    assert.match(full.out, /SHA256SUMS doğrulandı/, "özetler doğrulanır");
    assert.match(full.out, /SBOM geçerli/, "SBOM doğrulanır");
    assert.match(full.out, /köken kanıtı bağlantısı doğrulandı/, "kanıt bağlantısı doğrulanır");
    console.log("PASS uçtan uca doğrulama (özet + SBOM + kanıt)");

    // Oynanmış dosya yakalanır.
    fs.writeFileSync(path.join(dir, "ATIKVIEWER-0.1.0-kurulum.zip"), "kurulum-DEGISTI");
    const tampered = run(["verify", "--dir", dir]);
    assert.equal(tampered.code, 1, "oynanmış dosya yakalanır");
    assert.match(tampered.out, /özet uyuşmuyor: ATIKVIEWER-0.1.0-kurulum.zip/, "hangi dosya olduğu bildirilir");
    console.log("PASS kurcalanmış dosya tespiti");

    // Bozuk SBOM yakalanır.
    fs.writeFileSync(path.join(dir, "sbom.json"), '{"bomFormat":"SPDX","components":[]}');
    const badSbom = run(["verify", "--dir", dir, "--sbom", path.join(dir, "sbom.json")]);
    assert.equal(badSbom.code, 1, "geçersiz SBOM hataya yol açar");
    assert.match(badSbom.out, /bomFormat/, "SBOM hatası açıklanır");

    // SBOM yan sağlama toplamı
    writeSbom(path.join(dir, "sbom.json"));
    fs.writeFileSync(`${path.join(dir, "sbom.json")}.sha256`, `${"f".repeat(64)}  sbom.json\n`);
    const sideBad = run(["verify", "--dir", dir, "--sbom", path.join(dir, "sbom.json")]);
    assert.match(sideBad.out, /SBOM sağlama toplamı uyuşmuyor/, "yan özet uyuşmazlığı bildirilir");
    console.log("PASS bozuk SBOM ve yan özet denetimi");

    // Eksik argüman / bilinmeyen komut
    assert.equal(run(["bilinmeyen"]).code, 2, "bilinmeyen komut 2 döner");
    assert.equal(run(["verify", "--dir", path.join(dir, "yok")]).code, 1, "olmayan klasör hata");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 5) İş akışı sözleşmesi ─────────────────────────────────────────────
  const sbomWf = fs.readFileSync(path.join(root, ".github/workflows/sbom.yml"), "utf8");
  assert.ok(sbomWf.includes("attest-build-provenance"), "SLSA köken kanıtı üretilir");
  assert.ok(sbomWf.includes("id-token: write") && sbomWf.includes("attestations: write"), "attestation izinleri tanımlı");
  assert.ok(sbomWf.includes("gh attestation verify"), "üretilen kanıt doğrulanır");
  assert.ok(sbomWf.includes("supplychain.mjs manifest"), "sağlama toplamları üretilir");
  assert.ok(sbomWf.includes("supplychain.mjs check-purl"), "SBOM biçimi denetlenir");
  assert.ok(sbomWf.includes("--spec-version 1.6"), "CycloneDX 1.6");
  const verifyWf = fs.readFileSync(path.join(root, ".github/workflows/supplychain-verify.yml"), "utf8");
  assert.ok(verifyWf.includes("gh release download") && verifyWf.includes("gh attestation verify"), "yayınlanan sürüm bağımsız doğrulanır");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["supplychain:verify"]?.includes("supplychain.mjs verify"), "npm betiği kayıtlı");
  assert.ok(pkg.scripts["supplychain:manifest"]?.includes("manifest"), "manifest betiği kayıtlı");
  assert.ok(pkg.scripts["test:supplychain"]?.includes("supplychain.test"), "test betiği kayıtlı");
  console.log("PASS iş akışı sözleşmesi (SLSA + manifest + doğrulama)");

  console.log("Tüm g-supplychain (SBOM + SLSA köken) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

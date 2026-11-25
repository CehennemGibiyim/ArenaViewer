/**
 * t-validation: klinik doğrulama, alt grup (demografik) izleme ve kabul eşiği.
 *
 * Sınanan: DICOM yaş/cinsiyet normalizasyonu, karışıklık matrisi ve metrikler,
 * Wilson aralıkları, n eşiği davranışı, yanlılık taraması önem dereceleri,
 * sürüm karşılaştırması, gölge mod özeti ve kabul eşiği kararı.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acceptanceCheck,
  ageBand,
  compareVersions,
  DEFAULT_THRESHOLD,
  fairnessScan,
  groupMetric,
  normSex,
  parseDicomAge,
  shadowPerformance,
  subgroupMetrics,
  validationFingerprint,
  type ValidationCase,
} from "../src/lib/modelValidation";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** n olguluk grup; `tpRate` duyarlılık, `fpRate` yanlış pozitif oranı. */
function makeCases(n: number, opts: { version?: string; groups?: Record<string, string>; tp?: number; fn?: number; fp?: number }): ValidationCase[] {
  const version = opts.version ?? "v1";
  const groups = opts.groups ?? { yas: "40-59", cinsiyet: "kadin", modalite: "CR" };
  const tp = opts.tp ?? 0, fn = opts.fn ?? 0, fp = opts.fp ?? 0;
  const tn = Math.max(0, n - tp - fn - fp);
  const out: ValidationCase[] = [];
  let i = 0;
  const push = (predicted: boolean, actual: boolean) => out.push({ caseId: `${version}-${i++}`, modelVersion: version, predicted, actual, groups });
  for (let k = 0; k < tp; k++) push(true, true);
  for (let k = 0; k < fn; k++) push(false, true);
  for (let k = 0; k < fp; k++) push(true, false);
  for (let k = 0; k < tn; k++) push(false, false);
  return out;
}

function main() {
  // ── 1) Normalizasyon ────────────────────────────────────────────────
  assert.equal(ageBand(17), "<18", "17 → <18");
  assert.equal(ageBand(18), "18-39", "18 sınırı");
  assert.equal(ageBand(39), "18-39", "39");
  assert.equal(ageBand(40), "40-59", "40 sınırı");
  assert.equal(ageBand(59), "40-59", "59");
  assert.equal(ageBand(60), "60-74", "60 sınırı");
  assert.equal(ageBand(75), "75+", "75 sınırı");
  assert.equal(ageBand(null), "bilinmiyor", "yaş yok");
  assert.equal(ageBand(-3), "bilinmiyor", "negatif yaş");
  assert.equal(parseDicomAge("067Y"), 67, "DICOM yıl");
  assert.equal(parseDicomAge("045D"), 0, "gün → yıl (aşağı yuvarlanır)");
  assert.equal(parseDicomAge("012M"), 1, "ay → yıl");
  assert.equal(parseDicomAge("54"), 54, "düz sayı");
  assert.equal(parseDicomAge("bozuk"), null, "okunamaz");
  assert.equal(parseDicomAge(""), null, "boş");
  assert.equal(normSex("M"), "erkek", "DICOM M");
  assert.equal(normSex("K"), "kadin", "Türkçe K");
  assert.equal(normSex("f"), "kadin", "küçük f");
  assert.equal(normSex("E"), "erkek", "Erkek");
  assert.equal(normSex(""), "bilinmiyor", "boş cinsiyet");
  assert.equal(normSex("X"), "bilinmiyor", "tanınmayan");
  console.log("PASS yaş/cinsiyet normalizasyonu (DICOM, sınırlar)");

  // ── 2) Karışıklık matrisi ───────────────────────────────────────────
  const m = groupMetric("modalite", "CR", makeCases(100, { tp: 40, fn: 10, fp: 20 }));
  assert.deepEqual([m.n, m.tp, m.fp, m.tn, m.fn], [100, 40, 20, 30, 10], "karışıklık matrisi");
  assert.equal(m.sensitivity, 0.8, "duyarlılık = 40/50");
  assert.equal(m.specificity, 0.6, "özgüllük = 30/50");
  assert.equal(m.ppv, 40 / 60 > 0 ? Math.round((40 / 60) * 1000) / 1000 : null, "PPV");
  assert.equal(m.npv, 0.75, "NPV = 30/40");
  assert.equal(m.accuracy, 0.7, "doğruluk = 70/100");
  assert.equal(m.reliable, true, "n=100 güvenilir");
  assert.ok(m.sensitivityCi && m.sensitivityCi.lo < 0.8 && m.sensitivityCi.hi > 0.8, "Wilson aralığı ortalamayı sarar");
  assert.equal(m.sensitivityCi?.reliable, true, "n ≥ 20 aralığı güvenilir");

  const kucuk = groupMetric("yas", "75+", makeCases(4, { tp: 2, fn: 1, fp: 1 }));
  assert.equal(kucuk.reliable, false, "n=4 güvenilmez");
  assert.equal(kucuk.sensitivity, 2 / 3 > 0 ? Math.round((2 / 3) * 1000) / 1000 : null, "küçük örnekte de oran verilir");
  assert.equal(kucuk.sensitivityCi?.reliable, false, "küçük örnekte aralık güvenilmez");

  const bos = groupMetric("yas", "yok", []);
  assert.deepEqual([bos.n, bos.sensitivity, bos.specificity, bos.accuracy], [0, null, null, null], "boş grupta metrik yok (sıfır toplama)");
  assert.equal(bos.reliable, false, "boş grup güvenilmez");
  console.log("PASS karışıklık matrisi + Wilson aralığı (n eşiği)");

  // ── 3) Alt grup toplama ─────────────────────────────────────────────
  const mixed = [
    ...makeCases(60, { tp: 40, fn: 5, fp: 10, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }),
    ...makeCases(60, { tp: 30, fn: 20, fp: 5, groups: { yas: "60-74", cinsiyet: "erkek", modalite: "CR" } }),
    ...makeCases(60, { tp: 50, fn: 2, fp: 3, groups: { yas: "60-74", cinsiyet: "kadin", modalite: "CT" } }),
  ];
  const g = subgroupMetrics(mixed, ["cinsiyet"]);
  assert.deepEqual(g.map((x) => x.value), ["kadin", "erkek"], "alt gruplar sıralı");
  assert.deepEqual(g.map((x) => x.n), [120, 60], "n azalan");
  assert.equal(g[0].sensitivity, Math.round((90 / 97) * 1000) / 1000, "kadin duyarlılığı havuzlanır (90 TP / 97 pozitif)");
  const modal = subgroupMetrics(mixed, ["modalite", "yas"]);
  assert.ok(modal.some((x) => x.group === "modalite" && x.value === "CT"), "modalite boyutu");
  assert.ok(modal.some((x) => x.group === "yas" && x.value === "60-74" && x.n === 120), "yaş bandı havuzlanır");
  console.log("PASS alt grup toplama (havuzlama + sıralama)");

  // ── 4) Yanlılık taraması ────────────────────────────────────────────
  const bias = [
    ...makeCases(50, { tp: 40, fn: 10, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }), // %80
    ...makeCases(50, { tp: 25, fn: 25, groups: { yas: "60-74", cinsiyet: "kadin", modalite: "CR" } }), // %50
  ];
  const fm = subgroupMetrics(bias, ["yas"]);
  const findings = fairnessScan(fm);
  assert.equal(findings.length, 1, "tek bulgu");
  assert.equal(findings[0].severity, "kritik", "n yeterli → kritik");
  assert.equal(findings[0].gap, 0.3, "fark 30 puan");
  assert.match(findings[0].message, /en düşük duyarlılık 60-74 \(%50\)/, "en kötü grup adı geçer");

  const kucukBias = [
    ...makeCases(10, { tp: 8, fn: 2, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }),
    ...makeCases(10, { tp: 5, fn: 5, groups: { yas: "75+", cinsiyet: "kadin", modalite: "CR" } }),
  ];
  const kf = fairnessScan(subgroupMetrics(kucukBias, ["yas"]));
  assert.equal(kf[0].severity, "uyari", "n yetersiz → uyarı (kritik değil)");
  assert.match(kf[0].message, /n yetersiz: gösterge/, "uyarı gerekçesi yazılır");

  const esit = subgroupMetrics([...makeCases(50, { tp: 40, fn: 10, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }), ...makeCases(50, { tp: 40, fn: 10, groups: { yas: "60-74", cinsiyet: "kadin", modalite: "CR" } })], ["yas"]);
  assert.deepEqual(fairnessScan(esit), [], "fark yoksa bulgu yok");

  const tekGrup = fairnessScan(subgroupMetrics(makeCases(100, { tp: 80, fn: 20 }), ["yas"]));
  assert.deepEqual(tekGrup, [], "tek grupta karşılaştırma yok");
  console.log("PASS yanlılık taraması (kritik/uyarı ayrımı)");

  // ── 5) Kabul eşiği ──────────────────────────────────────────────────
  const iyi = acceptanceCheck([
    ...makeCases(200, { tp: 90, fn: 10, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }),
    ...makeCases(200, { tp: 85, fn: 15, groups: { yas: "60-74", cinsiyet: "erkek", modalite: "CR" } }),
  ]);
  assert.equal(iyi.passed, true, "iyi model eşiği geçer");
  assert.ok(iyi.checks.every((c) => c.ok), "tüm kontroller ok");
  assert.equal(iyi.checks.find((c) => c.name === "Örneklem")?.detail, "En az 100 etiketli olgu gerekir.", "örneklem detayı");

  const kucukOrnek = acceptanceCheck(makeCases(50, { tp: 45, fn: 5 }));
  assert.equal(kucukOrnek.passed, false, "az örnek eşiği geçmez");
  assert.match(kucukOrnek.checks.find((c) => c.name === "Örneklem")?.detail ?? "", /eksik: 50/, "eksik olgu sayısı");

  const zayifSens = acceptanceCheck([...makeCases(150, { tp: 90, fn: 60 })]);
  assert.equal(zayifSens.passed, false, "düşük duyarlılık reddedilir");
  assert.equal(zayifSens.checks.find((c) => c.name === "Duyarlılık")?.ok, false, "duyarlılık kontrolü düşer");
  assert.match(zayifSens.checks.find((c) => c.name === "Duyarlılık")?.detail ?? "", /%95 aralık \d+–\d+/, "aralık yazılır");

  const yanli = acceptanceCheck([
    ...makeCases(150, { tp: 120, fn: 10, groups: { yas: "40-59", cinsiyet: "kadin", modalite: "CR" } }),
    ...makeCases(150, { tp: 90, fn: 20, groups: { yas: "75+", cinsiyet: "erkek", modalite: "CR" } }),
  ]);
  assert.equal(yanli.passed, false, "alt grup farkı eşiği düşürür");
  assert.equal(yanli.checks.find((c) => c.name === "Alt grup tutarlılığı")?.ok, false, "tutarlılık kontrolü düşer");
  assert.match(yanli.checks.find((c) => c.name === "Alt grup tutarlılığı")?.value ?? "", /[12] kritik fark/, "kritik fark sayısı (yaş + cinsiyet boyutları)");

  const gevsek = acceptanceCheck(makeCases(60, { tp: 40, fn: 5, fp: 5 }), { ...DEFAULT_THRESHOLD, minN: 40, minSensitivity: 0.7, minSpecificity: 0.6 });
  assert.equal(gevsek.passed, true, "eşik özelleştirilebilir");
  console.log("PASS kabul eşiği (örneklem/duyarlılık/özgüllük/alt grup)");

  // ── 6) Sürüm karşılaştırması ────────────────────────────────────────
  const vCases = [...makeCases(200, { version: "v1", tp: 120, fn: 80 }), ...makeCases(200, { version: "v2", tp: 170, fn: 30 })];
  const cmp = compareVersions(vCases, "v1", "v2");
  assert.equal(cmp.a.sensitivity, 0.6, "v1 duyarlılığı");
  assert.equal(cmp.b.sensitivity, 0.85, "v2 duyarlılığı");
  assert.equal(cmp.deltaSens, 0.25, "fark 25 puan");
  assert.equal(cmp.overlap, false, "aralıklar örtüşmez");
  assert.match(cmp.note, /v2 daha iyi \(\+25 puan\)/, "not yönü söyler");

  const yakin = compareVersions([...makeCases(100, { version: "v1", tp: 70, fn: 30 }), ...makeCases(100, { version: "v2", tp: 74, fn: 26 })], "v1", "v2");
  assert.equal(yakin.overlap, true, "yakın sürümlerde aralık örtüşür");
  assert.match(yakin.note, /örtüşüyor/, "anlamlı fark yok denir");

  const eksik = compareVersions(makeCases(10, { version: "v1", tp: 8, fn: 2 }), "v1", "v9");
  assert.equal(eksik.deltaSens, null, "olmayan sürümde fark yok");
  assert.match(eksik.note, /n < 20/, "küçük sürüm uyarısı");
  console.log("PASS sürüm karşılaştırması (Wilson örtüşmesi)");

  // ── 7) Gölge mod özeti ──────────────────────────────────────────────
  const sp = shadowPerformance([
    { studyUid: "1", findingCount: 4, reviewed: true, confirmed: 3 },
    { studyUid: "2", findingCount: 2, reviewed: true, confirmed: 2 },
    { studyUid: "3", findingCount: 0, reviewed: false, confirmed: 0 },
  ], 2);
  assert.equal(sp.studied, 3, "gölge olgu sayısı");
  assert.equal(sp.reviewed, 2, "etiketlenen");
  assert.equal(sp.confirmed, 5, "onaylanan gölge bulgu");
  assert.equal(sp.confirmRate, Math.round((5 / 6) * 1000) / 1000, "onay oranı");
  assert.equal(sp.missedByAi, 2, "kaçırılan");
  assert.match(sp.note, /2\/3 gölge olgu/, "özet metni");
  assert.match(sp.note, /seçilmiş örnektir/, "seçilmiş örnek uyarısı");
  const bosGolge = shadowPerformance([], 0);
  assert.equal(bosGolge.confirmRate, null, "kayıt yoksa oran yok");
  assert.equal(bosGolge.note, "Gölge kaydı yok; gölge mod kapalı olabilir.", "boş durum metni");
  console.log("PASS gölge mod özeti");

  // ── 8) Parmak izi ───────────────────────────────────────────────────
  const c1 = makeCases(20, { tp: 15, fn: 5 });
  const fp1 = validationFingerprint(c1);
  assert.match(fp1, /^vd-[0-9a-f]{8}$/, "parmak izi biçimi");
  assert.equal(validationFingerprint([...c1].reverse()), fp1, "sıra bağımsız (deterministik)");
  assert.notEqual(validationFingerprint(makeCases(20, { tp: 14, fn: 6 })), fp1, "farklı veri → farklı iz");
  assert.notEqual(validationFingerprint(c1, { ...DEFAULT_THRESHOLD, minN: 50 }), fp1, "farklı eşik → farklı iz");
  assert.notEqual(validationFingerprint(makeCases(20, { tp: 15, fn: 5, version: "v2" })), fp1, "farklı sürüm → farklı iz");
  console.log("PASS doğrulama parmak izi (deterministik, eşiğe duyarlı)");

  // ── 9) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/ai/validation/route.ts");
  assert.ok(route.includes("subgroupMetrics") && route.includes("fairnessScan") && route.includes("acceptanceCheck"), "uç üç analizi de çağırır");
  assert.ok(route.includes("parseDicomAge") && route.includes("normSex"), "DICOM alanları normalize edilir");
  assert.ok(route.includes('authorize(req, ["radyolog", "yonetici"])'), "yalnız klinik roller");
  assert.ok(route.includes("yerini tutmaz"), "yanıtta sınır açıkça yazılır");
  assert.ok(route.includes("shadowPerformance"), "gölge mod bağlı");
  assert.ok(route.includes("validationFingerprint"), "kayıt anahtarı üretilir");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("Klinik doğrulama ve alt grup izleme"), "panelde kart");
  assert.ok(admin.includes("/api/ai/validation"), "panel ucu kullanır");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "t-validation"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkgJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkgJson.scripts["test:validation"]?.includes("model-validation"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm t-validation (klinik doğrulama) testleri geçti.");
}

main();

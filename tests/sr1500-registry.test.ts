/**
 * c-sr-tid1500: TID 1500 ölçüm defteri, kod defteri ve uzunlamasına izleme.
 *
 * Kritik iddia test edilir: **standart kod uydurulmaz**. Sözlükte olmayan kavram
 * yerel şemaya düşer, gerekçe kaydedilir; bozuk sözlük girişleri kabul edilmez.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { atikCode, SITES, type Measurement } from "../src/lib/sr1500";
import {
  CHANGE_RULES,
  codeText,
  codingAudit,
  compareTracked,
  documentChecks,
  EMPTY_LEXICON,
  fhirBundle,
  measurementSummary,
  parseLexicon,
  resolveCode,
  SCHEME_LABEL,
  sr1500Text,
  toFhirObservations,
  trackedCsv,
  trackingKey,
} from "../src/lib/sr1500Registry";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const LEXICON_JSON = {
  version: "kurum-2026.1",
  license: "SNOMED CT kurum lisansı",
  entries: [
    { term: "Nodül", code: { value: "27925004", scheme: "SCT", meaning: "Nodule" }, synonyms: ["noduler lezyon"] },
    { term: "Lenf nodu", code: { value: "59441001", scheme: "SCT", meaning: "Lymph node" } },
    { term: "Böbrek", code: { value: "RID20540", scheme: "RADLEX", meaning: "Kidney" } },
    { term: "suvmax", code: { value: "126105", scheme: "DCM", meaning: "SUV max" } },
  ],
};

const m = (over: Partial<Measurement> & Pick<Measurement, "trackingId" | "value">): Measurement => ({
  unit: "mm",
  quantity: { value: "410668003", scheme: "SCT", meaning: "Length" },
  finding: { value: "27925004", scheme: "SCT", meaning: "Nodule" },
  ...over,
});

function main() {
  // ── 1) Sözlük doğrulama ─────────────────────────────────────────────
  const parsed = parseLexicon(LEXICON_JSON);
  assert.equal(parsed.rejected.length, 0, "geçerli sözlük reddedilmez");
  assert.equal(parsed.lexicon.version, "kurum-2026.1", "sürüm okunur");
  assert.equal(parsed.lexicon.entries.length, 4, "dört giriş");
  assert.equal(parsed.lexicon.entries[0].term, "nodül", "terim normalize edilir");

  const bad = parseLexicon({
    version: "v",
    entries: [
      { term: "", code: { value: "1", scheme: "SCT" } },                       // boş terim
      { term: "abc", code: { value: "12", scheme: "SCT" } },                    // SCT kısa/sayısal değil
      { term: "def", code: { value: "X1", scheme: "ICD10" } },                  // desteklenmeyen şema
      { term: "ghi", code: { value: "RIDX", scheme: "RADLEX" } },               // RadLex biçimi bozuk
      { term: "jkl", code: { value: "", scheme: "LOINC" } },                    // kod değeri yok
      { term: "Çalışan", code: { value: "RID123", scheme: "RADLEX" } },         // geçerli
    ],
  });
  assert.equal(bad.lexicon.entries.length, 1, "yalnız geçerli giriş kabul edilir");
  assert.equal(bad.rejected.length, 5, "beş giriş reddedilir");
  assert.match(bad.rejected[1].reason, /SCT kodu sayısal olmalı/, "SCT biçimi açıklanır");
  assert.match(bad.rejected[2].reason, /desteklenmeyen şema: ICD10/, "şema reddi");
  assert.match(bad.rejected[3].reason, /RID###/, "RadLex biçimi");
  assert.deepEqual(parseLexicon(null).lexicon, EMPTY_LEXICON, "boş sözlüğe düşer");
  assert.match(parseLexicon([]).rejected[0].reason, /entries dizisi yok/, "dizi girdi reddedilir");
  console.log("PASS sözlük doğrulama (biçim/şema denetimi)");

  // ── 2) Kod çözümü: standart kod uydurulmaz ──────────────────────────
  const lex = parsed.lexicon;
  const std = resolveCode("Nodül", lex);
  assert.equal(std.standard, true, "sözlükteki kavram standart");
  assert.equal(std.code.value, "27925004", "SCT kodu sözlükten");
  const syn = resolveCode("NODULER  LEZYON", lex);
  assert.equal(syn.code.value, "27925004", "eşanlamlı + boşluk normalizasyonu");
  const hazir = resolveCode("beyin", lex, { beyin: SITES.beyin });
  assert.equal(hazir.code.scheme, "SCT", "hazır bölge kodu");
  assert.equal(resolveCode("serebellum", lex).standard, false, "sözlükte olmayan → standart değil");
  const yerel = resolveCode("serebellum", lex);
  assert.equal(yerel.code.scheme, "99ATIKVIEWER", "yerel şemaya düşer");
  assert.match(yerel.reason, /Sözlükte yok \(sürüm kurum-2026.1\)/, "gerekçe sürümü söyler");
  assert.match(resolveCode("x", EMPTY_LEXICON).reason, /sözlüğü tanımlı değil/, "sözlük yoksa açık gerekçe");
  assert.match(resolveCode("", lex).reason, /Kavram boş/, "boş kavram");
  assert.match(codeText(std.code), /SNOMED CT:27925004 — Nodule/, "okunur kod metni");
  assert.equal(SCHEME_LABEL["99ATIKVIEWER"], "Yerel kod", "yerel kod etiketi");
  console.log("PASS kod çözümü (standart/yerel ayrımı, uydurma yok)");

  // ── 3) Kod denetimi ─────────────────────────────────────────────────
  const ms = [
    m({ trackingId: "N1", value: 12, site: SITES.akciger }),
    m({ trackingId: "N2", value: 8, finding: atikCode("SEREBELLUM", "Serebellum") }),
  ];
  const audit = codingAudit(ms, lex);
  assert.equal(audit.total, 3, "iki bulgu + bir bölge");
  assert.equal(audit.standard, 2, "akciğer + Nodule standart");
  assert.equal(audit.local, 1, "bir yerel kod");
  assert.equal(audit.standardRatio, 0.667, "oran");
  assert.deepEqual(audit.localReasons, ["Serebellum"], "yerel gerekçe listesi");
  assert.match(audit.note, /Standart kod uydurulmadı/, "not uydurma yasağını yazar");
  assert.equal(codingAudit([], lex).standardRatio, null, "ölçüm yoksa oran null");
  assert.match(codingAudit([m({ trackingId: "A", value: 1, site: SITES.beyin })], lex).note, /Tüm kodlar standart/, "tamamı standart");
  console.log("PASS kod denetimi (standart oranı + gerekçe)");

  // ── 4) İzleme anahtarı ve belge denetimleri ─────────────────────────
  assert.equal(trackingKey({ trackingId: "N1", trackingUid: "1.2.3", finding: ms[0].finding }), "uid:1.2.3", "UID varsa o kullanılır");
  assert.equal(trackingKey({ trackingId: "N1", finding: ms[0].finding, site: SITES.akciger }), "id:39607008|27925004|N1", "site|bulgu|kimlik");
  assert.notEqual(trackingKey({ trackingId: "N1", finding: ms[0].finding }), trackingKey({ trackingId: "N2", finding: ms[0].finding }), "farklı izlemeler ayrışır");

  const okChecks = documentChecks({ studyUid: "1.2.3", patientId: "P1", measurements: [m({ trackingId: "N1", value: 5 }), m({ trackingId: "N2", value: 7 })] });
  assert.equal(okChecks.ok, true, "sağlıklı belge");
  const badChecks = documentChecks({
    studyUid: "", patientId: "",
    measurements: [m({ trackingId: "N1", value: 5 }), m({ trackingId: "N1", value: 6 }), m({ trackingId: "N3", value: NaN })],
  });
  assert.equal(badChecks.ok, false, "sorunlar yakalanır");
  assert.ok(badChecks.problems.some((p) => p.includes("Çalışma UID")), "UID sorunu");
  assert.ok(badChecks.problems.some((p) => p.includes("Hasta kimliği")), "kimlik sorunu");
  assert.ok(badChecks.problems.some((p) => p.includes("aynı izleme anahtarı")), "mükerrer izleme");
  assert.ok(badChecks.problems.some((p) => p.includes("sayısal değil")), "NaN değer");
  console.log("PASS izleme anahtarı + belge denetimi");

  // ── 5) Uzunlamasına karşılaştırma ───────────────────────────────────
  const prev = [m({ trackingId: "N1", value: 10, trackingUid: "1.1" }), m({ trackingId: "N2", value: 20, trackingUid: "1.2" }), m({ trackingId: "N3", value: 5, trackingUid: "1.3" })];
  const cur = [
    m({ trackingId: "N1", value: 16, trackingUid: "1.1" }), // +6 mm %60 → büyüme
    m({ trackingId: "N2", value: 21, trackingUid: "1.2" }), // +5% → stabil
    m({ trackingId: "N4", value: 9, trackingUid: "1.4" }), // yeni
  ];
  const changes = compareTracked(prev, cur);
  const byId = (id: string) => changes.find((c) => c.trackingId === id)!;
  assert.equal(byId("N1").change, "buyume", "eşiği aşan büyüme");
  assert.equal(byId("N1").delta, 6, "fark 6 mm");
  assert.equal(byId("N1").deltaPct, 0.6, "yüzde 60");
  assert.match(byId("N1").note, /Büyüme: 10 → 16/, "okunur not");
  assert.equal(byId("N2").change, "stabil", "küçük fark stabil");
  assert.equal(byId("N3").change, "kayboldu", "ölçülmeyen izleme kayboldu");
  assert.equal(byId("N3").current, null, "şimdiki değer yok");
  assert.equal(byId("N4").change, "yeni", "yeni ölçüm");
  assert.equal(changes.length, 4, "birleşim anahtar kümesi");

  // Sınır davranışı: yüzde eşiği tek başına yetmez (mutlak 5 mm de gerekir).
  const kucukBuyume = compareTracked([m({ trackingId: "S1", value: 2, trackingUid: "u1" })], [m({ trackingId: "S1", value: 3, trackingUid: "u1" })]);
  assert.equal(kucukBuyume[0].change, "stabil", "%50 ama +1 mm → stabil (mutlak eşik)");
  const kuculme = compareTracked([m({ trackingId: "S2", value: 30, trackingUid: "u2" })], [m({ trackingId: "S2", value: 20, trackingUid: "u2" })]);
  assert.equal(kuculme[0].change, "kuculme", "%33 küçülme");
  assert.equal(CHANGE_RULES.growthAbs, 5, "mutlak eşik 5 mm");
  assert.equal(compareTracked([], []).length, 0, "boş karşılaştırma");

  const csv = trackedCsv(changes);
  const lines = csv.split("\n");
  assert.equal(lines[0], "İzleme;Önceki;Şimdiki;Fark;Fark %;Sınıf;Not", "CSV başlığı");
  assert.equal(lines.length, 5, "başlık + dört satır");
  assert.match(csv, /N1;10;16;6;60;buyume/, "CSV satırı");
  assert.equal(csv.split("\n")[1].split(";").length, 7, "noktalı virgül kaçışı korunur");
  console.log("PASS uzunlamasına karşılaştırma (eşikler + CSV)");

  // ── 6) Özet, FHIR ve metin ──────────────────────────────────────────
  const summary = measurementSummary(ms);
  assert.equal(summary[0].ucum, "mm", "UCUM birimi");
  assert.equal(summary[0].site, "Lung", "bölge adı");
  assert.equal(summary[1].findingScheme, "99ATIKVIEWER", "yerel şema korunur");
  assert.match(sr1500Text(summary, audit), /^TID 1500 ölçüm raporu \(2 ölçüm\)/, "metin başlığı");
  assert.equal(sr1500Text([], audit), "TID 1500: yazılabilir sayısal ölçüm yok.", "boş metin");

  const obs = toFhirObservations(ms, { patientId: "P1", patientName: "AYSE YILMAZ" }, "1.2.3");
  assert.equal(obs.length, 2, "iki Observation");
  const o0 = obs[0] as { code: { coding: { system: string }[] }; valueQuantity: { value: number; code: string; system: string }; bodySite?: { coding: { system: string; code: string }[] } };
  assert.equal(o0.code.coding[0].system, "http://snomed.info/sct", "SCT sistemi");
  assert.equal(o0.valueQuantity.value, 12, "değer");
  assert.equal(o0.valueQuantity.code, "mm", "UCUM kodu");
  assert.equal(o0.valueQuantity.system, "http://unitsofmeasure.org", "UCUM sistemi");
  assert.equal(o0.bodySite?.coding[0].code, "39607008", "bölge kodu FHIR'de");
  const o1 = obs[1] as { note: { text: string }[] };
  assert.match(o1.note[0].text, /Yerel kod|99ATIKVIEWER|Serebellum/, "yerel kod notta belirtilir");
  const bundle = fhirBundle(obs) as { resourceType: string; total: number; entry: unknown[] };
  assert.equal(bundle.resourceType, "Bundle", "demet");
  assert.equal(bundle.total, 2, "toplam");
  assert.equal(bundle.entry.length, 2, "girişler");
  console.log("PASS özet + FHIR Observation demeti");

  // ── 7) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/measurements/route.ts");
  assert.ok(route.includes("resolveCode") && route.includes("codingAudit"), "uç kod çözümü ve denetimi çağırır");
  assert.ok(route.includes("buildMeasurementReportSr"), "TID 1500 belgesi üretilir");
  assert.ok(route.includes("stowInstance"), "PACS gönderimi bağlı");
  assert.ok(route.includes("sr1500.lexicon_update") && route.includes("sr1500.build"), "denetim kayıtları");
  assert.ok(route.includes('authorize(req, ["yonetici"])'), "sözlük yükleme yalnız yönetici");
  assert.ok(route.includes("compareTracked"), "uzunlamasına karşılaştırma uçta");
  const menu = read("src/components/ExportMenu.tsx");
  assert.ok(menu.includes("deftere işle"), "menüde kayıt akışı");
  assert.ok(menu.includes("STOW"), "menüde PACS gönderimi");
  assert.ok(menu.includes('apiFetch("/api/measurements"'), "CSRF'li istemci");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "c-sr-tid1500"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:sr1500reg"]?.includes("sr1500-registry"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm c-sr-tid1500 (ölçüm defteri) testleri geçti.");
}

main();

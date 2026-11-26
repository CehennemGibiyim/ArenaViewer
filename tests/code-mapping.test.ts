/**
 * Kurum kod eşleme tablosu testleri (c-sr-tid1500).
 *
 * Amaç: lisanslı RadLex/SNOMED CT sözlüğünü **yazılım dağıtmaz**; kurumun verdiği
 * dosya okunur, doğrulanır ve TID 1500 belgesinde yalnız özel (99ATIKVIEWER)
 * kodlar bu tabloyla değiştirilir. Uydurma kod yazılmaz: eşleşme yoksa özel şema
 * ve yedek kod korunur.
 *
 * Testler gerçek `dicom-parser` ile üretilen SR'ı okuyup kod değerini/şemasını
 * denetler — yani kanıt belge düzeyinde.
 */
import assert from "node:assert/strict";
import { parseDicom } from "dicom-parser";
import {
  codeFormatError, mapCodeObject, mapTerm, mappingCoverage, normalizeScheme, normalizeTerm, parseCodeTable,
} from "../src/lib/codeMapping";
import { buildMeasurementReportSr, atikCode, QUANTITY, SITES, unitCode } from "../src/lib/sr1500";
import { siteCode } from "../src/lib/measurementExport";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ─────────── şema ve biçim kuralları ───────────
ok(normalizeScheme("radlex") === "RID" && normalizeScheme("RadLex") === "RID", "RadLex → RID");
ok(normalizeScheme("snomed ct") === "SCT" && normalizeScheme("SNOMED-CT") === "SCT", "SNOMED CT → SCT");
ok(normalizeScheme("loinc") === "LN" && normalizeScheme("ucum") === "UCUM", "LOINC → LN, UCUM korunur");
ok(normalizeScheme("yerel") === null, "bilinmeyen şema reddedilir (null)");

ok(codeFormatError("RID", "RID4321") === null, "RID4321 geçerli");
ok(codeFormatError("RID", "RID-4321") !== null, "RID-4321 geçersiz (tire yok)");
ok(codeFormatError("SCT", "363698007") === null, "SNOMED 363698007 geçerli");
ok(codeFormatError("SCT", "1234") !== null, "SNOMED 1234 geçersiz (kısa)");
ok(codeFormatError("LN", "56816-2") === null, "LOINC 56816-2 geçerli");
ok(codeFormatError("UCUM", "mm") === null && codeFormatError("UCUM", "a b") !== null, "UCUM boşluksuz olmalı");
ok(codeFormatError("SCT", "") !== null, "boş kod reddedilir");

ok(normalizeTerm("  Akciğer  ") === normalizeTerm("akciger"), "Türkçe karakter katlanır (akciğer = akciger)");
ok(normalizeTerm("Sağ  Üst Lob") === "sag ust lob", `iç boşluklar tek boşluk: ${normalizeTerm("Sağ  Üst Lob")}`);

// ─────────── CSV okuma ───────────
const csv = [
  "key,code,scheme,meaning",
  "akciger,RID4321,RadLex,akciğer",
  "sag ust lob,RID4322,RadLex,sağ üst lob",
  "uzunluk,410668003,SCT,Length",
  "hacim,G-D705,SRT,Volume",
  "bad rid,RID12X,RadLex,bozuk kod",
  "bilinmeyen,123,yerel,şema yok",
  "akciger,363698007,SCT,akciğer (yinelenen)",
  "boş anahtar,,RID1111,deneme",
].join("\r\n");

const table = parseCodeTable("\uFEFF" + csv, { source: "kurum.csv" });
ok(table.source === "kurum.csv", "kaynak (denetim izi) korunur");
ok(table.entries.get("akciger")?.value === "363698007", "yinelenen anahtarda son satır geçerli");
ok(table.entries.get("akciger")?.scheme === "SCT", "yinelenen satırın şeması uygulandı");
ok(table.warnings.some((w) => w.includes("yinelen")), `yinelenme uyarısı: ${table.warnings[0] ?? "-"}`);
ok(table.errors.length === 4, `4 bozuk satır reddedildi (${table.errors.length}): ${table.errors.join(" | ")}`);
ok(table.errors.some((e) => e.includes("RID12X")), "geçersiz RadLex kodu satırıyla raporlandı");
ok(table.errors.some((e) => e.includes("bilinmeyen şema")), "bilinmeyen şema reddedildi");
ok(table.entries.get("sag ust lob")?.value === "RID4322", "Türkçe anahtar normalize edilerek saklandı");
ok(table.entries.get("uzunluk")?.scheme === "SCT", "LOINC/SCT karışık tablo kabul edilir");
ok(!table.entries.has("hacim"), "SRT şeması tanınmıyor → satır kabul edilmedi");

// noktalı virgül / sekme ayırıcı
const semi = parseCodeTable("key;code;scheme\nbeyin;RID6434;RadLex\nnodul;RID3874;RadLex");
ok(semi.accepted === 2 && semi.entries.get("beyin")?.value === "RID6434", "noktalı virgül ayırıcı okunur");
const tsv = parseCodeTable("key\tcode\tscheme\tmeaning\nkaraciger\tRID58\tRadLex\tkaraciğer");
ok(tsv.accepted === 1 && tsv.entries.get("karaciger")?.scheme === "RID", "sekme ayırıcı okunur");

// tırnaklı alan
const quoted = parseCodeTable('key,code,scheme,meaning\nakciger,RID4321,RadLex,"akciğer, sağ"');
ok(quoted.accepted === 1, "tırnaklı alan tek hücre olarak okunur");
ok(quoted.entries.get("akciger")?.meaning === "akciğer, sağ", `tırnak içindeki virgül korunur (${quoted.entries.get("akciger")?.meaning})`);

// boş/hatalı dosyalar
ok(parseCodeTable("").errors.length === 1, "boş dosya reddedilir");
ok(parseCodeTable("a,b,c\n1,2,3").errors[0].includes("başlık"), "başlıksız CSV reddedilir");
ok(parseCodeTable("{ bozuk json").errors[0].includes("JSON"), "bozuk JSON raporlanır");

// ─────────── JSON okuma ───────────
const jsonTable = parseCodeTable(JSON.stringify({
  entries: [
    { key: "akciğer", code: "RID4321", scheme: "RadLex", meaning: "akciğer" },
    { key: "nodül", code: "RID3874", scheme: "RID", meaning: "nodül" },
    { key: "kötü", code: "RID1", scheme: "RID" },
    { key: "bozuk", code: "ABC", scheme: "SCT" },
  ],
}));
ok(jsonTable.accepted === 3, `JSON: 3 geçerli satır (${jsonTable.accepted})`);
ok(jsonTable.errors.length === 1 && jsonTable.errors[0].includes("ABC"), "JSON: geçersiz SCT kodu reddedildi");
ok(jsonTable.entries.get("akciger")?.value === "RID4321", "JSON anahtarı da normalize edilir");

// ─────────── eşleme ve yedek ───────────
const fallback = atikCode("SITE", "akciğer");
const mapped = mapTerm("akciğer", fallback, jsonTable);
ok(mapped.mapped && mapped.code.value === "RID4321", "eşleşen terim lisanslı koda çevrilir");
const unmapped = mapTerm("prostat", fallback, jsonTable);
ok(!unmapped.mapped && unmapped.code === fallback, "eşleşmeyen terim yedek kodu korur (uydurma yok)");
ok(mapTerm("akciğer", fallback, null).mapped === false, "tablo yoksa yedek kod");

// özel kod → tablo; standart kod → dokunulmaz
const custom = mapCodeObject(atikCode("NODULE", "Nodül"), jsonTable);
ok(custom.mapped && custom.code.value === "RID3874", "özel kod (99ATIKVIEWER) tablodan eşlendi");
const standard = mapCodeObject(SITES.akciger, jsonTable);
ok(!standard.mapped && standard.code.value === SITES.akciger.value, "standart SNOMED kodu tablo tarafından ezilmez");

const cov = mappingCoverage(["akciğer", "prostat", "nodül"], jsonTable);
ok(cov.total === 3 && cov.mapped === 2 && cov.missing.join(",") === "prostat", `kapsam: ${cov.mapped}/${cov.total}`);

// bölge kodu üretimi tablo ile
ok(siteCode("akciğer", jsonTable).value === "RID4321", "siteCode tablo ile lisanslı kodu döndürür");
ok(siteCode("akciğer").value === SITES.akciger.value, "tablo yoksa mevcut SNOMED eşlemesi korunur");
ok(siteCode("bilinmeyen bölge", jsonTable).scheme === "99ATIKVIEWER", "eşlenmeyen bölge yine özel şemada kalır");

// ─────────── uçtan uca: SR belgesinde lisanslı kod ───────────
const measurements = [
  {
    trackingId: "NOD-1", value: 8.4, unit: "mm", quantity: QUANTITY.length,
    finding: atikCode("NODULE", "Nodül"), site: undefined,
    image: { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUid: "1.2.3.4.1.9" },
  },
  {
    trackingId: "HU-1", value: -45.25, unit: "hu", quantity: QUANTITY.mean,
    finding: atikCode("DENSITY", "Dansite"),
  },
];
const baseInput = {
  patientName: "Test^Hasta", patientId: "TR-1", patientSex: "K",
  studyUid: "1.2.840.113619.2.9.9", studyDate: "2026-11-20", institution: "TEST",
  measurements,
};

const plainBytes = buildMeasurementReportSr(baseInput);
const mappedBytes = buildMeasurementReportSr({ ...baseInput, codeTable: jsonTable });
const srPlain = parseDicom(new Uint8Array(plainBytes));
const srMapped = parseDicom(new Uint8Array(mappedBytes));
ok(!!srPlain && !!srMapped, "her iki SR belgesi dicom-parser ile okunabiliyor");

/** Belge baytlarını ASCII metne çevirir (kod/şema alanları ASCII'dir). */
const latin = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

const plain = latin(plainBytes);
const mappedStr = latin(mappedBytes);
ok(plain.includes("99ATIKVIEWER") && plain.includes("NODULE"), "tablosuz belgede özel şema (99ATIKVIEWER) var");
ok(!mappedStr.includes("NODULE"), "eşlenen bulgu kodu (NODULE) belgede özel kod olarak kalmadı");
ok(mappedStr.includes("DENSITY"), "eşlenmeyen bulgu (DENSITY) dürüstçe özel şemada kalır");
ok(plain.includes("DENSITY") && plain.includes("NODULE"), "tablosuz belgede iki bulgu da özel kodlu");
ok(mappedStr.includes("RID3874"), "tablolu belgede lisanslı RadLex kodu (NODUL) yazıldı");
ok(mappedStr.includes("RID3874") && mappedStr.includes("RID"), "kodlama şeması alanı RID");
ok(mappedStr.includes("410668003"), "standart SNOMED uzunluk kodu korunur");

if (failed) { console.error(`${failed} kod eşleme testi başarısız`); process.exit(1); }
console.log("Tüm kod eşleme (kurum sözlüğü) testleri geçti.");

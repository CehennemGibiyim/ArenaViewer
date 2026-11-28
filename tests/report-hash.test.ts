/**
 * Rapor snapshot ölçüm/SR hash'leri (r-version) testleri.
 *
 * Kapsam: snapshot kapsamına eklenen ölçüm hash'i (ölçüm metninden) ve SR
 * içerik hash'i (SR metnini üreten girdilerden) saf çekirdek doğrulaması;
 * kayıt ve geri yükleme yollarındaki sözleşme kontrolleri; eski snapshot'larda
 * hash tanımlı olmadığı için tolerans.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  measurementHash, srHashOf, normalizeMeasurementsText,
  matchesMeasurementHash, matchesSrHash,
} from "../src/lib/reportHash";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── ölçüm metni normalizasyonu ──
ok(normalizeMeasurementsText("a\n\n  b\n\tc  ") === "a\nb\nc", "ölçüm metni boş satır/kirli boşluk temizlenir");
ok(normalizeMeasurementsText("") === "", "boş ölçüm metni korunur");
ok(normalizeMeasurementsText("sade") === "sade", "tek satır ölçüm metni sabit");

// ── ölçüm hash'i ──
const m1 = measurementHash("NOD-1: 12 mm\nNOD-2: 8 mm3");
const m2 = measurementHash("NOD-1: 12 mm\nNOD-2: 8 mm3");
ok(m1.length === 64, "ölçüm hash'i SHA-256 64 hex karakterdir");
ok(m1 === m2, "özdeş ölçüm metniAynı hash verir");
const m3 = measurementHash("NOD-1: 12 mm\nNOD-2: 9 mm3");
ok(m1 !== m3, "farklı ölçüm metni farklı hash verir");
ok(measurementHash("a\nb\nc") === measurementHash("a\n\nb\n\nc"), "boş satırlar hash'i etkilemez (normalizasyon)");
ok(measurementHash("  a  ") === measurementHash("a"), "kirli boşluklar hash'i etkilemez");
ok(measurementHash("") !== measurementHash("x"), "boş ve dolar ölçüm hash'leri farklı");
ok(measurementHash(undefined) === "" && measurementHash(null) === "", "ölçüm metni tanımlı değilse boş hash");

// ── SR içerik hash'i ──
const srBase = srHashOf({
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankim doğal",
  impression: "Normal", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
});
const srAgain = srHashOf({
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankim doğal",
  impression: "Normal", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
});
ok(srBase.length === 64, "SR hash'i SHA-256 64 hex karakterdir");
ok(srBase === srAgain, "özdeş SR girdileri aynı hash verir");
const srAlt = srHashOf({
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankimde nodul",
  impression: "Nodül", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
});
ok(srBase !== srAlt, "findingsText değişirse SR hash'i değişir");
const srTech = srHashOf({
  clinicalInfo: "Ad Soyad", technique: "MR", findingsText: "Parankim doğal",
  impression: "Normal", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
});
ok(srBase !== srTech, "technique değişirse SR hash'i değişir");
const srMeas = srHashOf({
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankim doğal",
  impression: "Normal", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 13 mm",
});
ok(srBase !== srMeas, "ölçüm metni değişirse SR hash'i değişir");
// measurementsText varsa srMeasurementsText tercih edilir, measurementsText değil
const srBoth = srHashOf({
  technique: "BT", findingsText: "x", impression: "y", recommendation: "z",
  measurementsText: "A", srMeasurementsText: "B",
});
const srOnly = srHashOf({
  technique: "BT", findingsText: "x", impression: "y", recommendation: "z", srMeasurementsText: "B",
});
ok(srBoth === srOnly, "srMeasurementsText measurementsText'ten tercih edilir");
// boş ölçüm ile yine de tutarlı
const srEmpty = srHashOf({ technique: "BT", findingsText: "x", impression: "y", recommendation: "z" });
ok(srEmpty.length === 64, "ölçüm tanımlı değilse de SR hash'i üretilir");

// ── eşleşme kontrolleri ──
ok(matchesMeasurementHash(m1, "NOD-1: 12 mm\nNOD-2: 8 mm3") === true, "snapshot ölçüm hash'i mevcut ölçümle eşleşiyor");
ok(matchesMeasurementHash(m1, "NOD-1: 12 mm\nNOD-2: 9 mm3") === false, "snapshot ölçüm hash'i farklı ölçümle eşleşmez");
ok(matchesMeasurementHash("", "NOD-1: 12 mm") === false, "boş snapshot hash'i eşleşmez");
ok(matchesMeasurementHash(undefined, "NOD-1: 12 mm") === false, "tanımlı olmayan snapshot hash'i eşleşmez");
ok(matchesMeasurementHash(m1, undefined) === false, "ölçüm metni tanımlı değilse eşleşmez");
ok(matchesSrHash(srBase, {
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankim doğal",
  impression: "Normal", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
}) === true, "snapshot SR hash'i mevcut içerikle eşleşiyor");
ok(matchesSrHash(srBase, {
  clinicalInfo: "Ad Soyad", technique: "BT", findingsText: "Parankimde nodul",
  impression: "Nodül", recommendation: "Kontrol yok", srMeasurementsText: "NOD-1: 12 mm",
}) === false, "snapshot SR hash'i farklı içerikle eşleşmez");
ok(matchesSrHash("", { technique: "BT" }) === false, "boş SR hash'i eşleşmez");

// ── kaynak tel bağlantısı (DB'siz unit ortamında rota sözleşmesi) ──
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const saveRoute = read("src/app/api/reports/route.ts");
ok(saveRoute.includes("measurementHash: measurementHash(r.measurementsText)"), "kayıt snapshot'ına ölçüm hash'i yazıyor");
ok(saveRoute.includes("srHash: srHashOf"), "kayıt snapshot'ına SR hash'i yazıyor");
ok(saveRoute.includes("measurementsText?: string"), "kayıt sözleşmesi ölçüm metnini kabul ediyor");
const restore = read("src/app/api/reports/[id]/restore/route.ts");
ok(restore.includes("measurementHash: snap.measurementHash"), "geri yükleme snapshot'ından ölçüm hash'ini taşıyor");
ok(restore.includes("srHash: snap.srHash"), "geri yükleme snapshot'ından SR hash'ini taşıyor");
ok(restore.includes("measurementHash: snap.measurementHash ?? \"\""), "geri yükleme yanıtı ölçüm hash'ini döndürüyor");
ok(restore.includes("srHash: snap.srHash ?? \"\""), "geri yükleme yanıtı SR hash'ini döndürüyor");
const workstation = read("src/components/Workstation.tsx");
ok(workstation.includes("measurementsText },"), "Workstation kayıt çağrısında ölçüm metnini gönderiyor");
const reportHash = read("src/lib/reportHash.ts");
ok(reportHash.includes("export function measurementHash"), "ölçüm hash'i çekirdeği çıktı olarak tanımlı");
ok(reportHash.includes("export function srHashOf"), "SR hash'i çekirdeği çıktı olarak tanımlı");

if (failed) { console.error(`${failed} ölçüm/SR hash testi başarısız`); process.exit(1); }
console.log("Tüm ölçüm/SR hash testi başarılı");

/** Model operasyonları testleri: kalibrasyon/ECE, drift, parmak izi. */
import assert from "node:assert/strict";
import { calibrationBins, driftCheck, expectedCalibrationError, modelFingerprint } from "../src/lib/modelOps";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// Kalibrasyon
const iyi = [
  ...Array.from({ length: 10 }, () => ({ score: 0.1, approved: false })),
  ...Array.from({ length: 10 }, () => ({ score: 0.9, approved: true })),
];
const bins = calibrationBins(iyi, 5);
ok(bins[0].n === 10 && bins[0].empirical === 0, "Kalibrasyon: düşük skor bininde ampirik oran 0");
ok(bins[4].n === 10 && bins[4].empirical === 1, "Kalibrasyon: yüksek skor bininde ampirik oran 1");
ok(expectedCalibrationError(bins)! < 0.1, `ECE düşük (bulunan: ${expectedCalibrationError(bins)?.toFixed(3)})`);

const kotu = [
  ...Array.from({ length: 10 }, () => ({ score: 0.9, approved: false })),
  ...Array.from({ length: 10 }, () => ({ score: 0.1, approved: true })),
];
const eceKotu = expectedCalibrationError(calibrationBins(kotu, 5))!;
ok(eceKotu > 0.7, `ECE ters kalibrasyonda yüksek (${eceKotu.toFixed(3)})`);
ok(calibrationBins([], 5).every((b) => b.n === 0), "Kalibrasyon: boş veri → boş binler");

// Drift
ok(driftCheck(null, 0.8, 200).status === "yok", "Drift: taban çizgisi yok → kayma yok");
ok(driftCheck(0.8, 0.42, 200).status === "sapma", "Drift: belirgin kayma → sapma");
ok(driftCheck(0.8, 0.78, 200).status === "yok", "Drift: küçük fark → kayma yok");
ok(driftCheck(0.8, 0.6, 200).status === "izle", `Drift: orta kayma izleme konumunda (z=${driftCheck(0.8, 0.6, 200).z?.toFixed(2)})`);

// Parmak izi
ok(modelFingerprint({ a: "1", b: "2" }) === modelFingerprint({ b: "2", a: "1" }), "Parmak izi anahtar sırasından bağımsız");
ok(modelFingerprint({ a: "1" }) !== modelFingerprint({ a: "2" }), "Parmak izi değer değişince değişir");

if (failed) { console.error(`${failed} model operasyonu testi başarısız`); process.exit(1); }
console.log("Tüm model operasyonları testleri geçti.");

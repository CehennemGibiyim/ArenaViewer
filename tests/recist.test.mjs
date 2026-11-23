// RECIST 1.1 birim testi — çalıştırma:
//   node --experimental-strip-types tests/recist.test.mjs
import assert from "node:assert";
import { recist11, recistCsv } from "../src/lib/recist.ts";

const T = (label, pts) => ({ id: label, label, points: pts });

// 1) PR: 30 → 21 mm = -%30 (eşik dahil)
let r = recist11([
  T("N1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-04-01", diameterMm: 7 }]),
  T("N2", [{ date: "2026-01-01", diameterMm: 20 }, { date: "2026-04-01", diameterMm: 14 }]),
]);
assert.equal(r.response, "PR", "PR bekleniyordu: " + r.response);
assert.equal(r.baselineSumMm, 30);
assert.equal(r.followUpSumMm, 21);
assert.equal(r.targetCount, 2);
assert.equal(r.deltaPct, -30);

// 2) SD: 10 → 13 mm = +%30 ama mutlak +3 mm (< 5 mm) → PD değil
r = recist11([T("L1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-02-01", diameterMm: 13 }])]);
assert.equal(r.response, "SD", "SD bekleniyordu: " + r.response);

// 3) PD: 30 → 39 mm = +%30 ve +9 mm
r = recist11([
  T("N1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-04-01", diameterMm: 13 }]),
  T("N2", [{ date: "2026-01-01", diameterMm: 20 }, { date: "2026-04-01", diameterMm: 26 }]),
]);
assert.equal(r.response, "PD", "PD bekleniyordu: " + r.response);

// 4) Yeni lezyon → PD (hekim işareti)
r = recist11([T("L1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-02-01", diameterMm: 8 }])], { newLesion: true });
assert.equal(r.response, "PD");

// 5a) İZLEM ÖLÇÜMÜ OLMAMASI "kayboldu" DEĞİLDİR — sahte CR üretilmez
r = recist11([
  T("L1", [{ date: "2026-01-01", diameterMm: 12 }, { date: "2026-03-01", diameterMm: 12 }]),
  T("L2", [{ date: "2026-01-01", diameterMm: 8 }]),
]);
assert.equal(r.followUpSumMm, 12);
assert.notEqual(r.response, "CR", "Ölçüm yokken CR üretilememeli");

// 5b) CR yalnız hekim işaretiyle
r = recist11([T("L1", [{ date: "2026-01-01", diameterMm: 12 }, { date: "2026-03-01", diameterMm: 0.1 }])], { allDisappeared: true });
assert.equal(r.response, "CR");

// 6) Tek zaman noktası → hesap yok
assert.equal(recist11([T("L1", [{ date: "2026-01-01", diameterMm: 5 }])]), null);

// 7) Bazalda olmayan lezyon toplama girmez ve işaretlenir
r = recist11([
  T("L1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-05-01", diameterMm: 10 }]),
  T("YENİ", [{ date: "2026-05-01", diameterMm: 6 }]),
]);
assert.equal(r.targetCount, 1);
assert.equal(r.lesions.find((l) => l.label === "YENİ").notAtBaseline, true);
assert.equal(r.response, "SD");

// 8) CSV çıktısı
const csv = recistCsv(r);
assert.match(csv, /RECIST 1\.1/);
assert.match(csv, /Bazal toplam/);

console.log("RECIST 1.1: 8/8 test geçti ✓");
console.log("  örnek yanıt:", recist11([
  T("N1", [{ date: "2026-01-01", diameterMm: 10 }, { date: "2026-04-01", diameterMm: 7 }]),
  T("N2", [{ date: "2026-01-01", diameterMm: 20 }, { date: "2026-04-01", diameterMm: 14 }]),
]).responseLabel);

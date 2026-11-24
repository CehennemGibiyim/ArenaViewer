/**
 * Kantitatif modül testleri: ASPECTS + CTP özeti (stroke.ts), akciğer
 * kantitasyonu (lungQuant.ts), nükleer tıp yardımcıları (nuclear.ts).
 */
import { aspectsScore } from "../src/lib/stroke";
import { ctpSummary } from "../src/lib/stroke";
import { lungQuant } from "../src/lib/lungQuant";
import { metabolicTumorVolume, subtractionSummary, ticCurve } from "../src/lib/nuclear";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── ASPECTS ──
ok(aspectsScore([]).score === 10, "ASPECTS: anormal bölge yok → 10");
ok(aspectsScore(["M1", "M2", "insularRibbon"]).score === 7, "ASPECTS: 3 anormal bölge → 7");
ok(aspectsScore(["bogus", "M4"]).abnormal.length === 1, "ASPECTS: tanımsız bölge yok sayılır");

// ── CTP ──
const aif = { t: [0, 5, 10], v: [0, 100, 20] };
const dokuGecikmeli = { t: [0, 10, 20, 25], v: [0, 60, 70, 65] };
const ctp = ctpSummary({ tissue: dokuGecikmeli, aif });
ok(ctp.penumbraLikely && !ctp.coreLikely, `CTP: gecikme ${ctp.delaySec}s > 6 sn ve CBF oranı ${ctp.cbfRatio?.toFixed(2)} → penumbra adayı`);
const ctpCore = ctpSummary({ tissue: { t: [0, 10, 20, 25], v: [0, 10, 12, 10] }, aif });
ok(ctpCore.coreLikely, "CTP: düşük zirve/CBF oranı <0.30 → core adayı");
ok(ctp.caveat.includes("dekonvolüsyon"), "CTP: sorumluluk/not metni var");

// ── Akciğer kantitasyonu ──
const agir = lungQuant([
  { lo: -1000, hi: -950, count: 950 },
  { lo: -950, hi: -850, count: 40 },
  { lo: -850, hi: -700, count: 10 },
], 2);
ok(agir.laa950Pct > 90 && agir.category === "ağır" && agir.volumeMl === 2, `LAA-950: %${agir.laa950Pct.toFixed(1)} → ağır; hacim ${agir.volumeMl} mL`);
const hafif = lungQuant([
  { lo: -1000, hi: -950, count: 70 },
  { lo: -950, hi: -700, count: 930 },
]);
ok(hafif.laa950Pct > 5 && hafif.laa950Pct < 10 && hafif.category === "hafif", `LAA-950: %${hafif.laa950Pct.toFixed(1)} → hafif`);
ok(lungQuant([]).category === "—", "Akciğer kantitasyonu: boş histogram → ölçüm yok");
ok(hafif.meanHu < 0 && hafif.pd15Hu !== null, "PD15/ortalama HU hesaplandı");

// ── Nükleer tıp ──
const sub = subtractionSummary(
  { rows: [[10, 10], [10, 10]] },
  { rows: [[10, 30], [10, 50]] },
);
ok(sub !== null && sub.enhancedPct === 50 && sub.meanDiff === 15, "Subtraksiyon: artış oranı %50 + ortalama fark 15");
ok(subtractionSummary({ rows: [[1]] }, { rows: [[1, 2]] }) === null, "Subtraksiyon: boyut uyumsuzluğunda null");

const ticWashout = ticCurve([0, 5, 10, 20], [10, 60, 50, 20]);
ok(ticWashout.pattern === "washout" && ticWashout.washOutPct! >= 15, `TIC: wash-out %${ticWashout.washOutPct?.toFixed(0)} → washout`);
const ticPersist = ticCurve([0, 5, 10, 20], [10, 40, 45, 44]);
ok(ticPersist.pattern === "progressif", "TIC: monoton artış → progressif");
ok(ticCurve([0, 1], [1, 2]).pattern === "yetersiz", "TIC: az nokta → yetersiz");

const mtv = metabolicTumorVolume([0.5, 1.2, 2.5, 3.1, 0.9, 2.6], 0.5);
ok(mtv.voxelCount === 3 && Math.abs(mtv.mtvMl - 1.5) < 0.01 && mtv.suvPeak === 3.1, `MTV: ${mtv.voxelCount} voxel × 0.5 mL = ${mtv.mtvMl} mL, SUVpeak ${mtv.suvPeak}`);
ok(metabolicTumorVolume([], 0.5).mtvMl === 0, "MTV: boş veri → 0");

if (failed) { console.error(`${failed} kantitatif test başarısız`); process.exit(1); }
console.log("Tüm kantitatif (ASPECTS/CTP/akciğer/nükleer) testleri geçti.");

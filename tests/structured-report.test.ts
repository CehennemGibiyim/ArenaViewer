/**
 * Yapılandırılmış skorlama motoru testleri (Lung-RADS / TI-RADS / BI-RADS /
 * PI-RADS v2.1 / ACR yoğunluk). Saf fonksiyonlar; veritabanı gerektirmez.
 */
import {
  acrDensity, agatston, agatstonWeight, biRads, boneDensity, cxrCardiothoracicRatio,
  lungRads, piRadsV2, scoreToText, tiRads,
} from "@/lib/structuredReport";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── Lung-RADS ──
ok(lungRads({ solidMm: 4 }).label === "Lung-RADS 2", "Lung-RADS: 4 mm solid → 2");
ok(lungRads({ solidMm: 7 }).label === "Lung-RADS 3", "Lung-RADS: 7 mm solid → 3");
const l4 = lungRads({ solidMm: 12 });
ok(l4.label === "Lung-RADS 4A" && l4.followUpDays === 90 && l4.tissueSampling, "Lung-RADS: 12 mm solid → 4A (90 gün + doku örneklemesi)");
const lx = lungRads({ solidMm: 7, suspiciousFeature: true });
ok(lx.label === "Lung-RADS 4B", "Lung-RADS: şüpheli özellik 7 mm → 4B yükselmesi");
ok(lungRads({ partSolidMm: 9 }).label === "Lung-RADS 4A", "Lung-RADS: kısmi solid ≥8 mm solid komponent → 4A");
ok(lungRads({ nonsolidMm: 20 }).followUpDays === 180, "Lung-RADS: 20 mm non-solid → 180 gün");
ok(lungRads({ calcification: "benign" }).label === "Lung-RADS 2", "Lung-RADS: benign kalsifikasyon → 2");

// ── TI-RADS ──
const tr2 = tiRads({ composition: "spongiform", echogenicity: "hyperIso", shape: "wider", margin: "smooth", foci: ["none"] });
ok(tr2.label === "TR2", "TI-RADS: spongiform + hiperizgojen + geniş + düzgün → TR2 (0 puan)");
const tr5 = tiRads({ composition: "solid", echogenicity: "veryHypoechoic", shape: "taller", margin: "lobulated", foci: ["punctate"] });
ok(tr5.label === "TR5" && tr5.category === "11 puan", "TI-RADS: solid + çok hipoekojen + dik + lobüle + punctate → TR5 (11 puan)");
ok(tiRads({ composition: "mixed", echogenicity: "hypoechoic", shape: "wider", margin: "smooth" }).category === "3 puan", "TI-RADS: 1+2 puan → TR3 (3 puan)");

// ── BI-RADS + yoğunluk ──
ok(biRads("3").followUpDays === 180, "BI-RADS 3 → 180 gün kısa süreli izlem");
ok(biRads("5").tissueSampling, "BI-RADS 5 → doku örneklemesi");
ok(acrDensity("c").category === "C", "ACR yoğunluk c → kategori C");
ok(acrDensity("a").weight < acrDensity("d").weight, "ACR yoğunluk a < d önem ağırlığı");

// ── PI-RADS v2.1 ──
const pz = piRadsV2({ zone: "PZ", dwi: 3, dce: true });
ok(pz.label === "PI-RADS 4", "PI-RADS: PZ DWI 3 + DCE pozitif → 4");
const tz = piRadsV2({ zone: "TZ", t2: 3, dwi: 5 });
ok(tz.label === "PI-RADS 4", "PI-RADS: TZ T2 3 + DWI 5 → 4");
ok(piRadsV2({ zone: "TZ", t2: 2 }).tissueSampling === false, "PI-RADS 2 → biyopsi önerilmez");
ok(piRadsV2({ zone: "PZ" }).label === "PI-RADS ?", "PI-RADS: DWI eksik → tanımsız");

// ── Agatston / kemik yoğunluğu / CXR ──
ok(agatstonWeight(129) === null && agatstonWeight(130) === 1 && agatstonWeight(250) === 2 && agatstonWeight(400) === 4, "Agatston HU ağırlıkları (130/200/300/400 eşikleri)");
const ca = agatston([
  { vessel: "LAD", peakHu: 300, areaMm2: 10 },   // 3 × 10 = 30
  { vessel: "RCA", peakHu: 150, areaMm2: 20 },    // 1 × 20 = 20
  { vessel: "LCx", peakHu: 420, areaMm2: 5 },     // 4 × 5 = 20
  { vessel: "LM", peakHu: 90, areaMm2: 30 },      // atlanır (HU<130)
]);
ok(ca.total === 70 && ca.category.startsWith("10–99"), `Agatston toplam 70 → hafif kalsifiye (bulunan: ${ca.total}, ${ca.category})`);
ok(ca.perVessel.LAD === 30 && ca.ignored === 1, "Agatston damar bazlı skor + geçersiz lezyon atlanması");
ok(agatston([]).label === "Agatston 0" && agatston([]).followUpDays === 365, "Agatston 0 → skor yok kategorisi");

ok(boneDensity(170).category === "normal" && boneDensity(130).category === "sinirda" && boneDensity(90).category === "yuksek-risk", "Kemik yoğunluğu HU kategorileri (≥160 / 120–159 / <120)");
ok(boneDensity(null).followUpDays === null, "Kemik yoğunluğu: eksik HU → takip önerilmez");

ok(cxrCardiothoracicRatio(160, 300).label.includes("0.53"), "CXR CTR 160/300 = 0.53 sınırda/artmış");
ok(cxrCardiothoracicRatio(170, 300).weight > cxrCardiothoracicRatio(140, 300).weight, "CXR CTR >0.55 daha yüksek gösterge");
ok(cxrCardiothoracicRatio(null, 300).label.startsWith("CTR ?"), "CXR CTR eksik ölçüm → tanımsız");

// ── Rapor satırı ──
const line = scoreToText(l4);
ok(line.includes("Lung-RADS 4A") && line.includes("hekim onayına tabidir"), "scoreToText etiket + sorumluluk notu içeriyor");

if (failed) { console.error(`${failed} test başarısız`); process.exit(1); }
console.log("Tüm yapılandırılmış skorlama testleri geçti.");

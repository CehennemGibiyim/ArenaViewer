/**
 * a-uncert — güven kalibrasyonu (ısotonik/PAV) + eşik önerisi + "hekim incelesin".
 *
 * Kapsam:
 *  1) PAV algoritması: monotonluk, aynı skorların birleşmesi, sıra bağımsızlığı
 *  2) `applyCalibration`: ara değer köprüleme, sınırlar, eşleme yoksa skor DEĞİŞMEZ
 *  3) yetersiz veri → eşleme üretilmez (sessiz "düzeltilmiş" görüntü yok)
 *  4) ECE → kalite sınıfları
 *  5) eşik önerisi: kesinlik hedefi, yetersiz veri
 *  6) `reviewDecision`: göster / incele / gizle + kalibrasyonsuz yolun muhafazakârlığı
 *  7) uç entegrasyonu: kalibrasyon, eşikler, düşük güven kuyruğu (statik + davranış)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CALIB_MIN_CASES, applyCalibration, calibrationQuality, chooseThreshold, fitIsotonic,
  isMonotonic, reviewDecision, type CalibCase,
} from "../src/lib/calibration";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const near = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) < eps;
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** n adet (score,label) üretir. */
const cases = (...pairs: [number, 0 | 1 | null][]): CalibCase[] => pairs.map(([score, label]) => ({ score, label }));
const rep = (score: number, label: 0 | 1, n: number): CalibCase[] => Array.from({ length: n }, () => ({ score, label }));
const mix = (score: number, pos: number, neg: number): CalibCase[] => [...rep(score, 1, pos), ...rep(score, 0, neg)];

async function main() {
  // ── 1. PAV temelleri ──
  const simple = fitIsotonic([...mix(0.1, 1, 9), ...mix(0.5, 5, 5), ...mix(0.9, 9, 1), ...rep(0.2, 0, 10)]);
  ok(simple.ok && simple.blocks.length >= 2, "yeterli veride ısotonik eşleme kurulur");
  ok(isMonotonic(simple), "eşleme TEKDÜZE (skor artarken olasılık düşmez)");
  ok(simple.blocks.every((b) => b.p >= 0 && b.p <= 1), "blok olasılıkları 0–1 aralığında");
  ok(simple.n === 40, "etiketli vaka sayısı doğru (null etiketler dışarıda)");

  // Aynı skorlar tek grupta birleşir (sıra bağımlılığı yok → deterministik)
  const a = fitIsotonic([...mix(0.4, 3, 7), ...mix(0.7, 8, 2), ...rep(0.6, 0, 10), ...rep(0.6, 1, 10)]);
  const b = fitIsotonic([...rep(0.6, 1, 10), ...rep(0.6, 0, 10), ...mix(0.7, 8, 2), ...mix(0.4, 3, 7)]);
  ok(JSON.stringify(a.blocks) === JSON.stringify(b.blocks), "girdi sırası sonucu değiştirmez (deterministik)");
  ok(a.blocks.filter((x) => x.lo === 0.6).length === 1, "aynı skor tek blokta toplanır");

  // İhlal birleştirme: düşük skorda yüksek onay oranı → bloklar birleşir
  const violation = fitIsotonic([...mix(0.2, 9, 1), ...mix(0.9, 1, 9), ...mix(0.5, 5, 5)]);
  ok(isMonotonic(violation), "aykırı (azalan) bloklar birleştirilerek tekdüzelik sağlanır");
  ok(violation.blocks.length >= 1, "birleştirme sonrası en az bir blok kalır");

  // ── 2. Uygulama / köprüleme ──
  const cal = fitIsotonic([...mix(0.1, 1, 19), ...mix(0.5, 10, 10), ...mix(0.9, 19, 1)]);
  ok(cal.ok, "üç noktalı eğri kuruldu");
  ok(near(applyCalibration(cal, 0.05), cal.blocks[0].p), "en düşük skorun altı ilk bloğa kilitlenir");
  ok(near(applyCalibration(cal, 0.99), cal.blocks[cal.blocks.length - 1].p), "en yüksek skorun üstü son bloğa kilitlenir");
  const mid = applyCalibration(cal, 0.5);
  ok(mid > applyCalibration(cal, 0.15) && mid < applyCalibration(cal, 0.85), "orta skor ara olasılık verir (tekdüze)");
  ok(applyCalibration(null, 0.42) === 0.42, "eşleme yoksa skor DEĞİŞMEZ (null)");
  ok(applyCalibration({ ...cal, ok: false }, 0.42) === 0.42, "ok=false ise skor değişmez (sahte düzeltme yok)");
  ok(applyCalibration(cal, -5) === cal.blocks[0].p && applyCalibration(cal, 5) === cal.blocks[cal.blocks.length - 1].p, "aralık dışı skorlar kırpılır");

  // ── 3. Yetersiz veri ──
  const few = fitIsotonic(rep(0.8, 1, 5));
  ok(!few.ok && few.blocks.length === 0, `n < ${CALIB_MIN_CASES} → eşleme ÜRETİLMEZ`);
  ok(/en az 30/.test(few.reason), "yetersizlik nedeni açıkça yazılır");
  ok(applyCalibration(few, 0.8) === 0.8, "yetersiz veride skor olduğu gibi kalır");
  const onlyNull = fitIsotonic(cases([0.5, null], [0.6, null]));
  ok(!onlyNull.ok && onlyNull.n === 0 && /Etiketli bulgu yok/.test(onlyNull.reason), "etiket yoksa açık hata");
  const flat = fitIsotonic(rep(0.5, 1, CALIB_MIN_CASES));
  ok(!flat.ok && /Tek blok/.test(flat.reason), "skorlar ayrışmıyorsa (tek blok) kalibrasyon anlamsız");
  // Ters model: skor arttıkça onay AZALIYOR. Isotonik bunu temsil EDEMEZ (tekdüzelik
  // varsayımı) → tüm bloklar birleşir, ok=false ve skor düzeltilmez. Uydurma eğri yok.
  const inverted = fitIsotonic([...mix(0.9, 1, 39), ...mix(0.1, 39, 1)]);
  ok(!inverted.ok && inverted.blocks.length <= 1, "ters (azalan) modelde ısotonik eşleme REDDEDİLİR, uydurulmaz");
  ok(applyCalibration(inverted, 0.9) === 0.9, "reddedilen eşleme skoru değiştirmez");
  // null etiketler (düzenlenen/bekleyen) kalibrasyona girmez
  const withNull = fitIsotonic([...mix(0.2, 1, 9), ...mix(0.8, 9, 1), ...cases([0.9, null], [0.1, null])]);
  ok(withNull.n === 20, "null etiketli (düzenlenen/bekleyen) vakalar dışarıda kalır");

  // ── 4. ECE kalitesi ──
  ok(calibrationQuality(0.02).level === "iyi", "ECE 0.02 → iyi");
  ok(calibrationQuality(0.08).level === "orta", "ECE 0.08 → orta");
  ok(calibrationQuality(0.25).level === "zayif", "ECE 0.25 → zayıf");
  ok(calibrationQuality(null).level === "bilinmiyor" && /ECE hesaplanamadı/.test(calibrationQuality(null).note), "ECE yoksa 'bilinmiyor' (uydurma yok)");
  ok(/olasılık gibi okumayın/.test(calibrationQuality(0.07).note), "orta kalitede uyarı metni var");

  // ── 5. Eşik önerisi ──
  const th = chooseThreshold([...mix(0.9, 18, 2), ...mix(0.5, 5, 15), ...mix(0.2, 1, 19)], null, 0.8);
  ok(!!th && th.precision >= 0.8, "kesinlik hedefini tutan eşik bulunur");
  ok(!!th && th.recall > 0 && th.threshold >= 0.5, "öneri eşiği düşük kesinlikli bölgeyi dışarıda bırakır");
  ok(chooseThreshold(rep(0.9, 1, 10), null, 0.8) === null, `n < ${CALIB_MIN_CASES} → eşik önerisi YOK`);
  ok(chooseThreshold([...mix(0.2, 1, 19), ...mix(0.3, 1, 19)], null, 0.95) === null, "hedef kesinlik hiçbir eşikte tutmuyorsa öneri null");

  // ── 6. Karar: göster / incele / gizle ──
  const calHigh = fitIsotonic([...mix(0.1, 1, 29), ...mix(0.9, 29, 1)]); // kalibre: 0.1'de ~%3, 0.9'da ~%97
  const show = reviewDecision(0.95, calHigh);
  ok(show.action === "goster" && show.calibrated > 0.9, "yüksek kalibre olasılık → göster");
  // Kalibrasyon ham skoru AŞAĞI çekebilir: model 0.65 skorunda yalnız %40 doğruysa,
  // ham 0.65 "göster" eşiğinin altında kalmalı (ham skorla yanıltıcı olurdu).
  const calDown = fitIsotonic([...mix(0.3, 4, 26), ...mix(0.65, 16, 24), ...mix(0.9, 28, 2), ...mix(0.95, 28, 2)]);
  ok(calDown.ok, "üç bölgeli eğri kuruldu");
  const down = reviewDecision(0.65, calDown, { showAt: 0.7, inspectAt: 0.3 });
  ok(down.calibrated < 0.65, "kalibrasyon ham skoru aşağı çeker (0.65 → daha düşük)");
  ok(down.action !== "goster", "ham 0.65 'göster' eşiğine yakın olsa da kalibre skor göster demez");
  ok(/[Kk]alibre/.test(down.why), "karar nedeni kalibre değeri açıklar");
  // incele bandı: kalibre ~0.5
  const calMid = fitIsotonic([...mix(0.5, 25, 25), ...mix(0.1, 1, 29), ...mix(0.9, 29, 1)]);
  const insp = reviewDecision(0.5, calMid, { showAt: 0.7, inspectAt: 0.3 });
  ok(insp.action === "incele", "orta kalibre olasılık → İNCELE (hekim incelesin)");
  ok(/İNCELEMELİ/.test(insp.why), "incele kararı metinde açıkça söylenir");
  const hide = reviewDecision(0.2, calHigh, { showAt: 0.7, inspectAt: 0.4 });
  ok(hide.action === "gizle", "düşük kalibre olasılık → gizle");

  // Kalibrasyonsuz yol: muhafazakâr (asla 'incele'ye yükseltmez, 'kalibre değil' der)
  const noCal = reviewDecision(0.75, null);
  ok(noCal.action === "goster" && /kalibre değil/.test(noCal.why), "kalibrasyon yokken yüksek ham skor 'göster' + 'kalibre değil' notu");
  const noCalLow = reviewDecision(0.5, null);
  ok(noCalLow.action === "gizle", "kalibrasyon yokken orta skor gösterilmez (uydurma güven yok)");
  ok(![noCal, noCalLow].some((d) => d.action === "incele"), "kalibrasyonsuz hiçbir karar 'incele' değildir");
  ok(reviewDecision(0.9, calHigh, { showAt: 0.98 }).action !== "goster", "gösterim eşiği yükseltilirse karar değişir (eşik ayarı çalışır)");

  // ── 7. meanShift / inSample ──
  ok(calHigh.inSample === true, "eşleme 'örneklem-içi' olarak işaretlenir");
  ok(calHigh.meanShift !== null && calHigh.meanShift > 0, "ortalama kayma raporlanır (ne kadar düzeltiyoruz)");
  ok(simple.meanShift !== null, "kayma hesaplanır");

  // ── 8. Uç entegrasyonu ──
  const route = read("src/app/api/ai/feedback/route.ts");
  ok(/fitIsotonic/.test(route) && /calibrationQuality/.test(route), "uç kalibrasyonu hesaplar ve sınıflandırır");
  ok(/calibrationBins|expectedCalibrationError/.test(route), "ECE bölmeli yöntemle hesaplanır");
  ok(/decision === "onaylandi" \? 1 : decision === "reddedildi" \? 0 : null/.test(route), "yalnız net kararlar etiketlenir (düzenlenen/bekleyen null)");
  ok(/chooseThreshold/.test(route), "eşik önerisi uçta hesaplanır");
  ok(/lowConfidence/.test(route) && /reviewDecision/.test(route), "düşük güven kuyruğu kararı aynı fonksiyonla üretilir");
  ok(/calibrationOk/.test(route), "kalibrasyon durumu denetim kaydına yazılır");
  ok(/ÖNERİDİR|ÖNERİ/.test(route), "eşik önerisinin bağlayıcı olmadığı yanıtta yazılı");

  // ── 9. Derin model → belirsizlik bandı kablolaması (DEEP_SCORE_THRESHOLD) ──
  const { DEEP_SCORE_THRESHOLD } = await import("../src/lib/deepScan");
  const { uncertaintyBand } = await import("../src/lib/uncertainty");
  ok(DEEP_SCORE_THRESHOLD > 0 && DEEP_SCORE_THRESHOLD < 1, "işletim eşiği 0–1 aralığında");
  ok(uncertaintyBand(DEEP_SCORE_THRESHOLD + 0.01, DEEP_SCORE_THRESHOLD) === "sinirda", "eşiğin hemen üstü SINIRDA bandına düşer");
  ok(uncertaintyBand(DEEP_SCORE_THRESHOLD + 0.1, DEEP_SCORE_THRESHOLD) === "orta", "orta mesafe ORTA bandı");
  ok(uncertaintyBand(DEEP_SCORE_THRESHOLD + 0.5, DEEP_SCORE_THRESHOLD) === "guclu", "uzak mesafe GÜÇLÜ bandı");
  const deepSrc = read("src/lib/deepScan.ts");
  ok(/threshold: DEEP_SCORE_THRESHOLD/.test(deepSrc), "derin model bulguları eşiği Finding.threshold'a yazar");
  ok(!/b\.score >= 0\.30/.test(deepSrc), "sabit eşik koda gömülü kalmaz (tek kaynak: DEEP_SCORE_THRESHOLD)");
  ok((deepSrc.match(/DEEP_SCORE_THRESHOLD/g) ?? []).length >= 4, "sabit hem filtrede hem bulgu alanında kullanılır");

  // ── 10. Pano: kalibrasyon bölümü ──
  const panel = read("src/components/AdminPanel.tsx");
  ok(/data-testid="calibration"/.test(panel), "panoda kalibrasyon bölümü var");
  ok(/Hekim incelesin/.test(panel), "düşük güven kuyruğu 'Hekim incelesin' başlığıyla gösterilir");
  ok(/örneklem-içidir/.test(panel), "panoda 'örneklem-içi, dış doğrulama değil' uyarısı yazılı");
  ok(/düzeltilmeden/.test(panel), "kalibrasyon yokken 'skorlar düzeltilmedi' açıkça yazılır");
  const shim = read("src/components/StaticAdminShim.tsx");
  ok(/fitIsotonic\(/.test(shim) && /chooseThreshold\(/.test(shim), "statik demo aynı kalibrasyon hesabını kullanır");

  console.log(`\ncalibration: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

/**
 * a-uncert: kalibre güven skoru ve güven aralığı testleri.
 *
 * Wilson aralığının sınır davranışı, seyrek kutu birleştirmesi, Laplace
 * düzeltmesi, "emin / ihtiyatlı / emin değil" kararı ve veri yetersizken
 * sahte aralık üretilmemesi sınanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  calibrateScore,
  calibrationCurve,
  calibrationShift,
  confidenceVerdict,
  MIN_BIN_N,
  MIN_LABELS,
  wilsonInterval,
} from "../src/lib/confidenceInterval";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const data = (scores: [number, boolean][]): { score: number; approved: boolean }[] =>
  scores.map(([score, approved]) => ({ score, approved }));

/** Kalibre bir model: yüksek skorda onay oranı yüksek. */
const iyiVeri = (n = 40): { score: number; approved: boolean }[] => [
  ...Array.from({ length: n }, (_, i) => ({ score: 0.9 + (i % 5) * 0.01, approved: i % 10 !== 0 })), // %90 onay
  ...Array.from({ length: n }, (_, i) => ({ score: 0.1 + (i % 5) * 0.01, approved: i % 10 === 0 })), // %10 onay
];

function main() {
  // ── 1) Wilson aralığı ────────────────────────────────────────────────
  const yarim = wilsonInterval(5, 10);
  assert.ok(yarim.lo > 0.23 && yarim.lo < 0.25, `n=10 p=0.5 alt sınır ~0,237 (${yarim.lo})`);
  assert.ok(yarim.hi > 0.75 && yarim.hi < 0.77, `n=10 p=0.5 üst sınır ~0,763 (${yarim.hi})`);
  assert.equal(yarim.reliable, false, "10 gözlem güvenilir sayılmaz");
  const kesin = wilsonInterval(50, 100);
  assert.ok(kesin.hi - kesin.lo < yarim.hi - yarim.lo, "n büyüdükçe aralık daralır");
  assert.equal(kesin.reliable, true, "100 gözlem güvenilir");
  const sifir = wilsonInterval(0, 10);
  assert.equal(sifir.lo, 0, "0 başarıda alt sınır 0");
  assert.ok(sifir.hi > 0.25, `0/10'da üst sınır sıfıra çökmez (${sifir.hi})`);
  const tam = wilsonInterval(10, 10);
  assert.equal(tam.hi, 1, "10/10'da üst sınır 1");
  assert.ok(tam.lo < 0.75, "10/10 alt sınır 1'e yapışmaz");
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1, reliable: false }, "boş örneklem tam aralık");
  assert.equal(wilsonInterval(Number.NaN, 5).reliable, false, "NaN güvenilmez");
  assert.equal(wilsonInterval(5, -1).reliable, false, "negatif n güvenilmez");
  console.log("PASS Wilson aralığı (uçlarda çökmez, n ile daralır)");

  // ── 2) Kalibrasyon eğrisi ────────────────────────────────────────────
  const yetersiz = calibrationCurve(data([[0.9, true], [0.2, false]]));
  assert.equal(yetersiz.usable, false, "2 gözlem yetersiz");
  assert.equal(yetersiz.ece, null, "yetersiz veride ECE üretilmez");
  assert.match(yetersiz.note, new RegExp(`${MIN_LABELS} gerekir`), "neden yetersiz yazılır");

  const egri = calibrationCurve(iyiVeri(40));
  assert.equal(egri.n, 80, "seksen gözlem");
  assert.equal(egri.usable, true, "kullanılabilir");
  assert.ok(egri.ece !== null && egri.ece < 0.2, `düzenli veride ECE düşük (${egri.ece})`);
  assert.match(egri.note, /80 etiketli gözlem/, "özet n içerir");
  const dolu = egri.bins.filter((b) => b.n > 0);
  assert.equal(dolu.length, 2, "yalnız iki kutu dolu (0,1 ve 0,9 skorları)");
  assert.ok(dolu.every((b) => b.interval !== null), "dolu kutularda aralık var");
  assert.equal(egri.bins[2].interval, null, "boş kutuda aralık yok");
  console.log("PASS kalibrasyon eğrisi (yetersiz veride dürüst red)");

  // ── 3) Tek skor kalibrasyonu ─────────────────────────────────────────
  const c = calibrateScore(0.92, iyiVeri(40));
  assert.ok(c.calibrated > 0.8, `yüksek skorda kalibre değer yüksek (${c.calibrated})`);
  assert.equal(c.interval.reliable, true, "80 gözlemde aralık güvenilir");
  assert.match(c.text, /Kalibre ≈ %\d+ \(aralık %\d+–%\d+, n=\d+\)/, "tek satır biçimi");
  assert.equal(c.warning, null, "uyarı yok");
  assert.equal(c.n, 40, "yalnız kendi kutusu (n=40 ≥ MIN_BIN_N)");
  // Laplace: 40/40 onay → 41/42 ≈ 0,976 (1 değil)
  const hepsiOnay = calibrateScore(0.9, data(Array.from({ length: 40 }, () => [0.9, true] as [number, boolean])));
  assert.ok(hepsiOnay.calibrated < 1 && hepsiOnay.calibrated > 0.9, `Laplace üstten baskılar (${hepsiOnay.calibrated})`);
  const hepsiRet = calibrateScore(0.9, data(Array.from({ length: 40 }, () => [0.9, false] as [number, boolean])));
  assert.ok(hepsiRet.calibrated > 0 && hepsiRet.calibrated < 0.1, `0/40'ta sıfıra çökmez (${hepsiRet.calibrated})`);
  console.log("PASS tek skor kalibrasyonu (Laplace düzeltmesi + metin)");

  // ── 4) Seyrek kutu birleştirmesi ─────────────────────────────────────
  // Yüksek skorda çok, orta skorda az gözlem: orta kutu komşularıyla birleşmeli.
  const seyrek = [
    ...Array.from({ length: 30 }, () => ({ score: 0.85, approved: true })),
    ...Array.from({ length: 3 }, () => ({ score: 0.55, approved: false })),
  ];
  const sc = calibrateScore(0.55, seyrek);
  assert.ok(sc.n >= MIN_BIN_N, `seyrek kutu komşularla birleşti (n=${sc.n})`);
  assert.match(sc.warning ?? "", /geniş yorumlanmalı/, "birleştirme uyarısı");
  assert.equal(calibrateScore(0.55, seyrek).binIndex, 2, "5 kutuda 0,55 → 3. kutu");
  const bosKutu = calibrateScore(0.31, seyrek);
  assert.ok(bosKutu.n >= 0, "boş kutu güvenli");
  console.log("PASS seyrek kutu birleştirmesi (n<20 komşuya taşar)");

  // ── 5) Veri yetersizken sahte aralık yok ─────────────────────────────
  const az = calibrateScore(0.9, data([[0.9, true], [0.9, true]]));
  assert.equal(az.interval.reliable, false, "az veride aralık güvenilmez");
  assert.match(az.text, /Ham skor %90/, "ham skor dürüstçe gösterilir");
  assert.match(az.warning ?? "", /en az 20/, "gereken etiket sayısı yazılır");
  assert.equal(calibrateScore(0.5, []).interval.reliable, false, "veri yok");
  assert.equal(calibrateScore(Number.NaN, []).raw, 0, "geçersiz skor 0'a kenetlenir");
  assert.equal(calibrateScore(2, iyiVeri(40)).raw, 1, "1 üstü kenetlenir");
  assert.equal(calibrateScore(-1, iyiVeri(40)).raw, 0, "0 altı kenetlenir");
  console.log("PASS yetersiz veri davranışı (sahte güven üretilmez)");

  // ── 6) Eminlik kararı ────────────────────────────────────────────────
  const emin = confidenceVerdict(c, 0.5);
  assert.equal(emin.level, "emin", "yüksek skor + dar aralık → emin");
  assert.match(emin.text, /eşiğin üzerinde/, "taraf yazılır");
  // Eşiği içeren aralık → emin değil
  const ortada = calibrateScore(0.5, data([
    ...Array.from({ length: 10 }, () => [0.5, true] as [number, boolean]),
    ...Array.from({ length: 10 }, () => [0.5, false] as [number, boolean]),
    ...Array.from({ length: 10 }, () => [0.5, true] as [number, boolean]),
    ...Array.from({ length: 10 }, () => [0.5, false] as [number, boolean]),
    ...Array.from({ length: 10 }, () => [0.9, true] as [number, boolean]),
    ...Array.from({ length: 10 }, () => [0.9, true] as [number, boolean]),
  ]));
  const kararsiz = confidenceVerdict(ortada, 0.5);
  assert.equal(kararsiz.level, "emin-degil", "aralık eşiği içeriyorsa emin değil");
  assert.match(kararsiz.text, /EMİN DEĞİL/, "uyarı vurgulu");
  const azVeri = confidenceVerdict(az, 0.5);
  assert.equal(azVeri.level, "emin-degil", "yetersiz kalibrasyon → emin değil");
  assert.match(azVeri.text, /Kalibrasyon yetersiz/, "neden yazılır");
  const ihtiyatli = confidenceVerdict({ ...c, interval: { lo: 0.62, hi: 0.95, reliable: true } }, 0.5);
  assert.equal(ihtiyatli.level, "ihtiyatli", "geniş aralık → ihtiyatlı");
  const gecerli = confidenceVerdict(c, Number.NaN);
  assert.equal(gecerli.level, "emin", "eşik geçersizse 0,5 varsayılır");
  assert.match(confidenceVerdict({ ...c, interval: { lo: 0.05, hi: 0.2, reliable: true } }, 0.5).text, /eşiğin altında/, "düşük taraf");
  console.log("PASS eminlik kararı (emin / ihtiyatlı / emin değil)");

  // ── 7) Kayma metni ───────────────────────────────────────────────────
  assert.equal(calibrationShift({ ...c, raw: 0.9, calibrated: 0.9 }), "Ham skor kalibre değerle aynı.", "eşit");
  assert.match(calibrationShift({ ...c, raw: 0.9, calibrated: 0.6 }), /Ham skor kalibre değerden yüksek \(%30 puan\)/, "kalibre düşükse ham yüksek");
  assert.match(calibrationShift({ ...c, raw: 0.4, calibrated: 0.7 }), /Ham skor kalibre değerden düşük \(%30 puan\)/, "kalibre yüksekse ham düşük");
  console.log("PASS kalibrasyon kayma metni");

  // ── 8) Arayüz sözleşmesi ─────────────────────────────────────────────
  const panel = read("src/components/RightPanel.tsx");
  assert.ok(panel.includes("calibrateScore") && panel.includes("confidenceVerdict"), "bulgu kartı kalibre skoru gösterir");
  assert.ok(panel.includes("EMİN DEĞİL"), "emin değil durumu görünür");
  assert.ok(panel.includes("findingsApproval"), "kalibrasyon hekim kararlarından beslenir");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("Güven kalibrasyonu"), "yönetimde kalibrasyon paneli");
  assert.ok(admin.includes("wilsonInterval"), "aralık panelde kullanılır");
  assert.ok(admin.includes("n >= 20"), "yeterli etiket kuralı panelde de uygulanır");
  const api = read("src/app/api/ai/performance/route.ts");
  assert.ok(api.includes("calibration"), "uç kalibrasyon verisi döner");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "a-uncert"[\s\S]{0,2200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:confidence"]?.includes("confidence-interval"), "test betiği kayıtlı");
  console.log("PASS arayüz sözleşmesi (bulgu kartı + yönetim paneli + uç)");

  console.log("Tüm a-uncert (kalibre güven) testleri geçti.");
}

main();

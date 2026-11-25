/**
 * a-prior: interval değişim özeti testleri.
 *
 * Kural eşikleri (≥5 mm ve ≥%20 büyüme / ≥5 mm ve ≥%30 küçülme), eşleştirme,
 * yeni/kaybolan sınıfları, tarih/süre hesabı ve CSV çıktısı sınanır. Ayrıca
 * arayüz bağlantısının (Geçmiş sekmesi) kaynak sözleşmesi doğrulanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHANGE_LABEL,
  CHANGE_TONE,
  classifyChange,
  compareInterval,
  daysBetween,
  headlineOf,
  intervalCsv,
  intervalText,
  lesionsFromFindings,
  pickPriorReport,
  rowText,
  type IntervalSummary,
} from "../src/lib/intervalChange";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

type F = { id: string; label: string; category: string; anatomicalLocation: string; metrics?: { maxDiameterMm?: number; volumeMl?: number } };

const f = (id: string, mm: number | undefined, location = "sağ üst lob", category = "Akciğer"): F => ({
  id, label: id, category, anatomicalLocation: location,
  metrics: mm === undefined ? undefined : { maxDiameterMm: mm },
});

function main() {
  // ── 1) Sınıflandırma eşikleri ─────────────────────────────────────────
  assert.equal(classifyChange(10, 10).kind, "stabil", "aynı ölçüm stabil");
  assert.equal(classifyChange(10, 12).kind, "stabil", "2 mm / %20 artış eşiğin altında (mutlak değer yetersiz)");
  assert.equal(classifyChange(10, 14).kind, "stabil", "4 mm artış eşiğin hemen altında (mm yetersiz)");
  assert.equal(classifyChange(10, 15).kind, "buyume", "5 mm ve %50 → büyüme");
  assert.equal(classifyChange(100, 121).kind, "buyume", "21 mm ve %21 → iki eşik de sağlanır → büyüme");
  assert.equal(classifyChange(10, 7).kind, "stabil", "3 mm azalma eşiğin altında");
  assert.equal(classifyChange(10, 6).kind, "stabil", "%40 azalma ama 4 mm (< 5) → stabil");
  assert.equal(classifyChange(10, 5).kind, "kuculme", "5 mm ve %50 azalma → küçülme");
  assert.equal(classifyChange(4, 2).kind, "stabil", "2 mm azalma (%50) mutlak eşiğin altında");
  assert.equal(classifyChange(null, 10).kind, "olculemedi", "önceki ölçüm yok");
  assert.equal(classifyChange(10, undefined).kind, "olculemedi", "sonraki ölçüm yok");
  assert.equal(classifyChange(0, 10).kind, "olculemedi", "sıfır ölçüm geçersiz");
  assert.equal(classifyChange(-3, 10).kind, "olculemedi", "negatif ölçüm geçersiz");
  assert.equal(classifyChange(Number.NaN, 10).kind, "olculemedi", "NaN geçersiz");

  const d = classifyChange(20, 30);
  assert.equal(d.deltaMm, 10, "mutlak fark");
  assert.equal(Math.round(d.deltaPct!), 50, "yüzde fark");
  console.log("PASS değişim eşikleri (mm + yüzde birlikte)");

  // ── 2) Süre ve tarih ─────────────────────────────────────────────────
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30, "30 gün");
  assert.equal(daysBetween("2025-01-01", "2026-01-01"), 365, "bir yıl");
  assert.equal(daysBetween("2026-03-01", "2026-02-01"), -28, "geriye tarih negatif");
  assert.equal(daysBetween("bozuk", "2026-01-01"), 0, "geçersiz tarih 0");
  assert.equal(daysBetween("2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z"), 7, "saat bilgisi kırpılır");
  assert.equal(intervalText(0), "aynı gün", "sıfır gün");
  assert.equal(intervalText(45), "1 ay 15 gün", "45 gün");
  assert.equal(intervalText(400), "1 yıl 1 ay", "400 gün → yıl + ay");
  assert.equal(intervalText(10), "10 gün", "kısa aralık");
  assert.equal(intervalText(-10), "10 gün önce", "geriye tarih");
  console.log("PASS süre hesabı (gün → okunur aralık)");

  // ── 3) Bulgu → lezyon eşlemesi ───────────────────────────────────────
  const les = lesionsFromFindings([
    f("a", 12),
    f("b", undefined),
    { id: "c", label: "c", category: "Sistem", anatomicalLocation: "-", metrics: { maxDiameterMm: 5 } },
    f("d", 0),
  ], "2026-01-01");
  assert.equal(les.length, 1, "yalnızca ölçülü, Sistem olmayan bulgu");
  assert.equal(les[0].longMm, 12, "ölçüm taşınır");
  assert.equal(les[0].anatomy, "Akciğer", "anatomi = kategori");
  assert.equal(les[0].date, "2026-01-01", "tarih taşınır");
  console.log("PASS bulgu → lezyon eşlemesi (ölçümsüz atlanır)");

  // ── 4) İki tetkik karşılaştırması ────────────────────────────────────
  const prior = {
    date: "2025-06-01",
    findings: [
      f("p1", 10, "sağ üst lob"),          // 10 → 18 = büyüme
      f("p2", 30, "sol alt lob"),          // 30 → 20 = küçülme
      f("p3", 8, "karaciğer segment 6", "Karaciğer"), // 8 → 9 = stabil
      f("p4", 6, "sağ alt lob"),           // kayboldu
    ] as F[],
  };
  const current = {
    date: "2025-12-16",
    findings: [
      f("c1", 18, "sağ üst lob"),
      f("c2", 20, "sol alt lob"),
      f("c3", 9, "karaciğer segment 6", "Karaciğer"),
      f("c5", 25, "sol hilus"),             // yeni
    ] as F[],
  };
  const s: IntervalSummary = compareInterval(prior, current);
  assert.equal(s.days, 198, "aralık 198 gün");
  assert.equal(s.rows.length, 5, "4 eşleşme/kaçış + 1 yeni");
  const bul = (k: string) => s.rows.filter((r) => r.kind === k);
  assert.equal(bul("buyume").length, 1, "bir büyüme");
  assert.equal(bul("kuculme").length, 1, "bir küçülme");
  assert.equal(bul("stabil").length, 1, "bir stabil");
  assert.equal(bul("yeni").length, 1, "bir yeni lezyon");
  assert.equal(bul("kayboldu").length, 1, "bir kaybolan lezyon");
  assert.equal(s.rows[0].kind, "yeni", "yeni lezyon en üstte (PD işareti)");
  assert.match(s.rows[0].text, /Yeni ölçüm: 25 mm/, "yeni lezyon metni");
  assert.match(bul("buyume")[0].text, /10 mm → 18 mm \(\+8 mm, \+80%\)/, "büyüme metni");
  assert.match(bul("kayboldu")[0].text, /önceki: 6 mm/, "kaybolan metni");
  // Toplam çap yalnız eşleşen ölçümlerden: 10+30+8 = 48 → 18+20+9 = 47
  assert.equal(s.sumBeforeMm, 48, "toplam önce");
  assert.equal(s.sumAfterMm, 47, "toplam sonra");
  assert.equal(s.sumDeltaPct, -2, "toplam çap değişimi %-2");
  assert.equal(s.warning, null, "karşılaştırma uyarısı yok");
  assert.match(s.headline, /1 yeni lezyon, 1 büyüme, 1 kayboldu, 1 küçülme, 1 stabil/, "özet sırası");
  assert.match(s.headline, /toplam çap -2%/, "özet toplam çapı içerir");
  // Sıralama: yeni → büyüme → kayboldu → küçülme → stabil
  assert.deepEqual(s.rows.map((r) => r.kind), ["yeni", "buyume", "kayboldu", "kuculme", "stabil"], "önem sırası");
  console.log("PASS interval karşılaştırma (büyüme/küçülme/yeni/kayboldu + toplam çap)");

  // ── 5) Eksik ölçüm durumları ─────────────────────────────────────────
  const bos = compareInterval({ date: "2026-01-01", findings: [] }, { date: "2026-02-01", findings: [] });
  assert.equal(bos.rows.length, 0, "satır yok");
  assert.match(bos.warning ?? "", /karşılaştırma yapılamadı/, "neden bildirilir");
  assert.match(bos.headline, /karşılaştırılabilir ölçüm yok/, "özet dürüst");
  const ilkOlcum = compareInterval({ date: "2026-01-01", findings: [] }, { date: "2026-02-01", findings: [f("x", 12)] });
  assert.equal(ilkOlcum.rows[0].kind, "yeni", "önceki ölçüm yoksa yeni sayılır");
  assert.match(ilkOlcum.warning ?? "", /Önceki raporda ölçüm yok/, "önceki ölçüm yok uyarısı");
  const yalnizOnce = compareInterval({ date: "2026-01-01", findings: [f("x", 12)] }, { date: "2026-02-01", findings: [] });
  assert.equal(yalnizOnce.rows[0].kind, "kayboldu", "bu raporda ölçüm yoksa kayboldu");
  assert.match(yalnizOnce.warning ?? "", /Bu raporda ölçüm yok/, "bu rapor uyarısı");
  // Konum metni farklıysa (segment 6 vs 7) eşleşmez → yeni + kayboldu.
  const segment = compareInterval(
    { date: "2026-01-01", findings: [f("a", 10, "karaciğer segment 6", "Karaciğer")] },
    { date: "2026-02-01", findings: [f("b", 10, "karaciğer segment 7", "Karaciğer")] },
  );
  assert.deepEqual(segment.rows.map((r) => r.kind).sort(), ["kayboldu", "yeni"], "farklı segment eşleşmez");
  console.log("PASS eksik ölçüm ve konum ayrımı");

  // ── 6) CSV + etiketler ───────────────────────────────────────────────
  const csv = intervalCsv(s);
  const lines = csv.trimEnd().split("\n");
  assert.match(lines[0], /^# 2025-06-01 → 2025-12-16 \(198 gün\)/, "CSV başlık satırı");
  assert.equal(lines[1].split(";").length, 8, "8 sütun");
  assert.equal(lines.length, 2 + s.rows.length, "başlık + tüm satırlar");
  assert.ok(csv.includes('"Büyüme"'), "değişim sınıfı okunur etiketle");
  assert.ok(csv.includes("+80%"), "yüzde işaretli");
  assert.ok(csv.includes('"'), "alanlar kaçışlı");
  // Nokta → virgül (Türkçe ondalık) ve tırnak kaçışı
  const ondalik = intervalCsv(compareInterval(
    { date: "2026-01-01", findings: [f("a", 10.5)] },
    { date: "2026-02-01", findings: [f("b", 18.5)] },
  ));
  assert.ok(ondalik.includes("10,5"), "Türkçe ondalık");
  const tirnak = intervalCsv(compareInterval(
    { date: "2026-01-01", findings: [f("a", 10, 'sağ "üst" lob')] },
    { date: "2026-02-01", findings: [f("b", 10, 'sağ "üst" lob')] },
  ));
  assert.ok(tirnak.includes('""üst""'), "tırnak kaçışı");

  assert.equal(Object.keys(CHANGE_LABEL).length, 6, "altı sınıf etiketi");
  assert.equal(CHANGE_LABEL.buyume, "Büyüme", "etiket");
  assert.equal(CHANGE_TONE.buyume, "kirmizi", "büyüme kırmızı");
  assert.equal(CHANGE_TONE.kuculme, "yesil", "küçülme yeşil");
  assert.equal(rowText({ kind: "olculemedi", beforeMm: null, afterMm: null, deltaMm: null, deltaPct: null }), "Ölçüm yok (karşılaştırılamaz)", "ölçümsüz metni");
  console.log("PASS CSV çıktısı (Türkçe ondalık + kaçış) ve etiketler");

  // ── 7) Önceki rapor seçimi ───────────────────────────────────────────
  const reports = [
    { id: 1, createdAt: "2025-01-01T00:00:00Z", modality: "CT", studyUid: "A" },
    { id: 2, createdAt: "2025-09-01T00:00:00Z", modality: "MR", studyUid: "B" },
    { id: 3, createdAt: "2025-06-01T00:00:00Z", modality: "CT", studyUid: "C" },
    { id: 4, createdAt: "2025-11-01T00:00:00Z", modality: "CT", studyUid: "D" },
  ];
  const sec = pickPriorReport(reports, { studyUid: "D", modality: "CT" });
  assert.equal(sec?.id, 3, "aynı modalitenin en yenisi seçilir, kendi çalışması hariç");
  const mr = pickPriorReport(reports, { studyUid: "D", modality: "MR" });
  assert.equal(mr?.id, 2, "aynı modalite yoksa en yeni");
  assert.equal(pickPriorReport(reports, { studyUid: "A", modality: "MR" })?.id, 2, "kendi çalışması dışlanır");
  assert.equal(pickPriorReport([], { studyUid: "X", modality: "CT" }), null, "önceki rapor yoksa null");
  assert.equal(headlineOf("2026-01-01", 5, { buyume: 0, kuculme: 0, stabil: 0, yeni: 0, kayboldu: 0, olculemedi: 0 }, null).includes("ölçüm yok"), true, "boş sayım özeti");
  console.log("PASS önceki rapor seçimi (modalite + tarih)");

  // ── 8) Arayüz sözleşmesi ─────────────────────────────────────────────
  const panel = read("src/components/RightPanel.tsx");
  assert.ok(panel.includes("compareInterval"), "Geçmiş sekmesi karşılaştırmayı kullanır");
  assert.ok(panel.includes("Interval değişim özeti"), "özet kartı görünür");
  assert.ok(panel.includes("intervalCsv"), "CSV indirme bağlı");
  assert.ok(panel.includes("registration"), "sınırlama kullanıcıya yazılır");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "a-prior"[\s\S]{0,2200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:interval"]?.includes("interval-change"), "test betiği kayıtlı");
  console.log("PASS arayüz sözleşmesi (özet kartı + CSV + gap kaydı)");

  console.log("Tüm a-prior (interval değişim özeti) testleri geçti.");
}

main();

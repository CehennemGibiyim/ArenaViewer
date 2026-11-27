/**
 * a-feedback — hekim geri bildirim döngüsü: duyarlılık / özgüllük / yanlış pozitif listesi.
 *
 * Kapsam:
 *  1) Wilson güven aralığı (n küçükken de doğru; kenar durumlar)
 *  2) motor/kategori özeti: onay/ret/düzenleme, "AI kaçırdı" (manual), karar verilmemiş
 *  3) duyarlılık (düzenlenen = gerçek pozitif), özgüllük (yalnız temiz çalışma varsa)
 *  4) yanlış pozitif listesi (gerekçe/skor/kırpma) ve kaçırılan bulgu listesi
 *  5) eşik eğrisi + öneri (yeterli örnek yoksa öneri YOK)
 *  6) uyarılar (kaçırılan yok → duyarlılık şişer; temiz çalışma yok → özgüllük null)
 *  7) DB satırı → geri bildirim dönüşümü (rowsToFeedback) ve uç sözleşmesi
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FP_LIST_MAX, MISSED_LIST_MAX, THRESHOLD_MIN_DECIDED, summarizeFeedback, wilson95,
  type CleanCase, type FeedbackFinding,
} from "../src/lib/feedbackLoop";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const near = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) < eps;

const F = (o: Partial<FeedbackFinding> & { decision: FeedbackFinding["decision"] }): FeedbackFinding => ({
  id: Math.random().toString(36).slice(2), engine: "cxr", category: "Akciger", label: "aday",
  manual: false, score: null, ...o,
});

async function main() {
  // ── 1. Wilson aralığı ──
  const w = wilson95(8, 10)!;
  ok(!!w && w[0] > 0.49 && w[0] < 0.51 && w[1] > 0.92 && w[1] < 0.95, "Wilson(8/10) ≈ [0.50, 0.93]");
  ok(near(wilson95(0, 10)![0], 0), "Wilson(0/10) alt sınır 0");
  const w10 = wilson95(10, 10)!;
  ok(w10[1] === 1 && w10[0] > 0.6 && w10[0] < 0.8, "Wilson(10/10) üst sınır 1, alt sınır < 1 (n küçük)");
  ok(wilson95(0, 0) === null && wilson95(-1, 5) === null && wilson95(6, 5) === null, "geçersiz Wilson girdisi null");
  ok(wilson95(5, 1000)![1] - wilson95(5, 1000)![0] < wilson95(5, 20)![1] - wilson95(5, 20)![0], "n büyüdükçe aralık daralır");

  // ── 2. Temel özet ──
  const base: FeedbackFinding[] = [
    F({ decision: "onaylandi" }), F({ decision: "onaylandi" }), F({ decision: "onaylandi" }),
    F({ decision: "duzenlendi" }),
    F({ decision: "reddedildi", reason: "vasküler kesit", score: 0.62, label: "9 mm nodül", slice: 42, studyRef: "#7" }),
    F({ decision: "bekliyor" }),
  ];
  const r1 = summarizeFeedback(base);
  const row = r1.rows[0];        // kategori düzeyi (PPV)
  const eng1 = r1.engines[0];    // motor düzeyi (duyarlılık/özgüllük)
  ok(r1.rows.length === 1, "tek motor/kategori satırı");
  ok(row.shown === 6 && row.approved === 3 && row.edited === 1 && row.rejected === 1 && row.pending === 1, "onay/ret/düzenleme/bekleyen sayıları");
  ok(row.decidedAi === 5, "karar verilmiş aday = onay + düzenleme + ret (bekleyen hariç)");
  ok(near(row.ppv, 0.8), "PPV = (onay+düzenleme)/(onay+düzenleme+ret) = 0.8");
  ok(eng1.sensitivity === 1, "kaçırılan yokken duyarlılık 1 (uyarı ile birlikte)");
  ok(eng1.specificity === null && eng1.trueNegatives === null, "temiz çalışma yoksa özgüllük null (uydurulmaz)");
  ok(r1.engines.length === 1, "motor düzeyi tek satır (tek motor)");
  ok(row.ppv !== null && eng1.ppv !== null && Math.abs(row.ppv - eng1.ppv) < 1e-9, "tek motorda kategori ve motor PPV'si tutarlı");
  ok(r1.totals.decided === 5 && r1.totals.approved === 3 && r1.totals.rejected === 1, "toplamlar satırlarla tutarlı");
  ok(r1.falsePositives.length === 1 && r1.falsePositives[0].reason === "vasküler kesit", "yanlış pozitif listesi gerekçeyi taşır");
  ok(r1.falsePositives[0].slice === 42 && r1.falsePositives[0].score === 0.62 && r1.falsePositives[0].studyRef === "#7", "yanlış pozitif izlenebilirlik alanları");
  ok(r1.warnings.some((x) => /kaçırdı/.test(x)), "kaçırılan yoksa uyarı verilir");
  ok(r1.warnings.some((x) => /özgüllük/.test(x)), "temiz çalışma yoksa özgüllük uyarısı");

  // ── 3. "AI kaçırdı" (manual) → duyarlılık ──
  const r2 = summarizeFeedback([
    F({ decision: "onaylandi" }), F({ decision: "onaylandi" }), F({ decision: "reddedildi" }),
    F({ manual: true, decision: "onaylandi", category: "Hekim", label: "AI kaçırdı: pnömotoraks", slice: 12 }),
    F({ manual: true, decision: "onaylandi", category: "Hekim", label: "AI kaçırdı: fraktür" }),
  ]);
  const row2 = r2.rows[0];
  const eng2 = r2.engines[0];
  ok(eng2.missed === 2 && eng2.shown === 3 && row2.shown === 3, "elle eklenen bulgular shown'a SAYILMAZ, missed'a yazılır");
  ok(near(eng2.sensitivity, 2 / 4), "duyarlılık = onaylanan 2 / (2 onay + 2 kaçırılan) = 0.5");
  ok(r2.missed.length === 2 && r2.missed[0].label.includes("kaçırdı"), "kaçırılan bulgu listesi dolar");
  ok(!r2.warnings.some((x) => /kaçırdı/.test(x)), "kaçırılan varsa 'şişme' uyarısı kalkar");
  ok(near(r2.totals.sensitivity, 0.5), "toplam duyarlılık motorlar arası birleşik");

  // ── 4. Özgüllük: temiz çalışma verilince ──
  const clean: CleanCase[] = [
    { engine: "cxr", category: "—", clean: true },
    { engine: "cxr", category: "—", clean: true },
    { engine: "cxr", category: "—", clean: true },
    { engine: "cxr", category: "—", clean: false }, // okunmamış/eksik → sayılmaz
  ];
  const r3 = summarizeFeedback([F({ decision: "reddedildi" })], clean);
  ok(r3.engines[0].trueNegatives === 3, "clean=true olan çalışmalar gerçek negatif");
  ok(near(r3.engines[0].specificity, 3 / 4), "özgüllük = 3 / (3 + 1 ret) = 0.75");
  ok(r3.rows[0].ppv === 0, "kategori PPV = 0 (tek aday reddedildi)");
  ok(near(r3.totals.specificity, 0.75), "toplam özgüllük");
  ok(r3.totals.cleanStudies === 3, "temiz çalışma sayısı raporda");

  // ── 5. Kırpma ve temizlik ──
  const many = Array.from({ length: FP_LIST_MAX + 15 }, (_, i) =>
    F({ decision: "reddedildi", reason: `neden ${i}`, label: `b${i}`, }) );
  const r4 = summarizeFeedback(many);
  ok(r4.falsePositives.length === FP_LIST_MAX, `yanlış pozitif listesi ${FP_LIST_MAX} ile kırpılır`);
  ok(r4.rows[0].rejected === FP_LIST_MAX + 15, "kırpma SAYIYI etkilemez (yalnız liste kırpılır)");
  const missedMany = Array.from({ length: MISSED_LIST_MAX + 5 }, () => F({ manual: true, decision: "onaylandi", category: "Hekim" }));
  ok(summarizeFeedback(missedMany).missed.length === MISSED_LIST_MAX, `kaçırılan listesi ${MISSED_LIST_MAX} ile kırpılır`);
  const dirty = summarizeFeedback([F({ decision: "reddedildi", reason: "kötü\u0000neden\nsatır", label: "x".repeat(500) })]);
  ok(!/[\u0000\n]/.test(dirty.falsePositives[0].reason), "gerekçe kontrol karakterlerinden temizlenir");
  ok(dirty.falsePositives[0].label.length <= 120, "etiket uzunluğu sınırlanır");
  const noReason = summarizeFeedback([F({ decision: "reddedildi" })]);
  ok(noReason.falsePositives[0].reason === "(gerekçe girilmemiş)", "gerekçe yoksa açıkça yazılır (boş satır değil)");

  // ── 6. Eşik eğrisi ve öneri ──
  const scoredSmall = Array.from({ length: 10 }, (_, i) => F({ decision: "onaylandi", score: 0.9 }));
  const rs = summarizeFeedback(scoredSmall);
  ok(rs.thresholdCurve.length === 8, "eşik eğrisi 0.2–0.9 ızgarası");
  ok(rs.suggestedThreshold === null, `örnek < ${THRESHOLD_MIN_DECIDED} ise eşik ÖNERİLMEZ`);
  ok(/en az 20/.test(rs.suggestedThresholdWhy), "öneri yokken nedeni yazılır");

  const scoredBig = [
    // 30 yüksek skorlu onay (>=0.9) + 10 düşük skorlu ret (0.3)
    ...Array.from({ length: 30 }, () => F({ decision: "onaylandi", score: 0.95 })),
    ...Array.from({ length: 10 }, () => F({ decision: "reddedildi", score: 0.31 })),
  ];
  const rb = summarizeFeedback(scoredBig);
  // F1 0.4–0.9 arasında eşit (1.0); eşitlikte EN DÜŞÜK eşik seçilir → sınırda duran
  // gerçek pozitifler sessizce düşmesin. Bu yüzden beklenen öneri 0.4'tür.
  ok(rb.suggestedThreshold === 0.4, "eşit F1'de en düşük eşik önerilir (0.4) — sınır adayları korunur");
  const dropped = rb.thresholdCurve.find((p) => p.threshold === rb.suggestedThreshold)!;
  ok(dropped.dropped === 10, "önerilen eşik düşük skorlu 10 reddi eler");
  const at09 = rb.thresholdCurve.find((p) => p.threshold === 0.9)!;
  ok(near(at09.precision, 1) && near(at09.recall, 1), "0.9 eşiğinde kesinlik=1, duyarlılık=1");
  const at05 = rb.thresholdCurve.find((p) => p.threshold === 0.5)!;
  ok(at05.kept === 30 && at05.dropped === 10, "0.5 eşiğinde 10 düşük skorlu aday elenir");
  ok(/ÖNERİ/.test(rb.suggestedThresholdWhy), "öneri metni 'öneri' olduğunu söyler (otomatik uygulanmaz)");
  const unscored = summarizeFeedback(Array.from({ length: 25 }, () => F({ decision: "onaylandi", score: null })));
  ok(unscored.thresholdCurve.every((p) => p.kept === 0) && unscored.suggestedThreshold === null, "skorsuz adaylar eşik hesabına girmez");

  // ── 7. Sıralama / motor ayrımı ──
  const multi = summarizeFeedback([
    F({ engine: "b", decision: "onaylandi" }), F({ engine: "a", decision: "onaylandi" }),
    F({ engine: "a", decision: "reddedildi" }), F({ engine: "a", decision: "reddedildi" }),
    F({ engine: "a", category: "Baska", decision: "onaylandi" }),
  ]);
  ok(multi.rows[0].engine === "a" && multi.rows[0].category === "Akciger", "en çok karar verilen satır başta");
  ok(multi.rows.length === 3, "motor+kategori ayrı satır");
  ok(near(multi.rows.find((r) => r.engine === "a" && r.category === "Akciger")!.ppv!, 1 / 3), "kategori bazlı PPV ayrı hesaplanır");

  // ── 8. Uç sözleşmesi (statik) ──
  const route = read("src/app/api/ai/feedback/route.ts");
  ok(/authorize\(req, \["radyolog", "yonetici"\]\)/.test(route), "uç yalnız radyolog/yönetici");
  ok(/status === "onaylandi"/.test(route), "yalnız onaylı raporlar değerlendirilir (taslak 'negatif' sayılmaz)");
  ok(/ai\.feedback_view/.test(route), "pano görüntülemesi denetime yazılır");
  ok(/source === "manual"/.test(route), "elle eklenen bulgular ayrı işlenir");
  ok(/NON_AI_CATEGORIES/.test(route) && /"Sistem"/.test(route), "Sistem/ROI satırları AI adayı sayılmaz");
  ok(/specificitySource/.test(route), "özgüllüğün kaynağı (proxy) yanıtta açıkça bildirilir");

  // ── 9. Pano + statik demo aynı hesabı kullanır (belgelenen davranış = kod) ──
  const panel = read("src/components/AdminPanel.tsx");
  ok(/data-testid="feedback-loop"/.test(panel), "Yönetim → AI performans panosunda geri bildirim bölümü var");
  ok(/\/api\/ai\/feedback/.test(panel), "pano yeni ucu çağırır");
  ok(/Duyarlılık/.test(panel) && /Özgüllük/.test(panel) && /Yanlış pozitifler/.test(panel), "pano duyarlılık/özgüllük/yanlış pozitif başlıklarını gösterir");
  ok(/sensitivityCI/.test(panel), "pano güven aralığını gösterir (nokta tahmini tek başına değil)");
  ok(/thresholdCurve/.test(panel), "pano eşik eğrisini gösterir");
  const shim = read("src/components/StaticAdminShim.tsx");
  ok(/\/api\/ai\/feedback/.test(shim), "statik demo (GitHub Pages) aynı ucu karşılar");
  ok(/summarizeFeedback\(/.test(shim), "demo verisi ÜRETİMLE aynı saf hesapla üretilir (kopya formül yok)");

  // ── 10. Belge: kılavuz + kıyaslama satırı ──
  const guide = read("docs/MENU_KILAVUZU.md");
  ok(/Duyarlılık/.test(guide) && /yanlış pozitif/i.test(guide), "MENU_KILAVUZU geri bildirim panosunu anlatır");
  const gap = read("src/lib/gapAnalysis.ts");
  ok(/a-feedback/.test(gap) && /feedbackLoop\.ts/.test(gap), "kıyaslama satırı yeni modüle atıf yapar");
  ok(!/FP\/FN istatistiği ve model değerlendirmesi yok/.test(gap), "kıyaslamadaki 'yok' ifadesi güncellendi (artık var)");

  // ── 11. Statik demo yanıtının ŞEKLİ üretimle aynı mı (alan alan) ──
  // AdminPanel bu alanları okur; demo eksik alan dönerse pano demoda kırılır.
  const shimSrc = read("src/components/StaticAdminShim.tsx");
  // Alanlar kaynakta tek tek yazılmaz: yanıt `{...r, ...}` ile raporun TAMAMINI yayar.
  // Bu yüzden yayılım + hesap çağrısı denetlenir (alan listesi kopyalanmaz → alan eklenince kırılmaz).
  ok(/\{\s*\.\.\.r,/.test(shimSrc), "demo yanıtı raporu olduğu gibi yayar (...r) — eksik alan olmaz");
  const sampleReport = summarizeFeedback([F({ decision: "onaylandi" })]);
  for (const key of ["engines", "rows", "falsePositives", "missed", "totals", "thresholdCurve", "suggestedThreshold", "warnings", "note"] as const) {
    ok(key in sampleReport, `rapor '${key}' alanını üretir (demo da aynı nesneyi yayar)`);
  }
  ok(/summarizeFeedback\(demoFeedbackInput, clean\)/.test(shimSrc), "demo, kurgusal girdiyi üretim hesabına verir (formül kopyası yok)");
  ok(/clean: false/.test(shimSrc), "demo, okunmamış çalışmayı 'temiz' saymaz (clean:false)");

  console.log(`\nfeedback-loop: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

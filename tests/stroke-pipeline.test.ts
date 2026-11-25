/**
 * a-stroke: inme hattı — zaman çizelgesi, triyaj penceresi ve kod çağrısı.
 *
 * Sınanan davranışlar: hedef süreleri ve aşım tespiti, ters zaman damgasında
 * uydurma süre üretilmemesi, pencere sınıflandırma sınırları, ASPECTS/CTP
 * birleşimi, eksik verinin "normal" sayılmaması, mükerrer kod çağrısı koruması
 * ve bildirim metninde hasta kimliği bulunmaması.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ctpSvdSummary, type Curve } from "../src/lib/ctp";
import {
  CODE_STROKE_TARGETS,
  codeStrokeDecision,
  GATE_LABELS,
  missedTargets,
  minutesSinceOnset,
  notificationBody,
  STROKE_TARGETS,
  strokeIntervals,
  strokeTriage,
  strokeWindow,
  timelineText,
  WINDOW_LABEL,
  type StrokeTimeline,
} from "../src/lib/strokePipeline";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const at = (h: number, m: number) => `2026-03-04T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

function main() {
  // ── 1) Süreler ve hedefler ──────────────────────────────────────────
  const good: StrokeTimeline = {
    arrival: at(9, 0),
    imaging: at(9, 20),
    interpretation: at(9, 32),
    thrombolysis: at(9, 45),
    thrombectomy: null,
  };
  const r1 = strokeIntervals(good);
  const byKey = (k: string) => r1.intervals.find((i) => i.key === k)!;
  assert.equal(byKey("door-to-imaging").minutes, 20, "kapı → görüntü 20 dk");
  assert.equal(byKey("door-to-imaging").withinTarget, true, "hedef ≤25 dk içinde");
  assert.equal(byKey("imaging-to-decision").minutes, 12, "görüntü → karar 12 dk");
  assert.equal(byKey("door-to-needle").minutes, 45, "kapı → iğne 45 dk");
  assert.equal(byKey("door-to-needle").withinTarget, true, "kapı-iğne hedefi içinde");
  assert.equal(byKey("door-to-groin").minutes, null, "trombektomi yoksa süre yok");
  assert.equal(byKey("door-to-groin").withinTarget, null, "ölçüm yoksa hedef kararı yok");
  assert.equal(r1.totalMinutes, 45, "toplam tedaviye 45 dk");
  assert.deepEqual(r1.problems, [], "sorun yok");
  assert.deepEqual(missedTargets(r1.intervals), [], "hedef aşımı yok");
  assert.match(timelineText(r1), /Kapı → iğne: 45 dk \(hedef ≤60\)/, "metinde süre+hedef");

  const bad: StrokeTimeline = { ...good, imaging: at(9, 40), thrombolysis: at(10, 30) };
  const r2 = strokeIntervals(bad);
  const missed = missedTargets(r2.intervals).map((m) => m.key);
  assert.deepEqual(missed.sort(), ["door-to-imaging", "door-to-needle"].sort(), "iki hedef aşıldı");
  assert.match(timelineText(r2), /HEDEF AŞILDI/, "metin aşımı işaretler");
  assert.equal(STROKE_TARGETS.doorToNeedle, 60, "kapı-iğne hedefi 60 dk");

  // Ters zaman: negatif süre üretilmez, gerekçe yazılır.
  const reversed: StrokeTimeline = { ...good, imaging: at(8, 50) };
  const r3 = strokeIntervals(reversed);
  assert.equal(r3.intervals.find((i) => i.key === "door-to-imaging")!.minutes, null, "ters sıra → süre yok");
  assert.match(r3.problems[0] ?? "", /Görüntüleme zamanı Kapı \(acil varış\) zamanından önce/, "problem açıklanır");

  // Bozuk tarih sessizce atlanır.
  const broken: StrokeTimeline = { arrival: "bozuk", imaging: at(9, 20), interpretation: null, thrombolysis: null, thrombectomy: null };
  const r4 = strokeIntervals(broken);
  assert.equal(r4.intervals.every((i) => i.minutes === null), true, "bozuk tarihte süre yok");
  assert.equal(r4.totalMinutes, null, "toplam yok");
  assert.equal(timelineText(strokeIntervals({ arrival: null, imaging: null, interpretation: null, thrombolysis: null, thrombectomy: null })), "Zaman çizelgesi: ölçülebilir süre yok.", "boş çizelge metni");
  assert.equal(GATE_LABELS.thrombectomy, "Kasık (trombektomi)", "etiket");
  console.log("PASS zaman çizelgesi (hedefler, aşım, ters/bozuk zaman)");

  // ── 2) Pencere sınıflandırma ────────────────────────────────────────
  assert.equal(strokeWindow(null), "belirsiz", "başlangıç yok");
  assert.equal(strokeWindow(0), "tromboliz-penceresi", "0 dk");
  assert.equal(strokeWindow(270), "tromboliz-penceresi", "270 dk sınırda tromboliz");
  assert.equal(strokeWindow(271), "trombektomi-penceresi", "271 dk trombektomi penceresi");
  assert.equal(strokeWindow(1440), "trombektomi-penceresi", "1440 dk sınır");
  assert.equal(strokeWindow(1441), "pencere-disi", "24 saat sonrası");
  assert.match(WINDOW_LABEL["trombektomi-penceresi"], /seçilmiş hastada/, "pencere etiketi seçim ölçütü olmadığını söyler");
  assert.equal(minutesSinceOnset(at(9, 0), at(10, 30)), 90, "90 dk");
  assert.equal(minutesSinceOnset(at(10, 0), at(10, 30)), 30, "30 dk");
  assert.equal(minutesSinceOnset(null, at(10, 30)), null, "başlangıç yok");
  assert.equal(minutesSinceOnset(at(10, 0), "bozuk"), null, "şimdi bozuk");
  assert.equal(minutesSinceOnset(at(11, 0), at(10, 0)), null, "negatif fark → null");
  console.log("PASS pencere sınıflandırma (0–270 / 271–1440 / dışı)");

  // ── 3) Triyaj: ASPECTS + CTP birleşimi ──────────────────────────────
  const early = strokeTriage({ onset: at(9, 0), now: at(10, 0), aspectsAbnormal: ["M2"], lvo: null });
  assert.equal(early.window, "tromboliz-penceresi", "erken pencere");
  assert.equal(early.aspects?.score, 9, "ASPECTS 9");
  assert.equal(early.severity, "yuksek", "pencere içi → yüksek öncelik");
  assert.match(early.headline, /^İNME TRİYAJ · başlangıçtan 60 dk · 0–4,5 saat/, "başlık biçimi");
  assert.match(early.headline, /ASPECTS 9/, "ASPECTS başlıkta");
  assert.ok(!early.caveats.some((c) => c.includes("BVO")), "BVO bilinmiyorsa uyarı yok");

  const lvoCase = strokeTriage({ onset: at(9, 0), now: at(10, 0), aspectsAbnormal: [], lvo: true });
  assert.equal(lvoCase.severity, "kritik", "BVO → kritik");
  assert.ok(lvoCase.caveats.some((c) => c.includes("trombektomi merkezi")), "BVO uyarısı");

  const late = strokeTriage({ onset: at(9, 0), now: at(18, 0), aspectsAbnormal: ["M1", "M2", "M3", "M4", "M5", "insularRibbon"], lvo: null });
  assert.equal(late.window, "trombektomi-penceresi", "540 dk → trombektomi penceresi");
  assert.equal(late.aspects?.score, 4, "ASPECTS 4");
  assert.ok(late.caveats.some((c) => c.includes("geniş alan tutulumu")), "düşük ASPECTS uyarısı");
  assert.equal(late.severity, "yuksek", "core yok + pencere içi → yüksek");

  const outside = strokeTriage({ onset: "2026-03-03T01:00:00.000Z", now: at(9, 0), aspectsAbnormal: [], lvo: null });
  assert.equal(outside.window, "pencere-disi", "32 saat → pencere dışı");
  assert.equal(outside.minutesFromOnset, 1920, "1920 dk");
  assert.ok(outside.caveats.some((c) => c.includes("24 saati geçti")), "pencere dışı uyarısı");

  const unknown = strokeTriage({ onset: null, now: at(9, 0), aspectsAbnormal: [], lvo: null });
  assert.equal(unknown.window, "belirsiz", "başlangıç bilinmiyor");
  assert.equal(unknown.severity, "orta", "belirsiz → orta");
  assert.ok(unknown.caveats.some((c) => c.includes("uyanış inmesi")), "uyanış inmesi notu");
  assert.equal(unknown.aspects, null, "işaretleme yoksa ASPECTS uydurulmaz");
  assert.equal(unknown.coreRegions, null, "CTP yoksa bölge sayısı yok");
  console.log("PASS triyaj (pencere + ASPECTS + BVO + eksik veri)");

  // ── 4) CTP entegrasyonu ─────────────────────────────────────────────
  // Sentetik konvolüsyon: AIF geniş, doku gecikmiş ve düşük genlikli.
  const mk = (amp: number, delay: number): Curve => {
    const t = Array.from({ length: 24 }, (_, i) => i);
    const v = t.map((x) => 30 + (x >= delay ? amp * Math.exp(-((x - delay - 3) ** 2) / 18) : 0));
    return { t, v };
  };
  const ctp = ctpSvdSummary([mk(60, 0), mk(35, 2), mk(12, 6), mk(55, 0)]);
  assert.ok(ctp, "CTP özeti üretildi");
  const withCtp = strokeTriage({ onset: at(9, 0), now: at(11, 0), aspectsAbnormal: ["M2"], ctp, lvo: null });
  assert.equal(typeof withCtp.coreRegions, "number", "core bölge sayısı sayısal");
  assert.equal(typeof withCtp.penumbraRegions, "number", "penumbra bölge sayısı sayısal");
  assert.match(withCtp.headline, /core \d+ \/ penumbra \d+ bölge/, "başlıkta CTP özeti");
  if ((withCtp.coreRegions ?? 0) > 0) {
    assert.equal(withCtp.severity, "kritik", "core varsa kritik");
  }
  const lowMismatch = strokeTriage({
    onset: at(9, 0), now: at(11, 0), aspectsAbnormal: [],
    ctp: { ...ctp!, coreIndices: [1], penumbraIndices: [2], mismatchRatio: 1 }, lvo: null,
  });
  assert.ok(lowMismatch.caveats.some((c) => c.includes("<1,2")), "düşük mismatch uyarısı");
  console.log("PASS CTP entegrasyonu (bölge sayıları + mismatch uyarısı)");

  // ── 5) Kod inme çağrısı (mükerrer koruma) ───────────────────────────
  const tri = strokeTriage({ onset: at(9, 0), now: at(10, 0), aspectsAbnormal: [], lvo: true });
  const first = codeStrokeDecision(tri, { studyUid: "1.2.3", existing: null });
  assert.equal(first.create, true, "ilk çağrı oluşturulur");
  assert.equal(first.severity, "kritik", "BVO → kritik bildirim");
  assert.match(first.message, /^KOD İNME — /, "mesaj biçimi");

  const dup = codeStrokeDecision(tri, { studyUid: "1.2.3", existing: { id: 42, createdAt: at(9, 5), acked: false } });
  assert.equal(dup.create, false, "açık çağrı varken yenisi açılmaz");
  assert.match(dup.reason, /açık bir inme çağrısı var \(#42\)/, "gerekçe mevcut çağrıyı gösterir");

  const reOpen = codeStrokeDecision(tri, { studyUid: "1.2.3", existing: { id: 42, createdAt: at(9, 5), acked: true } });
  assert.equal(reOpen.create, true, "yanıtlanmış çağrıdan sonra yeni çağrı");
  assert.match(reOpen.reason, /yanıtlanmış/, "gerekçe");

  const body = notificationBody(tri, "1.2.840.113619.2.55.3");
  assert.match(body, /İNME TRİYAJ/, "gövde triyaj başlığı taşır");
  assert.match(body, /Çalışma: 1\.2\.840/, "çalışma kimliği");
  assert.match(body, /hekim değerlendirmesine tabidir/, "sorumluluk notu");
  assert.ok(!/HASTA|AYŞE|12345/.test(body), "hasta kimliği taşınmaz");
  assert.equal(CODE_STROKE_TARGETS.length, 3, "üç hedef rol");
  assert.ok(CODE_STROKE_TARGETS.every((t) => t.slaMinutes > 0), "SLA tanımlı");
  console.log("PASS kod inme çağrısı (mükerrer koruma, kimlik taşımama)");

  // ── 6) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/stroke/route.ts");
  assert.ok(route.includes('authorize(req, ["radyolog", "yonetici", "teknisyen"])'), "klinik roller");
  assert.ok(route.includes("codeStrokeDecision") && route.includes("strokeIntervals") && route.includes("strokeTriage"), "üç işlem bağlı");
  assert.ok(route.includes("ctpSvdSummary") && route.includes("parseCtpCurves"), "CTP eğrileri sunucuda çözülür");
  assert.ok(route.includes("stroke.code_duplicate") && route.includes("stroke.code") && route.includes("stroke.target_missed"), "denetim kayıtları");
  assert.ok(route.includes("deliverAndRecord"), "kanal teslimatı (a-notify) isteğe bağlı");
  const panel = read("src/components/StructuredScorePanel.tsx");
  assert.ok(panel.includes("KOD İNME çağrısı"), "panelde kod inme düğmesi");
  assert.ok(panel.includes("Süreleri hesapla"), "panelde zaman çizelgesi");
  assert.ok(panel.includes('apiFetch("/api/stroke"'), "yazma isteği CSRF'li apiFetch'ten");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "a-stroke"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:stroke"]?.includes("stroke-pipeline"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm a-stroke (inme hattı) testleri geçti.");
}

main();

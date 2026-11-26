/**
 * h-model-eval — toplu model değerlendirme çekirdeği testleri.
 *
 * Kapsam dürüstlüğü: bu testler hesabın doğruluğunu kanıtlar; klinik performansı
 * KANITLAMAZ (etiketli kohort ve dış doğrulama kurumsal iştir). Çıkarımın
 * kendisi (ai-worker validate betikleri) burada koşmaz.
 *
 * Çalıştırma: npx tsx tests/model-evaluate.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  parseEvalCases,
  confusionAt,
  metricsAt,
  rocAuc,
  brierScore,
  evaluateBatch,
  formatMetricSummary,
  appendEvalToNotes,
  EVAL_MIN_CASES,
  EVAL_MAX_CASES,
  type EvalCase,
} from "../src/lib/modelEvaluate";

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok ${name}`); };
const approx = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `beklenen ${b}, gelen ${a}`);
const C = (score: number, label: 0 | 1): EvalCase => ({ score, label });

console.log("· parseEvalCases");
ok("geçerli liste normalize edilir (label '1'/true → 1)", () => {
  const r = parseEvalCases([{ id: "x", score: 0.5, label: "1" }, { score: 0, label: false }]);
  assert.ok(r.ok);
  assert.deepEqual(r.cases.map((c) => c.label), [1, 0]);
  assert.equal(r.cases[0].id, "x");
});
ok("dizi değilse reddeder", () => { assert.equal(parseEvalCases("[]").ok, false); });
ok("boş dizi reddedilir", () => { assert.equal(parseEvalCases([]).ok, false); });
ok("sınır üzeri örnek sayısı reddedilir", () => { assert.equal(parseEvalCases(new Array(EVAL_MAX_CASES + 1).fill({ score: 0.5, label: 1 })).ok, false); });
ok("score 0–1 dışında reddedilir, index bildirilir", () => {
  const r = parseEvalCases([{ score: 1.5, label: 1 }]);
  assert.equal(r.ok, false); if (!r.ok) assert.match(r.error, /Örnek 0/);
});
ok("NaN score reddedilir", () => { assert.equal(parseEvalCases([{ score: Number("x"), label: 1 }]).ok, false); });
ok("label 0/1 dışı reddedilir", () => { assert.equal(parseEvalCases([{ score: 0.5, label: 2 }]).ok, false); });

console.log("· confusionAt / metricsAt");
const sep = [C(0.9, 1), C(0.8, 1), C(0.7, 1), C(0.2, 0), C(0.1, 0)];
ok("ayrılabilen kümede 0.5 eşiğinde kusursuz tablo", () => {
  const m = metricsAt(sep, 0.5);
  assert.deepEqual([m.tp, m.fp, m.tn, m.fn], [3, 0, 2, 0]);
  approx(m.accuracy, 1); approx(m.sensitivity, 1); approx(m.specificity, 1); approx(m.ppv, 1); approx(m.f1, 1);
});
ok("0.85 eşiğinde FN oluşur ve sens düşer", () => {
  const m = metricsAt(sep, 0.85);
  assert.deepEqual([m.tp, m.fn], [1, 2]);
  approx(m.sensitivity, 1 / 3);
});
const mixed = [C(0.9, 1), C(0.4, 1), C(0.8, 0), C(0.35, 0)];
ok("karışık kümede elle hesaplanan değerler", () => {
  const m = metricsAt(mixed, 0.5);
  // tp=1 (0.9), fp=1 (0.8), tn=1 (0.35), fn=1 (0.4)
  assert.deepEqual([m.tp, m.fp, m.tn, m.fn], [1, 1, 1, 1]);
  approx(m.sensitivity, 0.5); approx(m.specificity, 0.5); approx(m.ppv, 0.5); approx(m.accuracy, 0.5);
});
ok("pozitif tahmin yoksa PPV null, F1 null", () => {
  const m = metricsAt([C(0.1, 0), C(0.2, 0)], 0.9);
  assert.equal(m.ppv, null); assert.equal(m.f1, null);
});
ok("gerçek pozitif yoksa duyarlılık null", () => {
  const m = metricsAt([C(0.9, 0), C(0.8, 0)], 0.5);
  assert.equal(m.sensitivity, null);
});

console.log("· rocAuc");
ok("ayrılabilir kümede AUC = 1", () => approx(rocAuc(sep), 1));
ok("elle hesaplanan 0.75", () => approx(rocAuc(mixed), 0.75));
ok("ters ayrımlı kümede AUC = 0", () => approx(rocAuc([C(0.1, 1), C(0.9, 0)]), 0));
ok("tam bağlı skorlar 0.5 verir", () => approx(rocAuc([C(0.5, 1), C(0.5, 0), C(0.5, 1)]), 0.5));
ok("tek sınıfsa null", () => {
  assert.equal(rocAuc([C(0.1, 1), C(0.9, 1)]), null);
  assert.equal(rocAuc([C(0.1, 0), C(0.9, 0)]), null);
});

console.log("· brierScore");
ok("elle hesaplanan 0.038", () => approx(brierScore(sep), 0.038));
ok("boş listede null", () => assert.equal(brierScore([]), null));

console.log("· evaluateBatch");
ok("küçük örneklemde uyarı dolu", () => {
  const r = evaluateBatch(sep);
  assert.ok(r.warning);
  assert.equal(r.n, 5);
  assert.equal(r.positives, 3);
  assert.equal(r.at.length, 3);
  assert.ok(r.ece !== null && r.ece >= 0 && r.ece <= 1);
  assert.ok(r.bestF1);
});
ok("≥ EVAL_MIN_CASES örnekte uyarı yok", () => {
  const cases: EvalCase[] = [];
  for (let i = 0; i < EVAL_MIN_CASES; i++) cases.push(C(i % 2 ? 0.9 : 0.1, i % 2 ? 1 : 0));
  const r = evaluateBatch(cases);
  assert.equal(r.warning, null);
});
ok("bestF1 en yüksek F1'li eşiği seçer", () => {
  const r = evaluateBatch(sep);
  assert.ok(r.bestF1);
  const max = Math.max(...r.at.map((m) => m.f1 ?? -1));
  approx(r.bestF1!.f1, max);
});

console.log("· formatMetricSummary / appendEvalToNotes");
ok("özet AUC, Brier, ECE ve @0.5 içerir", () => {
  const s = formatMetricSummary(evaluateBatch(mixed));
  assert.match(s, /n=4/);
  assert.match(s, /AUC=0\.750/);
  assert.match(s, /ECE=/);
  assert.match(s, /@0\.5/);
});
ok("not korunur, EVAL satırı eklenir, 500 sınırı aşılmaz", () => {
  const r = evaluateBatch(mixed);
  const existing = "Önceki not: 2026-01 üretim kaydı.";
  const out = appendEvalToNotes(existing, r, "2026-11-26");
  assert.ok(out.startsWith(existing));
  assert.ok(out.includes("[EVAL 2026-11-26]"));
  assert.ok(out.length <= 500);
});
ok("uzun notta en yeni EVAL korunur, baş kırpılır, ≤ 500", () => {
  const r = evaluateBatch(mixed);
  const longNotes = "X".repeat(600);
  const out = appendEvalToNotes(longNotes, r, "2026-11-26");
  assert.ok(out.includes("[EVAL 2026-11-26]"));
  assert.ok(out.length <= 500);
  assert.ok(out.startsWith("…"));
});
ok("boş nota temiz ekleme", () => {
  const out = appendEvalToNotes("", evaluateBatch(mixed), "2026-11-26");
  assert.ok(out.startsWith("[EVAL 2026-11-26]"));
});

console.log("· route kablolama");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
ok("POST /api/ai/evaluate: yönetici rolü + kayıt defteri + denetim + applyToCard", () => {
  const src = read("src/app/api/ai/evaluate/route.ts");
  assert.match(src, /authorize\(req, \["yonetici"\]\)/);
  assert.match(src, /aiModelRegistry/);
  assert.match(src, /model\.evaluate/);
  assert.match(src, /applyToCard/);
  assert.match(src, /EVAL_MIN_CASES/);
  assert.match(src, /appendEvalToNotes/);
});
ok("package.json test:model-evaluate zincirde", () => {
  const pkg = read("package.json");
  assert.match(pkg, /"test:model-evaluate"/);
  assert.match(pkg, /test:model-evaluate &&/);
});

console.log(`\nTÜM OK — ${passed} denetim geçti`);

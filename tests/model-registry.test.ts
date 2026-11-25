/**
 * Model kayıt defteri + A/B dağıtımı (a-modelops).
 */
import { assignVariant, cohortCheck, compareVersions, registrySummary, trafficPlan, validateRegistration, type ModelVersion } from "../src/lib/modelRegistry";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── kayıt doğrulama ──
ok(!validateRegistration({ modelKey: "BAD KEY", version: "1.0" }).ok, "geçersiz anahtar reddedilir");
ok(!validateRegistration({ modelKey: "nodule", version: "v1" }).ok, "geçersiz sürüm reddedilir");
ok(!validateRegistration({ modelKey: "nodule", version: "1.0", stage: "canli" }).ok, "bilinmeyen aşama reddedilir");
ok(!validateRegistration({ modelKey: "nodule", version: "1.0", stage: "emekli", trafficPct: 20 }).ok, "emekli sürüme trafik verilemez");
ok(!validateRegistration({ modelKey: "nodule", version: "1.0", stage: "gölge", trafficPct: 20 }).ok, "gölge sürüm trafik almaz");
const good = validateRegistration({ modelKey: "nodule.ct", version: "1.2.3", stage: "aktif", trafficPct: 20.6, artifactHash: "sha256:abc", notes: " test " });
ok(good.ok && good.value!.trafficPct === 21 && good.value!.notes === "test", "geçerli kayıt temizlenir ve yuvarlanır");

// ── sürüm karşılaştırma ──
ok(compareVersions("1.10", "1.9") > 0, "sürüm sayısal karşılaştırılır (1.10 > 1.9)");
ok(compareVersions("1.2.3", "1.2.3") === 0 && compareVersions("2.0", "1.9.9") > 0, "eşit ve büyük sürüm");
ok(compareVersions("1.0", "1.0.1") < 0, "eksik basamak küçük sayılır");

// ── trafik planı ──
const mk = (version: string, stage: ModelVersion["stage"], trafficPct: number): ModelVersion =>
  ({ id: Number(version.replace(/\D/g, "")) || 1, modelKey: "nodule.ct", version, stage, trafficPct, artifactHash: "", notes: "", createdBy: "x", createdAt: "2026-01-01" });
const plan = trafficPlan([mk("1.0", "aktif", 80), mk("1.1", "aktif", 20), mk("1.2", "aday", 0)]);
ok(plan.buckets.length === 2 && plan.buckets[0].pct === 80 && !plan.normalized, "aktif sürümler ve yüzdeler korunur");
const weird = trafficPlan([mk("1.0", "aktif", 3), mk("1.1", "aktif", 1)]);
ok(weird.normalized && Math.round(weird.buckets[0].pct) === 75, "toplam 100 değilse oranlanır ve normalized=true");
ok(trafficPlan([mk("1.0", "aday", 0)]).error === "Aktif sürüm yok" && trafficPlan([]).buckets.length === 0, "aktif yoksa plan boş ve neden yazılı");

// ── deterministik A/B ──
const a = assignVariant(plan, "P-1001");
const b = assignVariant(plan, "P-1001");
ok(a !== null && a === b, "aynı hasta aynı sürümde kalır");
const subjects = Array.from({ length: 2000 }, (_, i) => `P-${i}`);
const check = cohortCheck(plan, subjects);
ok(check.observed.reduce((s, o) => s + o.pct, 0) > 99.9, "kohort yüzdeleri toplamı ~100");
ok(check.maxDeviation < 5, `kohort sapması küçük (${check.maxDeviation.toFixed(2)} puan)`);
ok(assignVariant(trafficPlan([mk("9.9", "aktif", 100)]), "P-1") === "9.9", "tek aktif sürümde herkes aynı sürümde");
ok(assignVariant(trafficPlan([]), "P-1") === null, "aktif sürüm yoksa atama yapılmaz (uydurma sürüm yok)");

// ── özet ──
const summary = registrySummary([
  mk("1.0", "aktif", 100),
  { ...mk("1.1", "gölge", 0), updatedAt: "2026-11-20T10:00:00Z" },
  { ...mk("0.9", "emekli", 0), updatedAt: "2026-01-01T10:00:00Z" },
]);
ok(summary.total === 3 && summary.byStage.aktif === 1 && summary.byStage.gölge === 1 && summary.byStage.emekli === 1, "aşama sayıları");
ok(summary.activeKey === "nodule.ct" && summary.activeVersion === "1.0", "aktif sürüm özette");
ok(summary.lastChange?.version === "1.1", "son değişiklik tarihe göre seçiliyor");
ok(registrySummary([]).activeVersion === null, "boş kayıtta aktif sürüm uydurulmaz");

if (failed) { console.error(`${failed} model kayıt defteri testi başarısız`); process.exit(1); }
console.log("Tüm model kayıt defteri (a-modelops) testleri geçti.");

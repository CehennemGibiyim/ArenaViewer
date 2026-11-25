/**
 * a-modelops: model kayıt defteri yardımcıları.
 *
 * Kapsam: kayıt doğrulama, deterministik tohum/kovalama, A/B ataması (trafik
 * oranları, eksik/aşırı toplam, görev süzgeci), tutarlılık uyarıları ve aşama sayımı.
 */
import {
  assignModel, bucketOf, fnv1a, registryIssues, stageChangeNote, stageSummary, validateEntry,
  type RegistryEntry,
} from "../src/lib/modelRegistry";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const entry = (o: Partial<RegistryEntry> & { name: string; version: string }): RegistryEntry => ({
  modality: "CT", task: "nodule", stage: "aktif", trafficPercent: 100, fingerprint: "sha256:abc", notes: "", ...o,
});

// ── doğrulama ──
ok(validateEntry({ name: "", version: "1" }).length > 0, "model adı zorunlu");
ok(validateEntry({ name: "m", version: "" }).length > 0, "sürüm zorunlu");
ok(validateEntry({ name: "m", version: "1", stage: "aktif", trafficPercent: 50 }).length === 0, "geçerli kayıt sorunsuz");
ok(validateEntry({ name: "m", version: "1", stage: "aday", trafficPercent: 101 }).some((i) => i.includes("0–100")), "trafik >100 reddedilir");
ok(validateEntry({ name: "m", version: "1", stage: "aday", trafficPercent: -1 }).some((i) => i.includes("0–100")), "negatif trafik reddedilir");
ok(validateEntry({ name: "m", version: "1", stage: "aktif", trafficPercent: 0 }).some((i) => i.includes("0 olamaz")), "aktif model 0 trafik alamaz");
ok(validateEntry({ name: "m", version: "1", stage: "baska" as never, trafficPercent: 10 }).some((i) => i.includes("Aşama")), "bilinmeyen aşama reddedilir");
ok(validateEntry({ name: "a".repeat(81), version: "1", trafficPercent: 10 }).some((i) => i.includes("80")), "ad uzunluğu sınırlı");
ok(validateEntry({ name: "m", version: "1", trafficPercent: 10, notes: "n".repeat(501) }).some((i) => i.includes("500")), "not uzunluğu sınırlı");

// ── tohum / kova ──
ok(fnv1a("abc") === fnv1a("abc") && fnv1a("abc") !== fnv1a("abd"), "FNV-1a deterministik ve farklı tohumda farklı");
ok(fnv1a("") >= 0 && fnv1a("çok uzun bir tohum metni") >= 0, "boş/uzun tohumda negatif dönmez");
const buckets = Array.from({ length: 500 }, (_, i) => bucketOf(`study-${i}`));
ok(buckets.every((b) => b >= 0 && b <= 99), "kovalar 0–99 arasında");
ok(new Set(buckets).size > 80, "farklı tohumlar kovalara yayılır");

// ── A/B ataması ──
const ab = [entry({ name: "m-a", version: "1", trafficPercent: 30 }), entry({ name: "m-b", version: "1", trafficPercent: 70 })];
const first = assignModel(ab, { seed: "study-42" });
ok(first.model !== null, "A/B kaydında model seçilir");
ok(assignModel(ab, { seed: "study-42" }).model?.name === first.model?.name, "aynı tohum her zaman aynı modeli seçer");
const counts = new Map<string, number>();
for (let i = 0; i < 4000; i++) {
  const m = assignModel(ab, { seed: `patient-${i}` }).model!;
  counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
}
const shareA = (counts.get("m-a") ?? 0) / 4000;
ok(Math.abs(shareA - 0.3) < 0.03, `trafik %30 dağıtıma yansır (ölçülen ${(shareA * 100).toFixed(1)}%)`);

// tek model
const single = [entry({ name: "only", version: "2", trafficPercent: 100 })];
ok(assignModel(single, { seed: "x" }).model?.name === "only", "tek aktif model her zaman seçilir");
ok(assignModel(single, { seed: "x" }).reason.includes("Trafik"), "gerekçe metni döner");

// aktif model yok
ok(assignModel([entry({ name: "a", version: "1", stage: "aday" })], { seed: "x" }).model === null, "aktif model yoksa null");
ok(assignModel([], { seed: "x" }).model === null, "boş defterde null");

// boş trafik
const zero = [entry({ name: "z1", version: "1", trafficPercent: 0 }), entry({ name: "z2", version: "1", trafficPercent: 0 })];
ok(assignModel(zero, { seed: "x" }).model === null && assignModel(zero, { seed: "x" }).reason.includes("A/B"), "iki model ve trafik 0 → dağıtım yapılamaz");
ok(assignModel([entry({ name: "z", version: "1", trafficPercent: 0 })], { seed: "x" }).model?.name === "z", "tek model ve trafik 0 → yine de seçilir");

// eksik toplam: kalan ilk aktif modele (alfabetik) düşer
const under = [entry({ name: "b-model", version: "1", trafficPercent: 40 }), entry({ name: "a-model", version: "1", trafficPercent: 10 })];
const underRes = assignModel(under, { seed: "abc" });
ok(underRes.model !== null && underRes.reason.includes("kalan"), "toplam <100 uyarısı döner");
const underCounts = new Map<string, number>();
for (let i = 0; i < 2000; i++) {
  const n = assignModel(under, { seed: `s-${i}` }).model!.name;
  underCounts.set(n, (underCounts.get(n) ?? 0) + 1);
}
// a-model %10 alır, kalan %50 de ona eklenir → ~%60
ok(Math.abs((underCounts.get("a-model") ?? 0) / 2000 - 0.6) < 0.05, `eksik trafik ilk aktif modele eklenir (~%60, ölçülen ${(((underCounts.get("a-model") ?? 0) / 2000) * 100).toFixed(1)}%)`);

// aşırı toplam: normalize
const over = [entry({ name: "x1", version: "1", trafficPercent: 100 }), entry({ name: "x2", version: "1", trafficPercent: 100 })];
ok(assignModel(over, { seed: "abc" }).reason.includes("normalize"), "toplam >100 normalize edilir");
const overCounts = new Map<string, number>();
for (let i = 0; i < 2000; i++) {
  const n = assignModel(over, { seed: `o-${i}` }).model!.name;
  overCounts.set(n, (overCounts.get(n) ?? 0) + 1);
}
ok((overCounts.get("x1") ?? 0) / 2000 > 0.4 && (overCounts.get("x2") ?? 0) / 2000 > 0.4, "aşırı toplamda modeller ~eşit pay alır");

// görev süzgeci + emekli model dışlanır
const multi = [
  entry({ name: "nod", version: "1", task: "nodule", trafficPercent: 100 }),
  entry({ name: "stroke", version: "1", task: "stroke", trafficPercent: 100 }),
  entry({ name: "old", version: "0", task: "nodule", stage: "emekli", trafficPercent: 100 }),
];
ok(assignModel(multi, { seed: "s1", task: "stroke" }).model?.name === "stroke", "görev süzgeci çalışır");
ok(assignModel(multi, { seed: "s1", task: "nodule" }).model?.name === "nod", "aynı görevde emekli model seçilmez");
ok(assignModel(multi, { seed: "s1", task: "yok" }).model === null, "kayıtsız görevde model yok");

// ── tutarlılık ve sayım ──
ok(registryIssues(ab).length === 0, "geçerli defterde uyarı yok");
ok(registryIssues([entry({ name: "d", version: "1" }), entry({ name: "D", version: "1" })]).some((i) => i.includes("iki kez")), "aynı ad+sürüm mükerrer sayılır");
ok(registryIssues([entry({ name: "p", version: "1", task: "t", trafficPercent: 70 }), entry({ name: "q", version: "1", task: "t", trafficPercent: 60 })]).some((i) => i.includes("aşıyor")), "görev bazında >%100 toplam uyarı verir");
ok(registryIssues([entry({ name: "e", version: "1", stage: "emekli", trafficPercent: 100 }), entry({ name: "f", version: "1", stage: "emekli", trafficPercent: 100 })]).length === 0, "emekli modeller toplama katılmaz");
ok(registryIssues([entry({ name: "", version: "" } as never)]).length > 0, "bozuk kayıt defterde de raporlanır");

const sum = stageSummary([entry({ name: "1", version: "1", stage: "aday" }), entry({ name: "2", version: "1", stage: "aktif" }), entry({ name: "3", version: "1", stage: "emekli" }), entry({ name: "4", version: "1", stage: "??" as never })]);
ok(sum.aday === 2 && sum.aktif === 1 && sum.emekli === 1, "aşama sayımı (bilinmeyen → aday)");

ok(stageChangeNote(null, "aktif").includes("oluşturuldu"), "yeni kayıt denetim notu");
ok(stageChangeNote("aday", "aktif").includes("aday → aktif"), "aşama değişikliği denetim notu");
ok(stageChangeNote("aktif", "aktif") === "Aşama değişmedi.", "aynı aşama notu");

if (failed) { console.error(`${failed} model kayıt defteri testi başarısız`); process.exit(1); }
console.log("Tüm model kayıt defteri testleri geçti.");

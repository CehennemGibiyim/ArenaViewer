/**
 * Kıyaslama tablosu "bayat yama" (drift) testi.
 *
 * Neden: `src/lib/gapAnalysis.ts` iki katmanlıdır — `BASE_ITEMS` (satırlar) ve
 * `PATCHES` (sonradan güncellenen satırlar). `GAP_ITEMS` bunları birleştirir ve
 * **PATCHES kazanır**. Bir özellik `BASE_ITEMS` içinde güncellenip `PATCHES`
 * içindeki eski kısa metin bırakılırsa canlı sayfa eski metni gösterir; bu,
 * gerçekte var olan işi "yok" gibi gösteren sessiz bir hatadır (2026-11-25'te
 * v-fusion, f-pixel, r-dictate, t-validation, a-card, v-mip satırlarında oldu).
 *
 * Bu test:
 *  1. Bir yama, taban metni **budayamaz** (son metin taban metnin %60'ından kısa olamaz).
 *  2. Bilinen yanlış iddialar geri gelmemeli (özellik gerçekten koddayken "yok" demek).
 *  3. Sayaç/endeks, durum değerlerinden tutarlı üretilmeli.
 */
import { BASE_ITEMS, GAP_ITEMS } from "../src/lib/gapAnalysis";
import { gapProgress } from "../src/lib/gapProgress";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

ok(GAP_ITEMS.length === 100, `tablo 100 madde taşır (${GAP_ITEMS.length})`);

// 1) Yama taban metni budamaz
const shrunk: string[] = [];
for (const base of BASE_ITEMS) {
  const live = GAP_ITEMS.find((x) => x.id === base.id);
  if (!live || !base.ours || !live.ours || live.ours === base.ours) continue;
  if (live.ours.length < base.ours.length * 0.6) {
    shrunk.push(`${base.id} (${base.ours.length} → ${live.ours.length})`);
  }
}
ok(shrunk.length === 0, `hiçbir yama taban metni budamıyor${shrunk.length ? `: ${shrunk.join(", ")}` : ""}`);

// 2) Bilinen yanlış iddialar geri gelmemeli (hepsi kodda gerçek)
const liveText = (id: string) => {
  const i = GAP_ITEMS.find((x) => x.id === id);
  return `${i?.ours ?? ""} ${i?.action ?? ""}`;
};
const staleClaims: [string, string, string][] = [
  ["v-fusion", "Kayıt (registrasyon) yapılmaz", "rigid + elastik kayıt kodda (fusionRigid.ts, fusionDeform.ts)"],
  ["r-dictate", "Tıbbi sözlük/özel model yok", "dictate.ts tıbbi sözlük düzeltmeleri içeriyor"],
  ["t-validation", "Gölge mod iş akışı ve kontrollü KLİNİK doğrulama çalışması yok", "/api/shadow ve gölge mod kodu var"],
  ["t-validation", "Gölge mod iş akışı yok", "/api/shadow var"],
];
for (const [id, claim, why] of staleClaims) {
  ok(!liveText(id).includes(claim), `"${id}" satırı "${claim}" iddiasını taşımıyor (${why})`);
}

// 3) Yeni işler satırda görünür
ok(liveText("v-fusion").includes("fusionDeform") && liveText("v-fusion").includes("Elastik"), "v-fusion satırı elastik kaydı anıyor");
ok(liveText("v-fusion").includes("ticRoi"), "v-fusion satırı ROI tabanlı TIC'i anıyor");
ok(liveText("f-pixel").includes("photometric"), "f-pixel satırı fotometri modülünü anıyor");
ok(liveText("r-dictate").includes("dictate"), "r-dictate satırı dikte modülünü anıyor");
ok(liveText("m-persist").includes("TID 1500"), "m-persist satırı ölçümlerin TID 1500 SR dışa aktarımını anıyor");
ok(!liveText("m-persist").includes("Ölçümleri veritabanına kaydet"), "m-persist satırı \"ölçümleri veritabanına kaydet\" (zaten yapılan) işini aksiyon olarak önermiyor");

// 4) Sayaç/endeks tutarlılığı
const c = gapProgress(GAP_ITEMS);
const varCount = GAP_ITEMS.filter((i) => i.status === "var").length;
const kismiCount = GAP_ITEMS.filter((i) => i.status === "kismi").length;
const yokCount = GAP_ITEMS.filter((i) => i.status === "yok").length;
ok(c.var === varCount && c.kismi === kismiCount && c.yok === yokCount, `sayaçlar durumlarla uyumlu (${c.var}/${c.kismi}/${c.yok})`);
ok(varCount + kismiCount + yokCount === 100, "durum toplamı 100");
ok(c.indexPercent === Math.round(varCount + 0.5 * kismiCount), `endeks var + 0,5×kısmi (${c.indexPercent})`);
ok(c.completedPercent === varCount, `tamamlanan madde oranı yalnız "var" sayar (${c.completedPercent})`);

if (failed) { console.error(`${failed} kıyaslama drift testi başarısız`); process.exit(1); }
console.log("Kıyaslama drift testleri geçti.");

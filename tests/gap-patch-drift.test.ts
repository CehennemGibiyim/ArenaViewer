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

ok(GAP_ITEMS.length === 101, `tablo 101 madde taşır (${GAP_ITEMS.length})`);

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
ok(liveText("m-persist").includes("gspsGraphics"), "m-persist satırı anotasyonların GSPS grafik katmanıyla yazıldığını anıyor");
ok(liveText("v-wl").includes("petWindows"), "v-wl satırı PET SUV pencere ön ayarlarını anıyor");
ok(liveText("t-disclaimer").includes("intendedUse"), "t-disclaimer satırı amaçlanan kullanım kaynağını anıyor");
ok(liveText("r-patient").includes("readability"), "r-patient satırı Ateşman okunabilirlik ölçümünü anıyor");
ok(liveText("r-link").includes("sentenceLinks"), "r-link satırı cümle bağlama modülünü anıyor");
ok(liveText("r-struct").includes("measureTable"), "r-struct satırı ölçüm tablosu modülünü anıyor");
ok(liveText("m-basic").includes("annotationEdit"), "m-basic satırı sürükleyerek düzenleme modülünü anıyor");
ok(liveText("r-review").includes("findingReview"), "r-review satırı uygulanan gerekçe zorunluluğunu (findingReview.ts) anıyor");
ok(liveText("r-patient").includes("patientLetter"), "r-patient satırı hasta mektubu modülünü (TR/EN/DE, sade/standart) anıyor");
ok(liveText("r-export").includes("TID 1500"), "r-export satırı ölçüm SR (TID 1500) çıktısını anıyor");
ok(liveText("t-automation").includes("findingsReason"), "t-automation satırı hekim kararının ayrı saklandığını (findingsReason) anıyor");
ok(liveText("a-feedback").includes("aiDisagreement"), "a-feedback satırı uyuşmazlık panosunu (aiDisagreement.ts) anıyor");
ok(liveText("f-series").includes("sliceGaps"), "f-series satırı kesit aralığı denetimini (sliceGaps.ts) anıyor");
ok(liveText("v-geo").includes("shortcuts"), "v-geo satırı özelleştirilebilir kısayolları (shortcuts.ts) anıyor");
ok(liveText("m-calib").includes("suvVariants"), "m-calib satırı SUVlbm/SUVbsa varyantlarını (suvVariants.ts) anıyor");
ok(!liveText("r-review").includes("panosunda (a-feedback) kategori bazlı gösterilmesi"), "r-review aksiyonu tamamlanan pano işini yeniden istemiyor");
ok(!liveText("m-persist").includes("Ölçümleri veritabanına kaydet"), "m-persist satırı \"ölçümleri veritabanına kaydet\" (zaten yapılan) işini aksiyon olarak önermiyor");

// 2b) Aksiyon metni, "bizde şu an" bölümünde VAR olan işi hâlâ yapılacak gibi önermemeli.
// (2026-11-25 süpürmesi: bu satırlarda aksiyon, tamamlanmış işi tekrar istiyordu.)
const recycledActions: [string, string][] = [
  ["f-series", "Kesit aralığı (spacing) hesabı ve eksik/çift kesit uyarısı"],
  ["v-wl", "Preset kalıcılığı (veritabanı/localStorage)"],
  ["v-geo", "özelleştirilebilir kısayollar"],
  ["v-compare", "ImagePositionPatient tabanlı z-senkronu"],
  ["v-hanging", "Viewport ızgara yöneticisi + kural tabanlı protokoller"],
  ["a-heat", "Model çıktısından yarı saydam örtü katmanı ve opaklık kaydırıcısı"],
  ["a-triage", "Çalışma listesi + triyaj skoruna göre otomatik sıralama"],
  ["a-card", "Her rapora model sürümü"],
  ["r-version", "Değiştirilemez sürüm tablosu, addendum akışı"],
  ["w-worklist", "Tetkik tablosu: durum (bekliyor/okunuyor/taslak/onaylı)"],
  ["w-deid", "araştırma/paylaşım için anonim dışa aktarma"],
  ["r-struct", "Ölçüm tablosunu rapora ekleme"],
  ["r-patient", "Okuma düzeyi ayarı ve çok dilli çıktı"],
  ["a-loc", "Model çıktısını (bbox/maske) aynı Finding yapısına eşle"],
  ["m-calib", "SUVlbm/SUVbsa (boy, cinsiyet), üretici-özel PET etiketleri"],
  ["r-export", "SR içinde yapılandırılmış ölçümler (TID 1500)"],
  ["t-automation", "Hekim kararlarının AI önerisinden ayrı kaydı ve uyuşmazlık raporu"],
  ["m-persist", "anotasyonların grafik nesne olarak DICOM PR (GSPS) ile dışa aktarımı"],
  ["v-wl", "ve PET SUV penceresi"],
  ["t-disclaimer", "Amaçlanan kullanım (intended use) metni ve sürüm bilgisi"],
  ["r-patient", "kuruma özel terim sözlüğü ve okunabilirlik ölçümü"],
  ["r-link", "Rapor cümlelerine bulgu kimliği iliştir"],
  ["r-struct", "ölçüm bölümünün sütunlu tablo düzeniyle basılması"],
  ["m-basic", "ROI ve açı için sürüklenebilir düzenleme"],
  ["f-objects", "SR/PR ayrıştırıcıları, kapsüllenmiş PDF ve MPEG oynatıcı"],
];
for (const [id, phrase] of recycledActions) {
  const action = GAP_ITEMS.find((x) => x.id === id)?.action ?? "";
  ok(!action.includes(phrase) && action.length > 0, `"${id}" aksiyonu tamamlanmış işi yeniden istemiyor (${phrase})`);
}

// 4) Sayaç/endeks tutarlılığı
const c = gapProgress(GAP_ITEMS);
const varCount = GAP_ITEMS.filter((i) => i.status === "var").length;
const kismiCount = GAP_ITEMS.filter((i) => i.status === "kismi").length;
const yokCount = GAP_ITEMS.filter((i) => i.status === "yok").length;
ok(c.var === varCount && c.kismi === kismiCount && c.yok === yokCount, `sayaçlar durumlarla uyumlu (${c.var}/${c.kismi}/${c.yok})`);
ok(varCount + kismiCount + yokCount === 101, "durum toplamı 101");
ok(c.indexPercent === Math.round((100 * (varCount + 0.5 * kismiCount)) / (varCount + kismiCount + yokCount)), `endeks var + 0,5×kısmi/101 (${c.indexPercent})`);
ok(c.completedPercent === varCount, `tamamlanan madde oranı yalnız "var" sayar (${c.completedPercent})`);

if (failed) { console.error(`${failed} kıyaslama drift testi başarısız`); process.exit(1); }
console.log("Kıyaslama drift testleri geçti.");

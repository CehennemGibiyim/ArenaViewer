/**
 * Amaçlanan kullanım / sürüm bilgisi testleri (t-disclaimer).
 *
 * Amaç: ürünün ne olmadığını her yerde aynı metinle söylemek. Testler metnin
 * eksiksiz olduğunu, klinik kullanımı açıkça yasakladığını ve düzenleyici durum
 * hakkında abartılı bir iddia (CE/FDA "belgesi var" gibi) içermediğini doğrular.
 */
import {
  APP_VERSION, BUILD_ID, INTENDED_USE, SHORT_DISCLAIMER, intendedUseText, versionLine,
} from "../src/lib/intendedUse";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const text = intendedUseText();
const lower = text.toLowerCase();

// ── 1. sürüm ──
ok(/^\d+\.\d+\.\d+/.test(APP_VERSION), `sürüm biçimi anlamlı (${APP_VERSION})`);
ok(BUILD_ID.length > 0, `derleme kimliği boş değil (${BUILD_ID})`);
ok(versionLine() === `${APP_VERSION} (derleme ${BUILD_ID})`, "sürüm satırı sürüm + derleme");
ok(versionLine().includes(APP_VERSION) && versionLine().includes(BUILD_ID), "sürüm satırı iki bilgiyi de taşır");

// ── 2. zorunlu alanlar ──
ok(INTENDED_USE.statement.length > 80, "amaçlanan kullanım cümlesi yeterince açıklayıcı");
ok(INTENDED_USE.users.length >= 2, `kullanıcı kitlesi listeli (${INTENDED_USE.users.length})`);
ok(INTENDED_USE.indications.length >= 3, `amaçlanan kullanım alanları listeli (${INTENDED_USE.indications.length})`);
ok(INTENDED_USE.contraindications.length >= 3, `amaçlanmayan kullanımlar listeli (${INTENDED_USE.contraindications.length})`);
ok(INTENDED_USE.limits.length >= 3, `bilinen sınırlar listeli (${INTENDED_USE.limits.length})`);
ok([INTENDED_USE.users, INTENDED_USE.indications, INTENDED_USE.contraindications, INTENDED_USE.limits]
  .every((l) => l.every((s) => s.trim().length > 3)), "hiçbir madde boş değil");

// ── 3. dürüstlük ──
ok(lower.includes("tıbbi cihaz değildir"), "metin 'tıbbi cihaz değildir' diyor");
ok(lower.includes("klinik tanı"), "klinik tanı açıkça amaçlanmayan kullanımda");
ok(INTENDED_USE.contraindications.some((c) => /klinik tanı/i.test(c)), "kontrendikasyonlarda klinik tanı maddesi var");
ok(INTENDED_USE.contraindications.some((c) => /tarama|triage|triyaj/i.test(c)), "tarama/triyaj amaçlanmayan kullanımda");
ok(/CE, FDA, IVDR/.test(INTENDED_USE.regulatory) && /YOKTUR/.test(INTENDED_USE.regulatory), "düzenleyici durum: CE/FDA/IVDR belgesi YOK");
ok(!/CE belgesi (var|alınmıştır)/i.test(text), "abartılı CE iddiası yok");
ok(!/FDA (onaylı|cleared)/i.test(text), "abartılı FDA iddiası yok");
ok(SHORT_DISCLAIMER.includes("klinik karar için kullanılamaz"), "kısa uyarı klinik kullanımı yasaklıyor");
ok(INTENDED_USE.limits.some((l) => /kalibre/i.test(l)), "sınırlar kalibrasyon belirsizliğini anıyor (SUV/ölçüm)");
ok(INTENDED_USE.limits.some((l) => /statik|Pages|tarayıcı/i.test(l)), "statik demo sınırı yazılı");
ok(INTENDED_USE.regulatory.toLowerCase().includes("klinik doğrulama"), "klinik doğrulamanın tamamlanmadığı yazılı");

// ── 4. düz metin çıktısı ──
ok(text.startsWith(`${INTENDED_USE.product} — Amaçlanan Kullanım (sürüm `), "metin başlığı ürün + sürüm ile başlar");
for (const head of ["Kullanıcılar:", "Amaçlanan kullanım:", "Amaçlanmayan kullanımlar:", "Bilinen sınırlar:", "Düzenleyici durum:"]) {
  ok(text.includes(head), `metin '${head}' bölümünü içerir`);
}
ok(INTENDED_USE.indications.every((i) => text.includes(i)), "tüm amaçlanan kullanım maddeleri metinde");
ok(INTENDED_USE.contraindications.every((i) => text.includes(i)), "tüm kontrendikasyon maddeleri metinde");
ok(text.split("\n").every((l) => l.trim().length === 0 || l.startsWith("- ") || l.includes(":") || l.startsWith(INTENDED_USE.product)),
  "metin satırları madde/başlık biçiminde (kopyalanabilir)");

if (failed) { console.error(`${failed} amaçlanan kullanım testi başarısız`); process.exit(1); }
console.log("Amaçlanan kullanım testleri geçti.");

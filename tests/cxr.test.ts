/** CXR teknik kalite / projeksiyon testleri. */
import { cxrProjection, cxrQuality, cxrQualityLine } from "../src/lib/cxr";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

ok(cxrProjection({ viewPosition: "PA" }) === "PA", "PA tanınır");
ok(cxrProjection({ viewPosition: "AP", description: "PORTATIF" }) === "AP", "AP/portatif");
ok(cxrProjection({ viewPosition: "LATERAL", patientOrientation: "L" }) === "yandan", "Yandan");
ok(cxrProjection({ bodyPart: "GÖĞÜS", description: "bilinmiyor" }) === "belirsiz", "Belirsiz tahmin yok");

const good = cxrQuality({ anteriorRibs: 8, rotationMm: 10, penetrationAdequate: true, projection: "PA" });
ok(good.level === 2 && good.advice.includes("yeterli"), "İyi seri → yeterli");
const mid = cxrQuality({ anteriorRibs: 5, rotationMm: 20, penetrationAdequate: true });
ok(mid.level === 1, "Sınırda rib + rotasyon → sınırda");
const bad = cxrQuality({ anteriorRibs: 3, rotationMm: 30, penetrationAdequate: false });
ok(bad.level === 0 && bad.findings.length >= 3, "Kötü seri → yetersiz");
const unknown = cxrQuality({});
ok(unknown.level === 2 && unknown.findings.every((f) => f.includes("bildirilmedi") || f.includes("bilgi yok")), "Eksik ölçüm cezalandırmaz, not düşer");
const ap = cxrQuality({ anteriorRibs: 9, rotationMm: 5, penetrationAdequate: true, projection: "AP" });
ok(ap.note.includes("abartılabilir"), "AP notu uyarır");
ok(cxrQualityLine(bad).startsWith("Teknik kalite: yetersiz."), "Rapor satırı etiketli");

if (failed) { console.error(`${failed} CXR testi başarısız`); process.exit(1); }
console.log("Tüm CXR testleri geçti.");

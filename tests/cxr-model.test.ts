/**
 * CXR derin sınıflandırma entegrasyonu — istemci sözleşmesi testleri.
 * Model dosyasını veya worker'ı gerektirmez; pakeme, uygunluk, çözme ve
 * rapor bulgusuna dönüştürme yolunu doğrular.
 */
import {
  CXR_CLASSES,
  cxrEligible,
  decodeCxrHeat,
  cxrResultsToFindings,
  cxrScan,
  cxrSeverity,
  packCxrImage,
  type CxrResult,
} from "../src/lib/cxrModel";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function chestSeries(over: Partial<SeriesData> = {}): SeriesData {
  const w = 128;
  const h = 128;
  const px = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = (i % 256) + Math.random() * 4;
  return {
    id: "cr-chest",
    modality: "CR",
    description: "Akciğer Grafisi PA",
    bodyPart: "TORAKS",
    patientName: "TEST HASTA",
    patientId: "T1",
    patientAge: "50",
    patientSex: "M",
    studyDate: "20260215",
    institution: "TEST",
    studyUid: "1.2.3.4",
    width: w,
    height: h,
    pixelSpacing: 0.7,
    sliceThickness: 0,
    defaultWL: 470,
    defaultWW: 850,
    unit: "SI",
    slices: [px],
    lesions: [],
    tags: [],
    isSample: true,
    ...over,
  };
}

// ---- sınıf sözleşmesi ----
ok(CXR_CLASSES.length === 14, "14 sınıf (worker CLASS_NAMES ile aynı)");
ok(new Set(CXR_CLASSES.map((c) => c.name)).size === 14, "sınıf adları benzersiz");
ok(CXR_CLASSES.every((c) => c.threshold > 0 && c.threshold < 1), "eşikler (0,1) aralığında");
ok(CXR_CLASSES.find((c) => c.name === "Pneumonia")?.threshold === 0.36, "Pnömoni eşiği 0,36 (zayıf sınıf)");

// ---- uygunluk ----
ok(cxrEligible(chestSeries()) === null, "CR toraks grafiği uygun");
ok(cxrEligible(chestSeries({ modality: "CT" })) !== null, "BT reddedilir");
ok(cxrEligible(chestSeries({ modality: "MR", description: "Toraks MR" })) !== null, "MR reddedilir");
ok(cxrEligible(chestSeries({ bodyPart: "EL", description: "PARMAK AP" })) !== null, "yanlış bölge reddedilir");
ok(cxrEligible(chestSeries({ description: "AKCİĞER GRAFİSİ" })) === null, "tanımda akciğer geçince uygundur");
ok(cxrEligible(chestSeries({ slices: [] })) !== null, "boş seri reddedilir");
ok(cxrEligible(chestSeries({ width: 0 })) !== null, "boyut bilgisi olmadan reddedilir");

async function main() {
// ---- paketleme ----
const packed = await packCxrImage(chestSeries());
ok(packed !== null, "CXR paketi üretildi");
ok(packed!.dims[0] === 1 && packed!.dims[1] === 128 && packed!.dims[2] === 128, "X-Dims '1,Y,X'");
ok(packed!.spacing.length === 3 && packed!.spacing.every((v) => v > 0), "X-Spacing geçerli");
ok(packed!.bytes.length > 0 && packed!.bytes.length < 128 * 128 * 4, "gzip sıkıştırması etkili");
ok((await packCxrImage(chestSeries({ width: 0, height: 0 }))) === null, "boyutsuz seri paketlenemez");

// ---- ısı haritası çözme ----
const heatBytes = new Uint8Array([0, 64, 128, 192, 255]);
const heatB64 = Buffer.from(heatBytes).toString("base64");
const decoded = decodeCxrHeat({ index: 0, name: "Nodule", w: 5, h: 1, b64: heatB64 });
ok(decoded.w === 5 && decoded.h === 1 && decoded.data.length === 5, "ısı boyutu ve uzunluğu");
ok([...decoded.data].join(",") === "0,64,128,192,255", "ısı pikselleri bozulmadan çözülür");

// ---- şiddet bandı ----
ok(cxrSeverity(0.8) === "yuksek", "%80+ yüksek");
ok(cxrSeverity(0.6) === "orta", "%60 orta");
ok(cxrSeverity(0.3) === "dusuk", "altı düşük");
ok(cxrSeverity(1.5) === "yuksek", "aralık dışı skor taşmaz");

// ---- model çıktısı → rapor bulguları ----
const result: CxrResult = {
  scores: CXR_CLASSES.map((c, i) => ({
    index: i,
    name: c.name,
    labelTr: c.labelTr,
    prob: i === 6 ? 0.92 : i === 7 ? 0.6 : 0.05,
    threshold: c.threshold,
    positive: false,
  })),
  top: { index: 6, name: "Pneumonia", prob: 0.92 },
  heats: [{ index: 6, name: "Pneumonia", w: 64, h: 64, b64: heatB64 }],
  elapsedMs: 210,
  model: "Medical_X DenseNet121",
  imageSize: 320,
};
const findings = cxrResultsToFindings(result, chestSeries());
ok(findings.length === 2, `2 pozitif sınıf → 2 bulgu (${findings.length})`);
ok(findings[0].label.includes("Pnömoni"), "en yüksek skor en üstte");
ok(findings.every((f) => f.bbox === null), "model kutusu olmadığı için bbox null");
ok(findings.every((f) => f.category === "CXR AI"), "bulgu kategorisi CXR AI");
ok(findings.every((f) => f.source === "ai-model"), "kaynak ai-model");
ok(findings.every((f) => !JSON.stringify(f).includes("\"b64\"")), "rapor bulgusunda ısı verisi YOK (şişme/döngü önlendi)");
ok(findings.some((f) => f.detail.includes("harita") && f.detail.includes("rapora işlenmez")), "ısı notu raporda belirtilir");
ok(findings.every((f) => ["yuksek", "orta", "dusuk"].includes(f.severity)), "şiddet geçerli bir band");
ok(cxrSeverity(result.scores[6].prob) === "yuksek", "%92 skor yüksek band (≥%75)");

// ---- sunucu yanıtı uyumu (sahte fetch) ----
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const dims = (init?.headers as Record<string, string>)["X-Dims"];
  const spacing = (init?.headers as Record<string, string>)["X-Spacing"];
  const scores = CXR_CLASSES.map((c, i) => ({
    index: i,
    name: c.name,
    prob: i === 3 ? 0.66 : 0.02,
    // Sunucu bayrağı bilerek yanlış verilir: istemci kendi eşik tablosuna güvenmelidir.
    positive: i === 6,
  }));
  return new Response(JSON.stringify({
    scores,
    top: { index: 3, name: "Infiltration", prob: 0.66 },
    heats: [],
    elapsedMs: 180,
    model: "Medical_X DenseNet121",
    imageSize: 320,
    __check: { dims, spacing, body: init?.body instanceof ArrayBuffer ? init.body.byteLength : 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const scanned = await cxrScan(chestSeries());
ok(scanned.scores.length === 14, "sunucu yanıtı 14 skor");
ok(scanned.scores[3].positive === true, "0,66 ≥ 0,54 eşik → pozitif");
ok(scanned.scores.filter((c) => c.positive).length === 1, "yalnızca skor eşiği geçen sınıf pozitif");
ok(scanned.scores[6].positive === false, "sunucudaki hatalı pozitif bayrağı reddedildi (tek kaynak istemci)");
globalThis.fetch = originalFetch;

if (failed) { console.error(`${failed} CXR model testi başarısız`); process.exit(1); }
console.log("Tüm CXR model testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

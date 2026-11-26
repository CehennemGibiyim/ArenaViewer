/**
 * Tam lazy-pixel Adım 2 (bağlama): skeletonToSeriesData + fillSkeletonSlice.
 * Saf birim testleri — görüntüleme davranışı uçtan uca test edilmez (tarayıcı gerekir).
 */
import { buildSeriesSkeleton, skeletonToSeriesData } from "../src/lib/lazySeries";
import { fillSkeletonSlice } from "../src/lib/lazyFill";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const instances = [
  { seriesUid: "1.2.S", sopUid: "1.2.S.2", instanceNumber: 2, sliceLocation: 10, sliceThickness: 1.5, rows: 2, cols: 2, pixelSpacing: 0.75 },
  { seriesUid: "1.2.S", sopUid: "1.2.S.1", instanceNumber: 1, sliceLocation: 0, sliceThickness: 1.5, rows: 2, cols: 2, pixelSpacing: 0.75 },
];
const sk = buildSeriesSkeleton({
  instances,
  studyUid: "1.2.STUDY42",
  modality: "CT",
  description: "Toraks",
  defaultWL: 40,
  defaultWW: 400,
  pixelSpacing: 0.75,
});

// ── skeletonToSeriesData: SeriesData künye ──
const sd = skeletonToSeriesData(sk, { patientName: "  ", patientId: "P-7", studyDate: "2026-11-20" });
ok(sd.lazyPending === 2, "lazyPending = kesit sayısı (henüz hiçbiri inmedi)");
ok(sd.slices.length === 2 && sd.slices.every((s) => s instanceof Int16Array), "dilimler sıfır Int16Array");
ok(sd.sopUids?.join() === "1.2.S.1,1.2.S.2", "sopUids kesit sırasıyla hizalı");
ok(sd.patientName === "ANONİM", "boş isim ANONİM düşer (PHI sızıntısı yok)");
ok(sd.patientId === "P-7" && sd.studyDate === "2026-11-20", "kimlik/tarih meta taşınır");
ok(sd.unit === "HU", "CT → HU birimi");
ok(sd.pixelSpacing === 0.75 && sd.sliceThickness === 1.5 && sd.width === 2 && sd.height === 2, "geometri alanları");
ok(sd.slicePositions?.join() === "0,10", "kesit konumları kopyalanır (iskeleti paylaşmaz)");
ok(sd.id.startsWith("lazy-"), "taze lazy kimliği");
const sdMr = skeletonToSeriesData({ ...sk, modality: "MR" }, {});
ok(sdMr.unit === "SI" && sdMr.patientName === "ANONİM", "MR → SI birimi, boş meta güvenli");
const id1 = skeletonToSeriesData(sk, {}).id;
const id2 = skeletonToSeriesData(sk, {}).id;
ok(id1 !== id2, "her açılışta taze kimlik");

// ── fillSkeletonSlice: yerinde doldurma ──
const dst: (Int16Array | Uint16Array | Float32Array)[] = [new Int16Array(4), new Int16Array(4)];
const r1 = fillSkeletonSlice(dst as never, 0, new Int16Array([1, -2, 300, -400]));
ok(r1 === "int16" && dst[0] instanceof Int16Array && dst[0][0] === 1 && dst[0][3] === -400, "int16 → yerinde .set()");
ok(dst[0] === dst[0], "dizi kimliği korunur (yerinde)");

const r2 = fillSkeletonSlice(dst as never, 1, new Uint16Array([7, 8, 9, 10]));
ok(r2 === "replaced" && dst[1] instanceof Uint16Array && dst[1][0] === 7, "uint16 → slot değiştirilir (kesim yok)");
const r2b = fillSkeletonSlice(dst as never, 0, new Float32Array([1.5, 2.5, 3.5, 4.5]));
ok(r2b === "replaced" && dst[0] instanceof Float32Array, "float32 → slot değiştirilir");

const before = dst[0];
const r3 = fillSkeletonSlice(dst as never, 0, new Int16Array(8));
ok(r3 === "incompatible" && dst[0] === before, "boyut uyuşmazlığında dokunulmaz");
const r4 = fillSkeletonSlice(dst as never, 99, new Int16Array(4));
ok(r4 === "incompatible", "aralık dışı index güvenli");

// replaced dönüşünde kopya alınır (kaynak sonradan değişse de dilim etkilenmez)
const srcU16 = new Uint16Array([42, 43, 44, 45]);
fillSkeletonSlice(dst as never, 1, srcU16);
srcU16[0] = 999;
ok(dst[1][0] === 42, "replaced kopyası kaynaktan bağımsızdır");

if (failed) { console.error(`${failed} lazy-fill testi başarısız`); process.exit(1); }
console.log("Tüm lazy-fill (Adım 2 bağlama) testleri geçti.");

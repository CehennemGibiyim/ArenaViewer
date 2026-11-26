/**
 * a-knee: diz MR segmentasyonu istemci mantığı — birim testler.
 *
 * Model dosyasını veya worker'ı gerektirmez; uygunluk, paketleme, etiket
 * bölme ve hacim ölçümü yolunu doğrular (model çıkarımı kullanıcının
 * makinesinde nnunetv2 ile koşar).
 */
import {
  KNEE_STRUCTURES,
  kneeSegEligible,
  kneeSegSummaryText,
  kneeVolumeStats,
  packMrVolume,
  splitKneeLabels,
} from "../src/lib/kneeSeg";
import { gunzipSync } from "fflate";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function kneeSeries(over: Partial<SeriesData> = {}): SeriesData {
  const w = 6, h = 5, Z = 14;
  const slices: Float32Array[] = [];
  for (let z = 0; z < Z; z++) {
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = 100 + ((i * 7 + z * 13) % 3000);
    slices.push(a);
  }
  return {
    id: "mr-knee",
    modality: "MR",
    description: "Diz Sag T2 FS",
    bodyPart: "DİZ",
    patientName: "TEST HASTA",
    patientId: "T1",
    patientAge: "45",
    patientSex: "M",
    studyDate: "20261120",
    institution: "TEST",
    studyUid: "1.2.3.4.5",
    width: w,
    height: h,
    pixelSpacing: 0.4,
    pixelSpacingX: 0.4,
    sliceThickness: 3,
    sliceSpacing: 3,
    defaultWL: 400,
    defaultWW: 800,
    unit: "SI",
    slices,
    lesions: [],
    tags: [],
    isSample: true,
    ...over,
  };
}

// ── etiket bölme yardımcıları (await'siz) ──
const splitFixture = () => {
  const Z = 3, Y = 4, X = 3;
  const labels = new Uint8Array(Z * Y * X);
  labels[0] = 5;              // z=0, y=0, x=0 → medial menisküs
  labels[1 * Y * X + 2] = 5;  // z=1 → medial menisküs
  labels[1 * Y * X + 7] = 9;  // z=1 → patella kemiği
  labels[2 * Y * X + 5] = 255; // geçersiz etiket atlanmalı
  return splitKneeLabels(labels, [Z, Y, X]);
};

const volumeStatsFixture = () => {
  const Z = 2, Y = 10, X = 10;
  const l = new Uint8Array(Z * Y * X);
  l.fill(5, 0, 100);            // z=0'da 100 voksel medial menisküs
  l.fill(7, Y * X, Y * X + 40); // z=1'de 40 voksel femur kemiği
  return kneeVolumeStats(splitKneeLabels(l, [Z, Y, X]), [3, 0.4, 0.4]);
};

async function main(): Promise<void> {
  // ── uygunluk ──
  ok(kneeSegEligible(kneeSeries()) === null, "geçerli diz MR serisi uygun");
  ok(kneeSegEligible(kneeSeries({ modality: "CT" })) !== null, "BT reddedilir");
  ok(kneeSegEligible(kneeSeries({ slices: kneeSeries().slices.slice(0, 8) })) !== null, "12'den kısa seri reddedilir");
  ok(kneeSegEligible(kneeSeries({ isColor: true })) !== null, "renkli seri reddedilir");
  ok(kneeSegEligible(kneeSeries({ specialType: "pdf" })) !== null, "görüntü dışı seri reddedilir");
  {
    const badLen = kneeSeries();
    badLen.slices = [badLen.slices[0], new Float32Array(10), ...badLen.slices.slice(2)];
    ok(kneeSegEligible(badLen) !== null, "kesit boyutu tutarsız seri reddedilir");
  }
  ok(KNEE_STRUCTURES.length === 9 && KNEE_STRUCTURES[4].id === 5 && KNEE_STRUCTURES[5].id === 6, "9 yapı, menisküsler 5/6");
  ok(KNEE_STRUCTURES.map((s) => s.id).join() === "1,2,3,4,5,6,7,8,9", "etiket id'leri 1..9 sıralı");

  // ── paketleme ──
  const packed = await packMrVolume(kneeSeries());
  if (!packed) {
    failed++;
    console.error("FAIL paketleme döndü: null");
  } else {
    ok(packed.dims[0] === 14 && packed.dims[1] === 5 && packed.dims[2] === 6, "dims Z,Y,X doğru");
    ok(Math.abs(packed.spacing[0] - 3) < 1e-6 && Math.abs(packed.spacing[1] - 0.4) < 1e-6, "spacing dz,dy doğru");
    const raw = gunzipSync(packed.bytes);
    ok(raw.length === 14 * 5 * 6 * 2, "gzip açılınca int16 bayt sayısı doğru");
    // ilk piksel: değer kaba yuvarlanmış int16 LE
    const first = raw[0] | (raw[1] << 8);
    const origFirst = Math.round(kneeSeries().slices[0][0]);
    ok(first === (origFirst > 32767 ? 32767 : origFirst), "piksel değerleri int16 olarak serileştirilir");
  }
  ok((await packMrVolume(kneeSeries({ modality: "CT" }))) !== null, "paketleyici modalite denetlemez (uygunluk çağıranın işi); CT hacmi de paketlenir");

  // ── etiket bölme ──
  const masks = splitFixture();
  ok(masks.get(5)!.slices.get(0)![0] === 1 && masks.get(5)!.slices.get(1)![2] === 1, "menisküs vokselleri doğru kesit/pikselde");
  ok(masks.get(5)!.slices.get(2) === undefined, "voksel olmayan kesit maskede yok");
  ok(masks.get(9)!.slices.get(1)![7] === 1, "patella kemiği doğru konumda");
  ok((masks.get(1)?.slices.size ?? 0) === 0, "boş yapı boş kalır");
  ok([...masks.values()].every((m) => [...m.slices.values()].every((s) => s.every((px) => px === 0 || px === 1))), "maskeler binary");

  // ── hacim ölçümü ──
  const stats = volumeStatsFixture();
  const mm3 = 3 * 0.4 * 0.4;
  const mm = (n: number) => (n * mm3) / 1000;
  const med = stats.find((s) => s.id === 5)!;
  const fem = stats.find((s) => s.id === 7)!;
  ok(med.voxels === 100 && Math.abs(med.ml - mm(100)) < 1e-9, `menisküs 100 voksel → ${mm(100).toFixed(3)} mL`);
  ok(fem.voxels === 40 && fem.slices === 1, "femur 40 voksel / 1 kesit");
  ok(med.slices === 1 && stats.find((s) => s.id === 1)!.voxels === 0, "kıkırdağın hiç vokseli yok → 0");
  ok(stats.length === 9, "istatistik 9 yapı döner");

  // ── rapor satırı ──
  const reportStats = kneeVolumeStats(new Map(), [1, 1, 1]);
  const text = kneeSegSummaryText(reportStats, { elapsedMs: 61_200, model: "nnU-Net Knee MRI (test)" });
  ok(text.includes("araştırma amaçlı"), "rapor satırı araştırma etiketini taşır");
  ok(text.includes("yırtık"), "yırtık tanısı konmadığı yazılı");
  ok(text.includes("nnU-Net"), "model adı yazılı");
  ok(text.split("\n").length === 11, "başlık + 9 yapı + meta satırı = 11 satır");
}

main().then(() => {
  if (failed) { console.error(`${failed} diz segmentasyonu testi başarısız`); process.exit(1); }
  console.log("Tüm diz segmentasyonu (istemci) testleri geçti.");
}).catch((e) => { console.error(e); process.exit(1); });

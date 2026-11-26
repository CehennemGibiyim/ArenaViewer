/**
 * Gerçek PACS (Orthanc) ile lazy-pixel zinciri — yerel doğrulayıcı.
 *
 * Senaryo: minimal 2 kesitlik çalışma üretilir → **STOW sırası bilinçli olarak ters**
 * (önce z=+5, sonra z=-5) → QIDO-RS includefield ile listele → `qidoInstances`
 * (Adım 1 parse doğrulaması: rows/cols/instanceNumber/sliceLocation/pixelSpacing/thickness)
 * → `orderInstances` (z sırası) → `buildSeriesSkeleton` (sıfır Int16Array, sopUids hizası)
 * → her kesit için WADO-RS `wadoInstance` → baytlar `decodeUint16Samples` ile çözüm →
 * `fillSkeletonSlice` ile yerinde doldurma.
 *
 * Çalıştırma (CI pacs-e2e işi ya da yerel):
 *   ORTHANC_URL=http://localhost:8042 ORTHANC_USER=orthanc ORTHANC_PASS=orthanc \
 *     npx tsx tests/pacs-lazy.e2e.ts
 *
 * ORTHANC_URL tanımlı değilse test ATLANIR (CI dışı boş koşuda hata vermez).
 * Görüntüleyici (React) başlatılmaz; doğrulanan şey uygulama içe aktarma hattının
 * PACS tarafı ilkellerinin sözleşmesidir. Tarayıcı tarafı (Viewport/Workstation)
 * kapsam dışıdır.
 */
import { randomInt } from "node:crypto";
import { qidoInstances, stowInstance, wadoInstance } from "../src/lib/server/pacs";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";
import { groupInstancesBySeries, orderInstances, buildSeriesSkeleton, skeletonToSeriesData } from "../src/lib/lazySeries";
import { fillSkeletonSlice } from "../src/lib/lazyFill";
import { minimalDicom, decodeUint16Samples } from "./dicomFactory";
import { deleteStudyFromOrthanc } from "./orthancClient";

const BASE = (process.env.ORTHANC_URL ?? "").replace(/\/$/, "");
const USER = process.env.ORTHANC_USER ?? "orthanc";
const PASS = process.env.ORTHANC_PASS ?? "orthanc";

if (!BASE) {
  console.log("ATLANDI: ORTHANC_URL tanımlı değil — lazy-pixel PACS zinciri e2e çalıştırılmadı.");
  process.exit(0);
}

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const cfg = {
  ...DEFAULT_PACS,
  name: "Orthanc Lazy E2E",
  qidoRoot: `${BASE}/dicom-web`,
  wadoRoot: `${BASE}/dicom-web`,
  auth: { ...DEFAULT_PACS.auth, type: "basic" as const, username: USER, password: PASS },
};

async function main() {
  const root = "1.2.826.0.1.3680043.8.499";
  const patientId = `ARENA-LAZY-${Date.now()}`;
  const studyUid = `${root}.${randomInt(0, 1_000_000)}.${Date.now()}`;
  const seriesUid = `${root}.${randomInt(0, 1_000_000)}.${Date.now() + 1}`;
  const sopA = `${root}.${randomInt(0, 1_000_000)}.${Date.now() + 2}`; // z=+5, InstanceNumber 2
  const sopB = `${root}.${randomInt(0, 1_000_000)}.${Date.now() + 3}`; // z=-5, InstanceNumber 1
  const seedA = 100;
  const seedB = 200;
  const dcmA = minimalDicom({ patientId, patientName: "Lazy^E2E", studyUid, seriesUid, sopUid: sopA },
    { instanceNumber: 2, sliceLocation: 5, sliceThickness: 1.5, pixelSpacing: 0.75, pixelSeed: seedA });
  const dcmB = minimalDicom({ patientId, patientName: "Lazy^E2E", studyUid, seriesUid, sopUid: sopB },
    { instanceNumber: 1, sliceLocation: -5, sliceThickness: 1.5, pixelSpacing: 0.75, pixelSeed: seedB });

  try {
    // 1) STOW — bilinçli ters sıra (önce A=z+5, sonra B=z-5)
    const stA = await stowInstance(cfg, dcmA);
    ok(stA.ok && stA.stored === 1, "STOW: A (z=+5) kabul edildi");
    const stB = await stowInstance(cfg, dcmB);
    ok(stB.ok && stB.stored === 1, "STOW: B (z=-5) kabul edildi");

    // 2) QIDO includefield doğrulaması (Adım 1)
    const items = await qidoInstances(cfg, studyUid);
    const ours = items.filter((i) => i.seriesUid === seriesUid);
    ok(ours.length === 2, `QIDO: 2 örnek döndü (${ours.length})`);
    const ia = ours.find((i) => i.sopUid === sopA);
    const ib = ours.find((i) => i.sopUid === sopB);
    ok(!!ia && !!ib, "QIDO: iki SOP Instance UID de bulundu");
    if (ia && ib) {
      ok(ia.rows === 4 && ia.cols === 4 && ib.rows === 4 && ib.cols === 4, "QIDO: Rows/Columns includefield ile geldi (4×4)");
      ok(ia.instanceNumber === 2 && ib.instanceNumber === 1, "QIDO: InstanceNumber parse edildi (A=2, B=1)");
      ok(ia.sliceLocation === 5 && ib.sliceLocation === -5, "QIDO: IPP z → sliceLocation parse edildi (A=+5, B=-5)");
      ok(ia.sliceThickness === 1.5 && ib.sliceThickness === 1.5, "QIDO: SliceThickness parse edildi (1.5)");
      ok(ia.pixelSpacing === 0.75 && ib.pixelSpacing === 0.75, "QIDO: PixelSpacing (0028,0030) parse edildi (0.75)");
    }

    // 3) Sıralama + iskelet (Adım 1/2)
    const groups = groupInstancesBySeries(items);
    ok(groups.size === 1, "Gruplama: tek seri");
    const seriesItems = groups.get(seriesUid) ?? [];
    const ordered = orderInstances(seriesItems);
    ok(ordered.map((i) => i.sopUid).join(",") === [sopB, sopA].join(","), "Sıralama: z küçükten büyüğe (B→A), STOW sırası değil");
    const sk = buildSeriesSkeleton({
      instances: ordered, studyUid, modality: "CT", description: "lazy-e2e", pixelSpacing: 0.75,
    });
    ok(sk.slices.length === 2 && sk.sopUids.join(",") === [sopB, sopA].join(","), "İskelet: dilimler ve sopUids z sırasıyla hizalı");
    ok(sk.slices.every((s) => s instanceof Int16Array && s.length === 16 && s.every((v) => v === 0)), "İskelet: sıfır Int16Array tahsisli");
    ok(sk.slicePositions.join(",") === "-5,5" && sk.sliceThickness === 1.5, "İskelet: slicePositions [-5,5], kalınlık 1.5");
    ok(sk.allocatedBytes === 2 * 16 * 2, "İskelet: bayt muhasebesi (2 dilim × 32 px × 2 bayt)");
    const sd = skeletonToSeriesData(sk, { patientName: "Lazy^E2E" });
    ok(sd.lazyPending === 2 && sd.unit === "HU" && sd.width === 4 && sd.height === 4, "SeriesData: lazyPending=2, CT→HU, 4×4");

    // 4) WADO → decode → doldurma
    const wanted: Array<[string, number]> = [[sopB, seedB], [sopA, seedA]];
    for (const [sopUid, seed] of wanted) {
      const bytes = await wadoInstance(cfg, studyUid, seriesUid, sopUid);
      const samples = decodeUint16Samples(bytes);
      ok(samples.length === 16 && samples[0] === seed && samples[15] === seed + 15, `WADO: ${sopUid.slice(-4)} pikselleri beklenen desende (seed ${seed})`);
      const idx = sk.sopUids.indexOf(sopUid);
      const r = fillSkeletonSlice(sk.slices, idx, samples);
      ok(r === "replaced", `Doldurma: Uint16 kaynak slot değiştirildi (${r})`);
      const filled = sk.slices[idx];
      ok(filled[0] === seed && filled[15] === seed + 15, `Doldurma: dilim ${idx} değerleri WADO ile birebir`);
    }

    // 4b) Int16 yerinde-doldurma yolu: taze iskelet, Int16Array kaynaklar
    const sk2 = buildSeriesSkeleton({
      instances: ordered, studyUid, modality: "CT", description: "lazy-e2e-int16", pixelSpacing: 0.75,
    });
    const idBefore = sk2.slices.map((s) => s);
    for (const [sopUid, seed] of wanted) {
      const bytes = await wadoInstance(cfg, studyUid, seriesUid, sopUid);
      const samples = new Int16Array(decodeUint16Samples(bytes));
      const idx = sk2.sopUids.indexOf(sopUid);
      const r = fillSkeletonSlice(sk2.slices, idx, samples);
      ok(r === "int16", `Int16 yolu: yerinde .set() (${r})`);
      ok(sk2.slices[idx] === idBefore[idx], `Int16 yolu: dilim ${idx} dizi kimliği korundu`);
      ok(sk2.slices[idx][0] === seed, `Int16 yolu: dilim ${idx} değerleri doğru`);
    }

    // 4c) Uyumsuz boyut: hiçbir şey değişmemeli
    const sk3 = buildSeriesSkeleton({
      instances: ordered, studyUid, modality: "CT", description: "lazy-e2e-bad", pixelSpacing: 0.75,
    });
    const rBad = fillSkeletonSlice(sk3.slices, 0, new Int16Array(3));
    ok(rBad === "incompatible" && sk3.slices[0].every((v) => v === 0), "Uyumsuz boyut: dokunulmadı, sıfırlar korundu");
  } finally {
    const del = await deleteStudyFromOrthanc(BASE, USER, PASS, studyUid);
    if (del.remaining === 0 && del.deleted) console.log("Temizlik: çalışma silindi.");
    else { console.error(`Temizlik uyarısı: deleted=${del.deleted} remaining=${del.remaining}`); failed++; }
  }

  if (failed) { console.error(`${failed} lazy-pixel e2e adımı başarısız`); process.exit(1); }
  console.log("Tüm lazy-pixel PACS zinciri e2e adımları geçti.");
}

main().catch((e) => { console.error("Lazy e2e hatası:", e instanceof Error ? e.message : e); process.exit(1); });

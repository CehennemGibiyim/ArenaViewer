/** Füzyon katı hizalama (dönme + öteleme + ölçek) testleri — v-fusion. */
import type { SeriesData } from "../src/lib/types";
import { buildFusionLayer } from "../src/lib/fusion";
import {
  IDENTITY_RIGID, MIN_RIGID_SCORE, applyRigid, composeRigid, estimateRigid, isIdentityRigid,
  normalizeRigid, rigidKey, rigidNote, rigidSourceXY, rigidTrusted,
} from "../src/lib/fusionRigid";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── parametre sözleşmesi ──
ok(isIdentityRigid(IDENTITY_RIGID) && isIdentityRigid(null) && isIdentityRigid({ dx: 1e-9 }), "kimlik dönüşümü tanınır");
ok(!isIdentityRigid({ rotDeg: 2 }) && rigidKey(IDENTITY_RIGID) === "id", "kimlik olmayan ve önbellek anahtarı");
ok(rigidKey({ dx: 1.234, dy: -2, rotDeg: 3.456, scale: 1.0249 }).startsWith("1.23,-2.00,3.46"), "anahtar yuvarlar");
const clamped = normalizeRigid({ dx: 999, dy: -999, rotDeg: 300, scale: 5 });
ok(clamped.dx === 200 && clamped.dy === -200 && clamped.rotDeg === 45 && clamped.scale === 1.25, "kırpma sınırları");
ok(normalizeRigid({}).dx === 0 && normalizeRigid({ dx: Number.NaN }).dx === 0, "eksik/NaN → kimlik değeri");
ok(normalizeRigid({ dx: 5 }).rotDeg === 0 && normalizeRigid({ dx: 5 }).scale === 1, "kısmi nesne tamamlanır");

// ── ters dönüşüm ──
const w = 8, h = 8;
const mid = rigidSourceXY(4, 4, w, h, IDENTITY_RIGID);
ok(Math.abs(mid.sx - 4) < 1e-9 && Math.abs(mid.sy - 4) < 1e-9, "kimlikte koordinat korunur");
const shifted = rigidSourceXY(4 + 2, 4 - 3, w, h, normalizeRigid({ dx: 2, dy: -3 }));
ok(Math.abs(shifted.sx - 4) < 1e-9 && Math.abs(shifted.sy - 4) < 1e-9, "öteleme ters yönde örnekler");
const half = rigidSourceXY(4, 4, w, h, normalizeRigid({ rotDeg: 90 }));
ok(Math.abs(half.sx - 4) < 1e-9 && Math.abs(half.sy - 4) < 1e-9, "dönme merkezi sabittir");
const corner = rigidSourceXY(6, 4, w, h, normalizeRigid({ rotDeg: 30 }));
ok(Math.abs(corner.sx - (4 + 2 * Math.cos(Math.PI / 6))) < 1e-9 && Math.abs(corner.sy - (4 + 2 * Math.sin(Math.PI / 6))) < 1e-9, "30° dönmede dikey eksen yukarı kayar");
const zoom = rigidSourceXY(6, 4, w, h, normalizeRigid({ scale: 1.2 }));
ok(Math.abs(zoom.sx - (4 + 2 / 1.2)) < 1e-9, "ölçek merkezden uzaklaştırır (ters örnekleme)");

// ── uygulama ──
const W = 32, H = 32;
const disc = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) disc[y * W + x] = Math.hypot(x - 10, y - 12) < 5 ? 1 : 0;
const same = applyRigid(disc, W, H, IDENTITY_RIGID);
ok(same.length === disc.length && same[12 * W + 10] === 1 && same[0] === 0, "kimlikte piksel kopyalanır");
const moved = applyRigid(disc, W, H, normalizeRigid({ dx: 4, dy: 2 }));
ok(moved[(12 + 2) * W + (10 + 4)] > 0.8 && moved[12 * W + 20] < 0.5, "öteleme içeriği kaydırır");
const outside = applyRigid(disc, W, H, normalizeRigid({ dx: 30 }));
ok(Number.isNaN(outside[0]) && Number.isNaN(outside[16 * W + 16]), "görüntü dışı NaN (şeffaf)");
const rotated = applyRigid(disc, W, H, normalizeRigid({ rotDeg: 30 }));
ok(rotated.length === disc.length && rotated.every((v) => Number.isFinite(v) || Number.isNaN(v)), "dönme sonlu/NaN üretir");

// ── birleştirme ──
const comp = composeRigid(normalizeRigid({ dx: 2, dy: 0, rotDeg: 30 }), normalizeRigid({ dx: 1, dy: 0 }));
ok(Math.abs(comp.dx - (2 + Math.cos(Math.PI / 6))) < 1e-6 && Math.abs(comp.dy - Math.sin(Math.PI / 6)) < 1e-6 && Math.abs(comp.rotDeg - 30) < 1e-6, "birleştirme: A∘B ötelemesi döner");
const compScale = composeRigid(normalizeRigid({ scale: 1.2 }), normalizeRigid({ dx: 1, dy: 0 }));
ok(Math.abs(compScale.dx - 1.2) < 1e-6 && Math.abs(compScale.scale - 1.2) < 1e-6, "birleştirmede ölçek ötelemeyi çarpar");
const compId = composeRigid(IDENTITY_RIGID, IDENTITY_RIGID);
ok(isIdentityRigid(compId), "kimlikle birleştirme kimlik verir");

// ── kestirim: sentetik kaydırma ──
// Referans: 64×64 içinde iki farklı yarıçaplı disk (dönmeye duyarlı yapı).
const GW = 64, GH = 64;
const refImg = new Float32Array(GW * GH);
for (let y = 0; y < GH; y++) {
  for (let x = 0; x < GW; x++) {
    const d1 = Math.hypot(x - 26, y - 24), d2 = Math.hypot(x - 40, y - 38);
    refImg[y * GW + x] = Math.max(0, 1 - d1 / 9) + 0.8 * Math.max(0, 1 - d2 / 5);
  }
}
// mov = ref'in 5 px sağa, 3 px aşağı kaymış hâli (ters yönde örnekleyerek üretilir)
const movImg = applyRigid(refImg, GW, GH, normalizeRigid({ dx: -5, dy: -3 }));
const est = estimateRigid(refImg, movImg, GW, GH, { maxShift: 10, maxRotDeg: 6 });
ok(Math.abs(est.rigid.dx - 5) <= 1 && Math.abs(est.rigid.dy - 3) <= 1, `öteleme kestirimi (${est.rigid.dx.toFixed(1)}, ${est.rigid.dy.toFixed(1)} ≈ 5, 3)`);
ok(est.score > 0.95 && rigidTrusted(est), `kestirim skoru yüksek (NCC ${est.score.toFixed(3)})`);
ok(est.candidates > 10 && [1, 2, 4].includes(est.level), "aday sayısı ve kademe raporlanır");

// dönme kestirimi
const rotImg = applyRigid(refImg, GW, GH, normalizeRigid({ rotDeg: -8 })); // ters dönüşle üret
const estRot = estimateRigid(refImg, rotImg, GW, GH, { maxShift: 4, maxRotDeg: 10 });
ok(Math.abs(estRot.rigid.rotDeg - 8) <= 2, `dönme kestirimi (${estRot.rigid.rotDeg.toFixed(1)}° ≈ 8)`);
ok(estRot.score > 0.9, `dönme skoru yüksek (NCC ${estRot.score.toFixed(3)})`);

// kimlik girdide kimlik çıkar
const estId = estimateRigid(refImg, refImg, GW, GH, { maxShift: 6, maxRotDeg: 4 });
ok(Math.abs(estId.rigid.dx) <= 1 && Math.abs(estId.rigid.dy) <= 1 && Math.abs(estId.rigid.rotDeg) <= 1, "aynı görüntüde kimlik");
ok(Math.abs(estId.score - 1) < 1e-6, "aynı görüntüde NCC 1");

// bozuk girdi: NaN'li hareketli görüntü çökmez
const withNaN = Float32Array.from(movImg);
for (let i = 0; i < withNaN.length; i += 7) withNaN[i] = NaN;
const estNaN = estimateRigid(refImg, withNaN, GW, GH, { maxShift: 8 });
ok(Number.isFinite(estNaN.score) && estNaN.score >= 0, "NaN'li girdi güvenli skor üretir");
const tiny = estimateRigid(new Float32Array(4), new Float32Array(4), 2, 2);
ok(tiny.score === 0 && Number.isFinite(tiny.score), "çok küçük görüntüde skor 0 (anlamlı korelasyon yok)");

// ── güven eşiği ve not ──
ok(!rigidTrusted({ score: MIN_RIGID_SCORE - 0.01 }) && rigidTrusted({ score: MIN_RIGID_SCORE }), "güven eşiği");
const goodNote = rigidNote({ rigid: normalizeRigid({ dx: 2, dy: -1, rotDeg: 3 }), score: 0.8, level: 1, candidates: 42 });
ok(goodNote.includes("Katı hizalama") && goodNote.includes("42 aday") && goodNote.includes("görsel doğrulama"), "güvenilir not metni");
const badNote = rigidNote({ rigid: IDENTITY_RIGID, score: 0.1, level: 1, candidates: 5 });
ok(badNote.includes("güvenilmez") && badNote.includes("elle"), "güvenilmez not metni");
ok(!rigidNote({ rigid: IDENTITY_RIGID, score: Number.NaN, level: 1, candidates: 0 }).includes("Katı hizalama:"), "NaN skor güvenilmez sayılır");


// ── uçtan uca: buildFusionLayer katı hizalamayı uygular ──
function mkSeries(id: string, pixel: (x: number, y: number) => number, n = 2): SeriesData {
  const W8 = 8, H8 = 8;
  const slice = new Float32Array(W8 * H8);
  for (let y = 0; y < H8; y++) for (let x = 0; x < W8; x++) slice[y * W8 + x] = pixel(x, y);
  return {
    id, modality: "CT", description: id, bodyPart: "HEAD", patientName: "T", patientId: "1", patientAge: "40", patientSex: "E",
    studyDate: "", institution: "", studyUid: "1.2.3", width: W8, height: H8, pixelSpacing: 1, pixelSpacingX: 1,
    sliceThickness: 2, orientation: [1, 0, 0, 0, 1, 0], frameOfRef: "F1",
    ipp: Array.from({ length: n }, (_, i) => [0, 0, i * 2]),
    slices: Array.from({ length: n }, () => Float32Array.from(slice)),
    defaultWL: 0, defaultWW: 1, unit: "HU",
  } as SeriesData;
}
const tgt = mkSeries("t", () => 100);
const fus = mkSeries("f", (x, y) => (Math.hypot(x - 2, y - 3) < 1.2 ? 500 : 0));
const base = { series: fus, alpha: 1, cmap: "hot" as const, loPct: 10, hiPct: 100 };
const alignedPx = (layer: Uint32Array | null, x: number, y: number) => (layer ? (layer[y * 8 + x] >>> 24) > 0 : false);
const l0 = buildFusionLayer(tgt, 0, base);
ok(!!l0 && alignedPx(l0, 2, 3) && !alignedPx(l0, 4, 3), "hizalamasız katman kaynaktaki konumda");
const l1 = buildFusionLayer(tgt, 0, { ...base, rigid: normalizeRigid({ dx: 2 }) });
ok(!!l1 && alignedPx(l1, 4, 3) && !alignedPx(l1, 2, 3), "rijit dx=2 katmanı 2 piksel kaydırır");
const lId = buildFusionLayer(tgt, 0, { ...base, rigid: IDENTITY_RIGID });
ok(!!lId && alignedPx(lId, 2, 3), "kimlik dönüşümü katmanı değiştirmez");
ok(JSON.stringify([...(l0 ?? [])]) === JSON.stringify([...(lId ?? [])]), "kimlik rijit ile bayt-eşit katman (önbellek ayrı anahtar)");
const off = buildFusionLayer(tgt, 0, { ...base, rigid: normalizeRigid({ dx: 60 }) });
ok(!!off && !alignedPx(off, 2, 3) && !alignedPx(off, 6, 3), "görüntü dışına kayan katman boş kalır");

if (failed) { console.error(`${failed} füzyon hizalama testi başarısız`); process.exit(1); }
console.log("Tüm füzyon katı hizalama testleri geçti.");

/**
 * Douglas–Peucker sadeleştirme: RTSTRUCT kontur noktalarını azaltır, şekli korur.
 * Zincir: traceContours → mm'e çevir → simplifyClosedContour → contourPoints → buildRtStruct.
 */
import { douglasPeucker, simplifyClosedContour, type ContourPoint } from "../src/lib/contourSimplify";
import { buildRtStruct, contourPoints, sliceContourPoints, traceContours } from "../src/lib/dicomSeg";
import { makeSegmentDef, emptyMask, paint } from "../src/lib/segmentation";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const distToSeg = (p: ContourPoint, a: ContourPoint, b: ContourPoint): number => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
/** Kapalı halkanın kenarlarına en yakın mesafe. */
const distToRing = (p: ContourPoint, ring: ContourPoint[]): number => {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
};
const gridMask = (w: number, h: number, inside: (x: number, y: number) => boolean) => {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) m[y * w + x] = 1;
  return m;
};

// ── 1) Açık zincir ──
const line = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0 }));
ok(douglasPeucker(line, 0.5).length === 2, "düz çizgide uçlar kalır");
const zigzag = [{ x: 0, y: 0 }, { x: 1, y: 0.2 }, { x: 2, y: 0 }, { x: 3, y: 0.2 }, { x: 4, y: 0 }];
ok(douglasPeucker(zigzag, 0.5).length === 2, "ε içi titreşim elenir");
const spike = douglasPeucker([{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 4, y: 0 }], 0.5);
ok(spike.length === 3 && spike[1].y === 5, "ε üstündeki sapma korunur");
ok(douglasPeucker([{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 4, y: 0 }], 10).length === 2, "ε altına düşen sapma elenir");
const order = douglasPeucker([{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 2, y: 1 }, { x: 3, y: 3 }, { x: 4, y: 0 }], 0.4);
ok(order[0].x === 0 && order[order.length - 1].x === 4 && order.every((p, i) => i === 0 || p.x > order[i - 1].x), "sıra ve uçlar korunur");
ok(douglasPeucker([], 1).length === 0 && douglasPeucker([{ x: 1, y: 2 }], 1).length === 1, "boş/tekil zincir güvenli");

// ── 2) Kapalı halka: kare kenarındaki nokta yığını 4 köşeye iner ──
const square: ContourPoint[] = [];
for (let i = 0; i <= 20; i++) square.push({ x: i * 1, y: 0 });           // üst
for (let i = 1; i <= 20; i++) square.push({ x: 20, y: i });              // sağ
for (let i = 19; i >= 0; i--) square.push({ x: i, y: 20 });              // alt
for (let i = 19; i >= 1; i--) square.push({ x: 0, y: i });               // sol
const sq = simplifyClosedContour(square, 0.5);
ok(sq.length === 4, `20px kare kenarı 4 köşeye iner (${sq.length})`);
ok(sq[0].x !== sq[sq.length - 1].x || sq[0].y !== sq[sq.length - 1].y, "ilk nokta sonda tekrarlanmaz (CLOSED_PLANAR)");

// ── 3) Çember: silinen her nokta ε içinde kalır (DP garantisi) ──
const N = 64, R = 20, circle: ContourPoint[] = [];
for (let i = 0; i < N; i++) {
  const a = (2 * Math.PI * i) / N;
  circle.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
}
const EPS = 1.0;
const simp = simplifyClosedContour(circle, EPS);
ok(simp.length < N, `64 noktalı çember küçüldü (${simp.length})`);
ok(simp.length >= 3, "çember en az 3 nokta");
ok(circle.every((p) => distToRing(p, simp) <= EPS + 1e-9), "tüm elenen noktalar ε içinde");
// determinizm
const simp2 = simplifyClosedContour(circle, EPS);
ok(JSON.stringify(simp) === JSON.stringify(simp2), "sadeleştirme deterministik");

// ── 4) Minik/bozuk halkalar: DICOM 3 nokta altına düşmez ──
const onePx = simplifyClosedContour([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 0.5);
ok(onePx.length >= 3, "tek piksel halka 3 noktanın altına düşmez");
const vline = simplifyClosedContour([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }, { x: 0, y: 4 }], 0.5);
ok(vline.length >= 3, "tüm noktaları aynı x'te olan halka düşmez (y ucu ile bölünür)");
ok(simplifyClosedContour([], 1).length === 0, "boş halka boş döner");

// ── 5) contourPoints entegrasyonu: maske → mm → sadeleştirme ──
const geo = { pxMm: 1, pyMm: 1, dz: 1, origin: [0, 0, 0] as [number, number, number] };
const mask = gridMask(40, 40, (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25);
const rawCount = traceContours(mask, 40, 40)[0].length;
const simplified = contourPoints(traceContours(mask, 40, 40)[0], geo, 0, 200, 0.5);
ok(simplified.length / 3 >= 4 && simplified.length / 3 <= 10, `kare kontur 4–10 noktaya iner (${simplified.length / 3}, ham ${rawCount})`);
ok(simplified.length % 3 === 0, "x,y,z üçlüleri korunur");
const raw = contourPoints(traceContours(mask, 40, 40)[0], geo, 0, 4000, 0);
ok(raw.length / 3 === rawCount, `toleranceMm=0 sadeleştirmez (${raw.length / 3}/${rawCount})`);
const capped = contourPoints(traceContours(mask, 40, 40)[0], geo, 0, 8, 0);
ok(capped.length / 3 <= 8, `azami nokta emniyet supabı çalışır (≤8, ${capped.length / 3})`);

// ── 6) buildRtStruct: DP varsayılanı, DP'sizden daha küçük ──
const lMask = gridMask(30, 30, (x, y) => (x < 12 && y < 30) || (y >= 18 && x < 30));
const seg = emptyMask(30, 30);
for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) if ((x < 12 && y < 30) || (y >= 18 && x < 30)) seg.slices.set(0, Uint8Array.from(gridMask(30, 30, (x, y) => (x < 12 && y < 30) || (y >= 18 && x < 30))));
const src = { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1.1"] };
const base = {
  patientName: "Yılmaz^Ayşe", patientId: "TR-9", patientSex: "K", studyUid: "1.2.3.4", studyDate: "2026-11-20", institution: "TEST",
  source: src, geometry: { pxMm: 1, pyMm: 1, dz: 1, origin: [0, 0, 0] as [number, number, number] }, width: 30, height: 30,
  rois: [{ def: makeSegmentDef(1, "Nodül"), mask: seg }],
};
const withDp = buildRtStruct(base);
const withoutDp = buildRtStruct({ ...base, contourToleranceMm: 0 });
ok(withDp.length < withoutDp.length, `DP'siz belgeden daha küçük (${withDp.length} < ${withoutDp.length} bayt)`);
ok(withDp.length > 0 && Buffer.from(withDp.slice(128, 132)).toString("latin1") === "DICM", "RTSTRUCT imzası geçerli");
ok(Buffer.from(withDp).toString("latin1").includes("CLOSED_PLANAR"), "CLOSED_PLANAR yazıldı");

// ── 7) Küçük bileşenli dilimler: sadeleştirme sayacı bozmaz ──
const twoBlobs = gridMask(24, 12, (x, y) => (x < 8 && y < 6) || (x >= 14 && y >= 6));
const tri = sliceContourPoints(twoBlobs, 24, 12, { pxMm: 1, pyMm: 1, dz: 1, origin: [0, 0, 0] }, 0, 200);
ok(tri.length === 2 && tri.every((c) => c.length >= 9 && c.length % 3 === 0), "iki küçük kontur da geçerli (≥3 nokta)");

if (failed) { console.error(`${failed} Douglas–Peucker testi başarısız`); process.exit(1); }
console.log("Tüm Douglas–Peucker (kontur sadeleştirme) testleri geçti.");

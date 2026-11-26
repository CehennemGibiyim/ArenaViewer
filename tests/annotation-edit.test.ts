/**
 * Sürükleyerek anotasyon düzenleme testleri (m-basic).
 *
 * Sözleşme: tutamak tolerans içindeyse o nokta taşınır; gövdeye değilse tüm şekil
 * taşınır ve ROI istatistikleri geçersiz olduğu için düşürülür; hit-test en son
 * çizilen anotasyondan başlar; taşıma görüntü sınırlarına kırpılır.
 */
import {
  clampTranslate, hitAnnotation, insideAnnotation, movePoint, segmentDistance, translateAnnotation,
} from "../src/lib/annotationEdit";
import type { Annotation } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const ann = (o: Partial<Annotation> & { kind: Annotation["kind"]; points: { x: number; y: number }[] }): Annotation =>
  ({ id: o.id ?? "a", slice: o.slice ?? 0, ...o }) as Annotation;

// ── 1. geometri ──
ok(segmentDistance({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) === 5, "parçaya dik uzaklık");
ok(segmentDistance({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }) === 10, "parça dışında uç noktaya uzaklık");
ok(segmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }) === 5, "sıfır uzunluklu parça noktaya indirgenir");

const len = ann({ id: "L", kind: "length", points: [{ x: 10, y: 10 }, { x: 50, y: 10 }] });
ok(insideAnnotation(len, { x: 30, y: 12 }, 3), "uzunluk çizgisi tolerans içinde yakalanır");
ok(!insideAnnotation(len, { x: 30, y: 20 }, 3), "uzak nokta yakalanmaz");

const rect = ann({ id: "R", kind: "rect", points: [{ x: 0, y: 0 }, { x: 20, y: 10 }] });
ok(insideAnnotation(rect, { x: 10, y: 5 }, 0), "dikdörtgen içi");
ok(!insideAnnotation(rect, { x: 25, y: 5 }, 0), "dikdörtgen dışı");
ok(insideAnnotation(rect, { x: 21, y: 5 }, 2), "tolerans dikdörtgen sınırını genişletir");

const ell = ann({ id: "E", kind: "ellipse", points: [{ x: 0, y: 0 }, { x: 20, y: 10 }] });
ok(insideAnnotation(ell, { x: 10, y: 5 }, 0), "elips merkezi içinde");
ok(!insideAnnotation(ell, { x: 0, y: 0 }, 0), "elips köşesi (bounding box) dışında");
ok(!insideAnnotation(ell, { x: 0, y: 0 }, 1), "küçük tolerans elips köşesini içeri almaz");

const poly = ann({ id: "P", kind: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
ok(insideAnnotation(poly, { x: 10, y: 5 }, 1), "poligon kenarı yakalanır");
ok(!insideAnnotation(poly, { x: 0, y: 10 }, 1), "poligonun boş bölgesi yakalanmaz");

// ── 2. hit-test ──
const list = [
  ann({ id: "A", kind: "length", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }),
  ann({ id: "B", kind: "length", points: [{ x: 0, y: 30 }, { x: 40, y: 30 }] }),
];
const hB = hitAnnotation(list, { x: 40, y: 30 }, 3);
ok(hB?.kind === "handle" && hB.index === 1, "tutamaç yakalanır (B nokta 2)");
ok(JSON.stringify(hB) === JSON.stringify({ id: "B", kind: "handle", index: 1 }), "hit-test doğru anotasyonu döndürür");
const bodyB = hitAnnotation(list, { x: 20, y: 30 }, 3);
ok(bodyB?.kind === "body" && bodyB.id === "B", "gövde yakalanır");
ok(hitAnnotation(list, { x: 20, y: 15 }, 3) === null, "boşlukta hit yok");
const stacked = [
  ann({ id: "alt", kind: "length", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }),
  ann({ id: "üst", kind: "length", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }),
];
ok(hitAnnotation(stacked, { x: 5, y: 0 }, 2)?.id === "üst", "üst üste binmede en son çizilen kazanır");
ok(hitAnnotation([], { x: 0, y: 0 }, 3) === null, "boş listede hit yok");

// ── 3. taşıma ──
const m = movePoint(len, 1, { x: 60.44, y: 12.06 });
ok(m.points[1].x === 60.4 && m.points[1].y === 12.1, `tutamaç 0,1 mm'ye yuvarlanır (${m.points[1].x},${m.points[1].y})`);
ok(m.points[0].x === 10 && m.points[0].y === 10, "diğer nokta değişmez");
ok(movePoint(len, 5, { x: 1, y: 1 }) === len, "geçersiz tutamak indeksi anotasyonu değiştirmez");

const t = translateAnnotation(rect, 5, -3);
ok(t.points[0].x === 5 && t.points[0].y === -3 && t.points[1].x === 25 && t.points[1].y === 7, "tüm noktalar taşınır");
const withStats = { ...rect, stats: { mean: 42, std: 8, min: 10, max: 90, pixelCount: 100 } };
ok(translateAnnotation(withStats, 1, 1).stats === undefined, "taşımada ROI istatistiği düşürülür (bayat değer kalmaz)");
ok(translateAnnotation(len, 0, 0).points.length === 2, "sıfır taşıma noktaları korur");

// ── 4. sınır kırpma ──
const cl = clampTranslate(rect, -100, -100, 512, 512);
ok(cl.dx === 0 && cl.dy === 0, "sol/üst sınırdan dışarı taşmaz");
const cl2 = clampTranslate(rect, 1000, 1000, 512, 512);
ok(cl2.dx === 491 && cl2.dy === 501, `sağ/alt sınırda kırpılır (${cl2.dx},${cl2.dy})`);
ok(clampTranslate(rect, 5, 5, 512, 512).dx === 5, "sınır içindeki taşıma değişmez");
ok(clampTranslate(ann({ kind: "length", points: [] }), 5, 5, 100, 100).dx === 0, "noktasız anotasyonda taşıma yok");

if (failed) { console.error(`${failed} anotasyon düzenleme testi başarısız`); process.exit(1); }
console.log("Anotasyon düzenleme testleri geçti.");

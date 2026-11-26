/**
 * Ölçüm/anotasyon düzenleme geometrisi (m-basic).
 *
 * Amaç: çizilmiş bir uzunluk/açı/ROI'yi yeniden çizmek yerine **sürükleyerek**
 * düzenlemek: tutamak (nokta) sürükle → o nokta taşınır; gövde sürükle → tüm şekil
 * taşınır. Bu modül yalnız geometri/hit-test yapar; çizim ve durum yönetimi
 * görüntüleyicide (`Viewport`) kalır.
 *
 * Sınırlar:
 *  - Tolerans görüntü pikseli cinsindendir; çağıran taraf ekran pikselini ölçeğe
 *    bölerek verir (yakınlaştırmada tutamak büyüklüğü sabit kalır).
 *  - ROI istatistikleri (`stats`) taşımada **yeniden hesaplanmaz**: gövde taşındığında
 *    eski istatistik geçersizdir, bu yüzden `stats` düşürülür (uydurma değer bırakılmaz).
 */
import type { Annotation } from "./types";

export interface Pt {
  x: number;
  y: number;
}

export type HitResult =
  | { id: string; kind: "handle"; index: number }
  | { id: string; kind: "body" }
  | null;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Nokta → doğru parçası uzaklığı. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function polylineSegments(a: Annotation): [Pt, Pt][] {
  const p = a.points ?? [];
  const segs: [Pt, Pt][] = [];
  const closed = a.kind === "polygon" || a.kind === "rect";
  for (let i = 0; i + 1 < p.length; i++) segs.push([p[i], p[i + 1]]);
  if (closed && p.length >= 3) segs.push([p[p.length - 1], p[0]]);
  if (a.kind === "rect" && p.length === 2) {
    const [a1, b1] = p;
    const c2 = { x: b1.x, y: a1.y };
    const d2 = { x: a1.x, y: b1.y };
    return [[a1, c2], [c2, b1], [b1, d2], [d2, a1]];
  }
  return segs;
}

/** Nokta şeklin kenarına/gövdesine değiyor mu (toleransla)? */
export function insideAnnotation(a: Annotation, p: Pt, tol: number): boolean {
  const pts = a.points ?? [];
  if (pts.length === 0) return false;
  if (a.kind === "ellipse" || a.kind === "ellipsoid") {
    if (pts.length < 2) return dist(p, pts[0]) <= tol;
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    const rx = Math.abs(pts[1].x - pts[0].x) / 2 + tol;
    const ry = Math.abs(pts[1].y - pts[0].y) / 2 + tol;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (a.kind === "rect" && pts.length >= 2) {
    const x0 = Math.min(pts[0].x, pts[1].x) - tol, x1 = Math.max(pts[0].x, pts[1].x) + tol;
    const y0 = Math.min(pts[0].y, pts[1].y) - tol, y1 = Math.max(pts[0].y, pts[1].y) + tol;
    return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  }
  if (pts.length === 1) return dist(p, pts[0]) <= tol;
  return polylineSegments(a).some(([s, e]) => segmentDistance(p, s, e) <= tol);
}

/**
 * Sürükleme hedefini bulur: önce tutamaklar (en son çizilen anotasyon önce),
 * sonra gövde. Hiçbiri değilse null.
 */
export function hitAnnotation(annotations: Annotation[], p: Pt, tol: number): HitResult {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    for (let k = (a.points?.length ?? 0) - 1; k >= 0; k--) {
      if (dist(p, a.points[k]) <= tol) return { id: a.id, kind: "handle", index: k };
    }
  }
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (insideAnnotation(annotations[i], p, tol)) return { id: annotations[i].id, kind: "body" };
  }
  return null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Tek tutamağı taşır (diğer noktalar sabit). */
export function movePoint(a: Annotation, index: number, p: Pt): Annotation {
  if (index < 0 || index >= (a.points?.length ?? 0)) return a;
  const points = a.points.map((q, i) => (i === index ? { x: round1(p.x), y: round1(p.y) } : q));
  return { ...a, points, stats: a.stats };
}

/** Tüm şekli taşır; ROI istatistikleri geçersiz olduğu için düşürülür. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const points = (a.points ?? []).map((q) => ({ x: round1(q.x + dx), y: round1(q.y + dy) }));
  return { ...a, points, stats: undefined };
}

/** Taşımanın görüntü sınırları içinde kalması için kırpma (şekil dışarı taşmasın). */
export function clampTranslate(a: Annotation, dx: number, dy: number, width: number, height: number): { dx: number; dy: number } {
  const pts = a.points ?? [];
  if (pts.length === 0) return { dx: 0, dy: 0 };
  const minX = Math.min(...pts.map((q) => q.x));
  const maxX = Math.max(...pts.map((q) => q.x));
  const minY = Math.min(...pts.map((q) => q.y));
  const maxY = Math.max(...pts.map((q) => q.y));
  return {
    dx: Math.max(-minX, Math.min(width - 1 - maxX, dx)),
    dy: Math.max(-minY, Math.min(height - 1 - maxY, dy)),
  };
}

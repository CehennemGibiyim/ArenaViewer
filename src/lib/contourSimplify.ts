/**
 * Douglas–Peucker çoklu çizgi sadeleştirme — RTSTRUCT kontur noktalarının
 * azaltılması için. Moore komşuluk izi her sınır pikseli için nokta üretir;
 * düz kenarlardaki aşama (staircase) noktaları konturun geometrisine ait
 * bilgi taşımaz. ε toleransından sapan noktalar atılır.
 *
 * Kapalı konturlarda (DICOM CLOSED_PLANAR) x ucundaki (yoksa y) nokta çifti
 * konturu iki yaya böler; her yay bağımsız sadeleştirilir. Uç noktalar korunur,
 * ilk nokta sonda tekrarlanmaz.
 */
export interface ContourPoint { x: number; y: number }

function perpDistance(p: ContourPoint, a: ContourPoint, b: ContourPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(len2);
}

/** Açık çoklu çizgiyi ε ile sadeleştirir; uç noktalar korunur. */
export function douglasPeucker(points: ContourPoint[], epsilon: number): ContourPoint[] {
  if (points.length < 3 || epsilon <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistance(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxI >= 0 && maxD > epsilon) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out: ContourPoint[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Kapalı konturu sadeleştirir. Çıktı 3 noktanın altına düşerse sadeleştirme
 * iptal edilir — DICOM konturu en az 3 nokta ister, bozuk belge yazmaktansa
 * nokta fazlalığı tercih edilir.
 */
export function simplifyClosedContour(points: ContourPoint[], epsilon: number): ContourPoint[] {
  const n = points.length;
  if (n < 4 || epsilon <= 0) return points.slice();

  // Uç nokta çifti: önce x ucu; tümü aynı x'teyse y ucu (dikey çizgi konturu).
  let li = 0, ri = 0;
  for (let i = 1; i < n; i++) {
    if (points[i].x < points[li].x) li = i;
    if (points[i].x > points[ri].x) ri = i;
  }
  if (points[li].x === points[ri].x) {
    li = 0;
    ri = 0;
    for (let i = 1; i < n; i++) {
      if (points[i].y < points[li].y) li = i;
      if (points[i].y > points[ri].y) ri = i;
    }
  }
  if (li === ri) return points.slice();
  const a = Math.min(li, ri), b = Math.max(li, ri);
  const chainA = points.slice(a, b + 1);
  const chainB = [...points.slice(b), ...points.slice(0, a + 1)];

  const simpA = douglasPeucker(chainA, epsilon);
  const simpB = douglasPeucker(chainB, epsilon);
  // simpB'nin başı pts[b] (simpA'nın sonu), sonu pts[a] (simpA'nın başı) — ikisini de at
  const merged = [...simpA, ...simpB.slice(1, -1)];
  // sayısal uç tekrarlarını at
  const out: ContourPoint[] = [];
  for (const p of merged) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out.length >= 3 ? out : points.slice();
}

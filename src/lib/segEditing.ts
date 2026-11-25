/**
 * Segmentasyon düzenleme yardımcıları — c-seg-rtstruct.
 *
 * Mevcut durum: `segmentation.ts` fırça/silgi/eşik/tohum büyütme ve hacim
 * hesaplar; `dicomSeg.ts` SEG/RTSTRUCT yazar, `maskContour` satır taramasıyla
 * **dış zarf** yaklaşımını kullanır. Bu modül aradaki iki açığı kapatır:
 *
 *  1. **Kontur izleme (marching squares)**: maskenin gerçek sınırını, piksel
 *     köşelerindeki yarım-adım ara değerlerle izler → konkav segmentler ve
 *     delikli şekiller dış zarfa dönüşmez. Birden çok kapalı halka (delik/ada)
 *     ayrı kontur olarak döner.
 *  2. **Kontur düzeltme**: halka yumuşatma (Chaikin), ardışık yinelenen
 *     noktaların temizlenmesi, nokta seyreltme ve mm² alan (düzeltme sonrası
 *     alanın orijinale göre sapması raporlanır).
 *
 * Ayrıca kesitler arası morfolojik tutarlılık (tek kesitlik "adacık" temizliği)
 * ve segment birleştirme/bölme yardımcıları vardır. Klinik karar aracı değildir;
 * hekim düzeltmesine tabidir.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Mask2D {
  width: number;
  height: number;
  /** 1 = segment içinde */
  data: Uint8Array;
}

/** Maskeyi güvenli biçimde kurar (boyut uyuşmazlığında hata). */
export function makeMask(width: number, height: number, data?: Uint8Array): Mask2D {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Maske boyutu geçersiz");
  }
  const expected = width * height;
  if (data && data.length !== expected) throw new Error(`Maske verisi ${expected} bayt olmalı (gelen ${data.length})`);
  return { width, height, data: data ?? new Uint8Array(expected) };
}

export const maskGet = (m: Mask2D, x: number, y: number): 0 | 1 =>
  x < 0 || y < 0 || x >= m.width || y >= m.height ? 0 : (m.data[y * m.width + x] ? 1 : 0);

/** Piksel sayısı (alan, piksel). */
export function pixelCount(m: Mask2D): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++;
  return n;
}

/** Fiziksel alan (mm²). */
export function areaMm2(m: Mask2D, pxMm: number, pyMm: number): number {
  return Math.round(pixelCount(m) * pxMm * pyMm * 100) / 100;
}

/** Halkaların yönü (shoelace): +1 saat yönü tersi, −1 saat yönü. */
export function ringOrientation(ring: Pt[]): 1 | -1 {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a >= 0 ? 1 : -1;
}

/** Kapalı halkanın işaretli alanı (piksel², mutlak). */
export function ringAreaPx(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Maskenin sınır halkalarını izler (kenar takibi).
 *
 * Her dolu piksel, komşusu boş olan kenarlarını **birim kare** olarak verir;
 * iki dolu piksel arasındaki kenarlar birbirini götürür. Böylece halkanın
 * kapalı alanı tam olarak piksel sayısına eşit olur (satır taraması dış zarfının
 * aksine konkav bölgeler ve delikler korunur).
 *
 * Dönen koordinatlar piksel köşeleridir (0..W, 0..H). Dış halkalar saat yönü
 * tersi (+1), delikler saat yönünde (−1) döner. Çapraz temas eden piksellerde
 * (belirsiz durum) her iki halka da kapalı kalır; klinik kullanımda fırça izi
 * bu durumu nadiren üretir ve `removeIslands` temizler.
 *
 * `simplifyTolerance` (piksel) Douglas-Peucker sadeleştirme eşiği; 0 → kapalı.
 */
export function traceContours(m: Mask2D, simplifyTolerance = 0.75): { ring: Pt[]; orientation: 1 | -1; hole: boolean }[] {
  const W = m.width, H = m.height;
  const key = (p: Pt) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  /** Başlangıç noktası → bitiş noktaları (çapraz temasta birden fazla olabilir). */
  const out = new Map<string, Pt[]>();
  const startPt = new Map<string, Pt>();
  const push = (a: Pt, b: Pt) => {
    const k = key(a);
    const arr = out.get(k) ?? [];
    arr.push(b);
    out.set(k, arr);
    startPt.set(k, a);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m.data[y * W + x]) continue;
      // Saat yönü tersi yürüyüş: üst → sağ → alt → sol.
      if (!maskGet(m, x, y - 1)) push({ x, y }, { x: x + 1, y });
      if (!maskGet(m, x + 1, y)) push({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!maskGet(m, x, y + 1)) push({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!maskGet(m, x - 1, y)) push({ x, y: y + 1 }, { x, y });
    }
  }

  const rings: Pt[][] = [];
  for (const k0 of [...out.keys()]) {
    while ((out.get(k0) ?? []).length > 0) {
      const ring: Pt[] = [];
      const startNode = startPt.get(k0)!;
      let cur: Pt = startNode;
      let guard = 0;
      const maxSteps = W * H * 4 + 8;
      while (guard++ < maxSteps) {
        const k = key(cur);
        const nexts = out.get(k);
        if (!nexts || nexts.length === 0) break;
        const nxt = nexts.shift()!;
        ring.push(cur);
        cur = nxt;
        if (key(cur) === key(startNode)) break;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }

  const traced = rings
    .map((ring) => {
      const simplified = simplifyTolerance > 0 ? simplifyRing(ring, simplifyTolerance) : dedupeRing(ring);
      const orientation = ringOrientation(simplified);
      return { ring: simplified, orientation, hole: orientation === -1 };
    })
    .filter((r) => r.ring.length >= 4);
  // Hiç dış halka yoksa yön işaretine güvenmeyiz: tek halka "gövde" sayılır.
  const hasOuter = traced.some((r) => !r.hole);
  return hasOuter ? traced : traced.map((r) => ({ ...r, hole: false }));
}

/** kapalı halkada ardışık yinelenenleri atar. */
export function dedupeRing(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) out.pop();
  }
  return out;
}

/** Douglas-Peucker sadeleştirme (kapalı halka). */
export function simplifyRing(ring: Pt[], tolerance: number): Pt[] {
  const pts = dedupeRing(ring);
  if (pts.length <= 4 || tolerance <= 0) return pts;
  const distToSeg = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  // Kapalı halkayı iki yay olarak sadeleştir (başlangıç noktası sabit).
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[Math.floor(pts.length / 2)] = 1;
  const stack: [number, number][] = [[0, Math.floor(pts.length / 2)], [Math.floor(pts.length / 2), pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j - i < 2) continue;
    let maxD = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distToSeg(pts[k], pts[i], pts[j]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : pts;
}

/** Chaikin köşe kesme (yumuşatma); `iterations` arttıkça köşeler yuvarlanır. */
export function chaikin(ring: Pt[], iterations = 1): Pt[] {
  let cur = dedupeRing(ring);
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const out: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i], q = cur[(i + 1) % cur.length];
      out.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
      out.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
    }
    cur = out;
  }
  return cur;
}

export interface SmoothReport {
  ring: Pt[];
  pointsBefore: number;
  pointsAfter: number;
  areaBeforePx2: number;
  areaAfterPx2: number;
  /** Alan değişimi (mutlak yüzde) */
  areaDriftPct: number;
  /** %5'ten fazla sapma → uyarı */
  warning: string | null;
}

/**
 * Kontur düzeltme: seyreltme + Chaikin yumuşatma. Alan sapması %5'i aşarsa
 * **uyarı** döner (sessizce kabul edilmez) — düzeltme segmentasyonu bozmuş olabilir.
 */
export function smoothRing(ring: Pt[], opts: { tolerance?: number; iterations?: number; maxDriftPct?: number } = {}): SmoothReport {
  const before = dedupeRing(ring);
  const areaBefore = ringAreaPx(before);
  let next = opts.tolerance !== undefined && opts.tolerance > 0 ? simplifyRing(before, opts.tolerance) : before;
  if (opts.iterations && opts.iterations > 0) next = chaikin(next, opts.iterations);
  const areaAfter = ringAreaPx(next);
  const drift = areaBefore > 0 ? Math.abs(areaAfter - areaBefore) / areaBefore : 0;
  const maxDrift = opts.maxDriftPct ?? 0.05;
  return {
    ring: next,
    pointsBefore: before.length,
    pointsAfter: next.length,
    areaBeforePx2: Math.round(areaBefore * 100) / 100,
    areaAfterPx2: Math.round(areaAfter * 100) / 100,
    areaDriftPct: Math.round(drift * 1000) / 1000,
    warning: drift > maxDrift ? `Alan sapması %${Math.round(drift * 100)} (eşik %${Math.round(maxDrift * 100)}); düzeltmeyi gözden geçirin.` : null,
  };
}

/** Konturu mm'ye çevirir (piksel merkezi → mm). */
export function ringToMm(ring: Pt[], pxMm: number, pyMm: number): Pt[] {
  return ring.map((p) => ({ x: Math.round(p.x * pxMm * 1000) / 1000, y: Math.round(p.y * pyMm * 1000) / 1000 }));
}

// ─────────────── Kesitler arası tutarlılık ───────────────

/**
 * Tek kesitlik adacıkları siler: bir maskenin yalnız `minNeighbors` komşu
 * kesitte karşılığı yoksa gürültüdür. `slices` kesit sırasına göre maskelerdir.
 */
export function removeIslands(slices: Mask2D[], minNeighbors = 1): { slices: Mask2D[]; removed: number[] } {
  const removed: number[] = [];
  const out = slices.map((s) => ({ ...s, data: new Uint8Array(s.data) }));
  for (let i = 0; i < out.length; i++) {
    if (pixelCount(out[i]) === 0) continue;
    let neighbors = 0;
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < out.length && pixelCount(out[j]) > 0) neighbors++;
    }
    if (neighbors < minNeighbors) {
      out[i].data.fill(0);
      removed.push(i);
    }
  }
  return { slices: out, removed };
}

/** İki maskenin Dice katsayısı (0–1); boş/boş → null. */
export function dice(a: Mask2D, b: Mask2D): number | null {
  if (a.data.length !== b.data.length) throw new Error("Maskeler aynı boyutta olmalı");
  let both = 0, sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const av = a.data[i] ? 1 : 0, bv = b.data[i] ? 1 : 0;
    if (av && bv) both++;
    sum += av + bv;
  }
  if (sum === 0) return null;
  return Math.round((2 * both) / sum * 1000) / 1000;
}

/** Segmentleri birleştirir (union) / çıkarır (difference). */
export function combineMasks(a: Mask2D, b: Mask2D, op: "union" | "difference" | "intersect"): Mask2D {
  if (a.data.length !== b.data.length) throw new Error("Maskeler aynı boyutta olmalı");
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i++) {
    const av = !!a.data[i], bv = !!b.data[i];
    data[i] = op === "union" ? (av || bv ? 1 : 0) : op === "intersect" ? (av && bv ? 1 : 0) : av && !bv ? 1 : 0;
  }
  return { width: a.width, height: a.height, data };
}

/** Hacim (mL): kesit kalınlığı × toplam piksel × piksel alanı. */
export function volumeMl(slices: Mask2D[], pxMm: number, pyMm: number, dzMm: number): number {
  let px = 0;
  for (const s of slices) px += pixelCount(s);
  return Math.round(px * pxMm * pyMm * dzMm / 1000 * 100) / 100;
}

/** Düzeltme raporu (kullanıcıya gösterilir). */
export function editSummary(slices: Mask2D[], removed: number[], smoothed: SmoothReport[]): string {
  const warns = smoothed.filter((s) => s.warning).map((s) => s.warning as string);
  return [
    `Kesit: ${slices.length} · tek kesitlik adacık silindi: ${removed.length ? removed.map((i) => i + 1).join(", ") : "yok"}`,
    `Kontur düzeltmesi: ${smoothed.length} halka (nokta ${smoothed.reduce((n, s) => n + s.pointsBefore, 0)} → ${smoothed.reduce((n, s) => n + s.pointsAfter, 0)})`,
    ...warns.map((w) => `⚠ ${w}`),
    "Konturlar düzlemsel kapalı eğridir; hekim düzeltmesine tabidir.",
  ].join("\n");
}

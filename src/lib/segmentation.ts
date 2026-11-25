/**
 * Segmentasyon editörü çekirdeği (c-seg-rtstruct).
 *
 * Klinik yazılımlarda maske düzenleme (fırça/silgi) ve hacim hesabı buradadır.
 * Maskeler kesit başına 0/1 bayt dizisidir (width×height); dışa aktarım
 * `dicomSeg.ts` (DICOM SEG) ve `rtstruct.ts` (RTSTRUCT) ile yapılır.
 *
 * ÖNEMLİ: Üretilen maskeler hekim düzenlemesine açıktır; motor çıktısı yalnızca
 * başlangıç önerisidir. Hacim, piksel aralığından hesaplanır ve raporda
 * "hekim onayına tabidir" notuyla görünür.
 */

export interface SegMask {
  /** Kesit indeksi → binary maske (1 = segment) */
  slices: Map<number, Uint8Array>;
  width: number;
  height: number;
}

export const SEG_LABEL_MAX = 64;

export function emptyMask(width: number, height: number): SegMask {
  return { slices: new Map(), width, height };
}

/** Maske pikselini güvenli biçimde okur. */
export function getPixel(m: SegMask, slice: number, x: number, y: number): 0 | 1 {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return 0;
  const s = m.slices.get(slice);
  return s && s[y * m.width + x] ? 1 : 0;
}

/**
 * Dairesel fırça: yarıçap `r` piksel, `erase` ise siler.
 * Maske yoksa oluşturulur (yeni katman gibi davranır).
 */
export function paint(m: SegMask, slice: number, cx: number, cy: number, r: number, erase = false): void {
  if (r <= 0) return;
  let s = m.slices.get(slice);
  if (!s) {
    if (erase) return;
    s = new Uint8Array(m.width * m.height);
    m.slices.set(slice, s);
  }
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(m.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(m.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) s[y * m.width + x] = erase ? 0 : 1;
    }
  }
}

/**
 * Eşik tabanlı dolgu: verilen HU aralığındaki pikselleri maske içine alır
 * (yalnızca `region` içindeki pikseller; bölge verilmezse tüm görüntü).
 * `grow` bölgesi tohum noktasından bağlantılı bileşen (flood fill) olarak büyür.
 */
export function thresholdFill(
  m: SegMask, slice: number, hu: ArrayLike<number>,
  lo: number, hi: number,
  region?: { x: number; y: number; w: number; h: number },
): number {
  let s = m.slices.get(slice);
  if (!s) { s = new Uint8Array(m.width * m.height); m.slices.set(slice, s); }
  const x0 = Math.max(0, region?.x ?? 0), y0 = Math.max(0, region?.y ?? 0);
  const x1 = Math.min(m.width - 1, (region ? region.x + region.w : m.width) - 1);
  const y1 = Math.min(m.height - 1, (region ? region.y + region.h : m.height) - 1);
  let added = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = hu[y * m.width + x];
      if (v >= lo && v <= hi) { s[y * m.width + x] = 1; added++; }
    }
  }
  return added;
}

/** Tohum noktasından bağlantılı bölge büyütme (4-komşuluk). */
export function growRegion(m: SegMask, slice: number, hu: ArrayLike<number>, seed: { x: number; y: number }, lo: number, hi: number): number {
  const inRange = (x: number, y: number) => {
    const v = hu[y * m.width + x];
    return v >= lo && v <= hi;
  };
  if (seed.x < 0 || seed.y < 0 || seed.x >= m.width || seed.y >= m.height || !inRange(seed.x, seed.y)) return 0;
  let s = m.slices.get(slice);
  if (!s) { s = new Uint8Array(m.width * m.height); m.slices.set(slice, s); }
  const stack: number[] = [seed.y * m.width + seed.x];
  let added = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (s[p]) continue;
    const x = p % m.width, y = (p - x) / m.width;
    if (!inRange(x, y)) continue;
    s[p] = 1; added++;
    if (x > 0) stack.push(p - 1);
    if (x < m.width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - m.width);
    if (y < m.height - 1) stack.push(p + m.width);
  }
  return added;
}

/** Kesitler arası kopyalama (açısal düzeltme yok; aynı koordinat). */
export function copySlice(m: SegMask, from: number, to: number): boolean {
  const s = m.slices.get(from);
  if (!s) return false;
  m.slices.set(to, Uint8Array.from(s));
  return true;
}

/** Maskeyi temizler (boş kesitler haritadan çıkarılır). */
export function prune(m: SegMask): void {
  for (const [i, s] of [...m.slices]) if (!s.some((v) => v)) m.slices.delete(i);
}

/**
 * İki maskeyi birleştirir (elle çizilen + işaretlerden üretilen). Sonuç yeni
 * bir maskedir; girdiler değişmez. Boyut uyuşmazsa `null` döner (sessiz
 * bozulma yerine açık hata).
 */
export function unionMasks(a: SegMask, b: SegMask): SegMask | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const out = emptyMask(a.width, a.height);
  for (const src of [a, b]) {
    for (const [idx, bytes] of src.slices) {
      let dst = out.slices.get(idx);
      if (!dst) { dst = new Uint8Array(bytes.length); out.slices.set(idx, dst); }
      for (let i = 0; i < bytes.length; i++) if (bytes[i]) dst[i] = 1;
    }
  }
  return out;
}

/** Maskedeki toplam işaretli piksel sayısı (hacim öncesi hızlı özet). */
export function maskPixelCount(m: SegMask): number {
  let n = 0;
  for (const s of m.slices.values()) for (let i = 0; i < s.length; i++) if (s[i]) n++;
  return n;
}

export interface VolumeResult {
  /** Segment hacmi (mm³) */
  mm3: number;
  /** mL */
  ml: number;
  voxelCount: number;
  /** Maske bulunan kesit aralığı [ilk, son] */
  sliceRange: [number, number] | null;
  /** Kesit başına piksel sayısı (profili) */
  perSlice: { slice: number; pixels: number; mm3: number }[];
}

/**
 * Hacim: Σ (piksel × pixelSpacingX × pixelSpacingY × kesit kalınlığı).
 * Kesitler arası boşluk (sliceSpacing) verilirse o kullanılır.
 */
export function volume(m: SegMask, spacing: { px: number; py?: number; sliceThickness: number; sliceSpacing?: number }): VolumeResult {
  const px = spacing.px > 0 ? spacing.px : 1;
  const py = spacing.py && spacing.py > 0 ? spacing.py : px;
  const dz = spacing.sliceSpacing && spacing.sliceSpacing > 0 ? spacing.sliceSpacing : spacing.sliceThickness > 0 ? spacing.sliceThickness : 1;
  const areaMm2 = px * py;
  const perSlice: VolumeResult["perSlice"] = [];
  let voxelCount = 0;
  const idx = [...m.slices.keys()].sort((a, b) => a - b);
  for (const i of idx) {
    const s = m.slices.get(i)!;
    let n = 0;
    for (let k = 0; k < s.length; k++) if (s[k]) n++;
    if (!n) continue;
    voxelCount += n;
    perSlice.push({ slice: i, pixels: n, mm3: n * areaMm2 * dz });
  }
  const mm3 = voxelCount * areaMm2 * dz;
  return {
    mm3,
    ml: mm3 / 1000,
    voxelCount,
    sliceRange: perSlice.length ? [perSlice[0].slice, perSlice[perSlice.length - 1].slice] : null,
    perSlice,
  };
}

/** Maskeyi çalışma durumuna yazılabilir JSON'a çevirir (base64, kesit başına). */
export function maskToJson(m: SegMask): { width: number; height: number; slices: { slice: number; data: string }[] } {
  const enc = (b: Uint8Array) => {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
  };
  return { width: m.width, height: m.height, slices: [...m.slices.entries()].sort((a, b) => a[0] - b[0]).map(([slice, d]) => ({ slice, data: enc(d) })) };
}

/** `maskToJson` çıktısını geri okur (bozuk veri → boş maske). */
export function maskFromJson(j: { width?: number; height?: number; slices?: { slice?: number; data?: string }[] }): SegMask {
  const width = Math.max(1, Number(j?.width) || 1), height = Math.max(1, Number(j?.height) || 1);
  const m = emptyMask(width, height);
  for (const s of j?.slices ?? []) {
    if (!Number.isInteger(s.slice) || !s.data) continue;
    let bin: Uint8Array;
    try {
      const raw = typeof atob === "function" ? atob(s.data) : Buffer.from(s.data, "base64").toString("binary");
      bin = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    } catch { continue; }
    if (bin.length !== width * height) continue;
    m.slices.set(s.slice as number, bin);
  }
  return m;
}

/** Segment tanımı (SEG/RTSTRUCT başlığı ve rapor). */
export interface SegmentDef {
  segmentNumber: number;
  label: string;
  /** Anahtar renk [r,g,b] 0–255 */
  color: [number, number, number];
  algorithmType: "MANUAL" | "SEMIAUTOMATIC" | "AUTOMATIC";
  /** Kaynak (ör. "hekim fırça" / "AI aday maskesi") */
  algorithmName?: string;
}

export const DEFAULT_SEGMENT_COLORS: [number, number, number][] = [
  [255, 59, 48], [52, 199, 89], [0, 122, 255], [255, 204, 0], [175, 82, 222], [90, 200, 250],
];

export function makeSegmentDef(n: number, label: string, algorithmType: SegmentDef["algorithmType"] = "MANUAL"): SegmentDef {
  return {
    segmentNumber: n,
    label: label.slice(0, SEG_LABEL_MAX),
    color: DEFAULT_SEGMENT_COLORS[(n - 1) % DEFAULT_SEGMENT_COLORS.length],
    algorithmType,
  };
}

/** Rapor satırı: hacim + kesit aralığı + segment sayısı. */
export function segmentSummary(label: string, v: VolumeResult): string {
  const r = v.sliceRange ? `kesit ${v.sliceRange[0] + 1}–${v.sliceRange[1] + 1}` : "boş";
  return `${label}: ${v.ml.toFixed(2)} mL (${v.voxelCount} voksel, ${r})`;
}

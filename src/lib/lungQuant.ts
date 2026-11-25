/**
 * Akciğer kantitasyonu (kural/istogram tabanlı): LAA-950, ortalama HU,
 * 15. persentil yoğunluk (PD15) ve hacim.
 *
 * SINIRLILIK: Girdi bir **histogramdur** (kesit piksel dağılımı); lob segmentasyonu
 * yapılmaz ve yağ/doku sınırları hekim/segmentasyona göredir. Sonuçlar araştırma
 * çıktısı niteliğindedir, KOAH tanı/tedavi kararı DSBG (solunum fonksiyon testi)
 * ve klinik bütünlükle verilir.
 */

export interface HuBin {
  /** Küme sınırı (dahil) — HU */
  lo: number;
  hi: number;
  count: number;
}

export interface LungQuantResult {
  totalVoxels: number;
  volumeMl: number | null;
  laa950Pct: number;
  meanHu: number;
  /** 15. persentil HU (PD15) — histogramdan yaklaşık */
  pd15Hu: number | null;
  category: string;
  advice: string;
}

/** Voxel başına hacim (mm³) verilirse toplam hacmi mL olarak üretir. */
export function lungQuant(bins: HuBin[], voxelVolumeMm3: number | null = null): LungQuantResult {
  const valid = bins.filter((b) => Number.isFinite(b.count) && b.count > 0 && b.hi >= b.lo);
  const total = valid.reduce((n, b) => n + b.count, 0);
  if (total === 0) {
    return {
      totalVoxels: 0, volumeMl: null, laa950Pct: 0, meanHu: 0, pd15Hu: null,
      category: "—", advice: "Histogram boş; ölçüm yapılamadı.",
    };
  }

  let sumHu = 0;
  let low950 = 0;
  for (const b of valid) {
    const mid = (b.lo + b.hi) / 2;
    sumHu += mid * b.count;
    // Bin tamamen −950 altındaysa tam sayılır; kesişen bin kısmi sayılır.
    if (b.hi <= -950) low950 += b.count;
    else if (b.lo < -950) low950 += b.count * ((-950 - b.lo) / Math.max(1e-9, b.hi - b.lo));
  }
  const meanHu = sumHu / total;
  const laa950Pct = (low950 / total) * 100;

  // PD15: kümülatif dağılımdan %15'lik dilim
  const pd15 = percentileHu(bins, 15);

  let category: string;
  let advice: string;
  if (laa950Pct < 5) { category = "normal–hafif"; advice = "LAA-950 <%5: expiratuar hipodansite oranı normal–hafif sınırda."; }
  else if (laa950Pct < 10) { category = "hafif"; advice = "LAA-950 %5–10: hafif emfizem bezginliği; klinik korelasyon (DSBG, semptom) önerilir."; }
  else if (laa950Pct < 20) { category = "orta"; advice = "LAA-950 %10–20: orta düzey bezginlik; sigara bırakma, DSBG ve takip önerilir."; }
  else { category = "ağır"; advice = "LAA-950 ≥%20: belirgin bezginlik; DSBG, oksijen satürasyonu ve bronkodilatör tedavisi değerlendirmesi önerilir."; }

  return {
    totalVoxels: total,
    volumeMl: voxelVolumeMm3 ? (total * voxelVolumeMm3) / 1000 : null,
    laa950Pct, meanHu, pd15Hu: pd15,
    category, advice,
  };
}

/**
 * Kümülatif histogramdan yüzdelik HU (ör. %15 → PD15).
 * Kural: kümülatif toplam hedefi **ilk aşan** kümenin orta değeri döner (enterpolasyon yok).
 * Boş histogramda null.
 */
export function percentileHu(bins: HuBin[], pct: number): number | null {
  const valid = bins.filter((b) => Number.isFinite(b.count) && b.count > 0 && b.hi >= b.lo);
  const total = valid.reduce((n, b) => n + b.count, 0);
  if (total === 0 || !Number.isFinite(pct)) return null;
  const target = total * Math.min(100, Math.max(0, pct)) / 100;
  let acc = 0;
  for (const b of [...valid].sort((a, z) => a.lo - z.lo)) {
    acc += b.count;
    if (acc >= target) return (b.lo + b.hi) / 2;
  }
  return null;
}

/** Kesit bazlı profil satırı (dağılım grafiği ve üst/alt zon karşılaştırması). */
export interface SliceProfileEntry {
  slice: number;
  /** Örneklenen akciğer vokseli (gövde dışı hava hariç) */
  voxels: number;
  laa950Pct: number;
  meanHu: number;
}

export interface LungProfile {
  bins: HuBin[];
  profile: SliceProfileEntry[];
  sampledVoxels: number;
  /** Kaç kesitte bir örneklendi */
  sliceStep: number;
  /** Kaç pikselde bir örneklendi */
  pixelStride: number;
  /** Serideki toplam kesit */
  sliceCount: number;
}

export interface LungSampleOptions {
  /** Piksel örnekleme adımı (1 = tümü). Varsayılan 2. */
  pixelStride?: number;
  /** En fazla kaç kesit örneklensin (adım buna göre büyür). Varsayılan 48. */
  maxSlices?: number;
  /** Akciğer içi sayılan üst HU sınırı. Varsayılan −400. */
  lungMaxHu?: number;
  /** Gövde sınırı eşiği: satır kenarından içeri doğru bu HU'un üstü gövde sayılır. */
  bodyMinHu?: number;
  /** Histogram küme genişliği (HU). Varsayılan 50. */
  binSize?: number;
  /** Histogram alt sınırı (HU). Varsayılan −1250. */
  binLow?: number;
  /** Histogram küme sayısı. Varsayılan 26 (≈ −1250…+50). */
  binCount?: number;
}

/**
 * Seriden akciğer histogramı ve kesit profili çıkarır (kural tabanlı).
 *
 * Gövde maskesi basittir: her satırın iki ucundan içeri doğru `bodyMinHu` üstü
 * ilk piksel gövde duvarı sayılır, aradaki bölgede `lungMaxHu` altı pikseller
 * akciğer kabul edilir. Böylece **gövde dışı hava** (−1000 HU) sayılmaz; ancak
 * fissür/lob ayrımı yapılmaz ve plevral/mediastinal sınırlar hekim denetimi
 * gerektirir. Örnekleme nedeniyle sonuçlar hacim ağırlıklı bir tahmindir.
 */
export function sampleLungHistogram(
  getSlice: (z: number) => ArrayLike<number> | undefined,
  width: number,
  height: number,
  sliceCount: number,
  opts: LungSampleOptions = {},
): LungProfile {
  const stride = Math.max(1, Math.round(opts.pixelStride ?? 2));
  const maxSlices = Math.max(1, Math.round(opts.maxSlices ?? 48));
  const step = Math.max(1, Math.ceil(Math.max(1, sliceCount) / maxSlices));
  const lungMax = opts.lungMaxHu ?? -400;
  const bodyMin = opts.bodyMinHu ?? -300;
  const binSize = Math.max(1, opts.binSize ?? 50);
  const binLow = opts.binLow ?? -1250;
  const binCount = Math.max(1, Math.round(opts.binCount ?? 26));

  const perSliceBins = new Map<number, { bins: number[]; voxels: number; sumHu: number; low: number }>();
  for (let z = 0; z < sliceCount; z += step) {
    const data = getSlice(z);
    if (!data || data.length < width * height) continue;
    const bins = new Array<number>(binCount).fill(0);
    let voxels = 0;
    let sumHu = 0;
    let low = 0;
    for (let y = 0; y < height; y += stride) {
      const row = y * width;
      // gövde sınırı: satırın iki ucundan içeri doğru ilk "gövde" pikseli
      let x0 = -1;
      for (let x = 0; x < width; x += stride) if (data[row + x] >= bodyMin) { x0 = x; break; }
      let x1 = -1;
      for (let x = width - 1; x >= 0; x -= stride) if (data[row + x] >= bodyMin) { x1 = x; break; }
      if (x0 < 0 || x1 <= x0) continue;
      for (let x = x0; x <= x1; x += stride) {
        const hu = data[row + x];
        if (!(hu < lungMax)) continue;
        voxels++;
        sumHu += hu;
        if (hu < -950) low++;
        let idx = Math.floor((hu - binLow) / binSize);
        if (idx < 0) idx = 0;
        if (idx >= binCount) idx = binCount - 1;
        bins[idx]++;
      }
    }
    if (voxels === 0) continue;
    perSliceBins.set(z, { bins, voxels, sumHu, low });
  }

  const bins: HuBin[] = [];
  for (let i = 0; i < binCount; i++) {
    let count = 0;
    for (const v of perSliceBins.values()) count += v.bins[i];
    bins.push({ lo: binLow + i * binSize, hi: binLow + (i + 1) * binSize, count });
  }
  const profile: SliceProfileEntry[] = [...perSliceBins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slice, v]) => ({
      slice,
      voxels: v.voxels,
      laa950Pct: Number(((v.low / v.voxels) * 100).toFixed(1)),
      meanHu: Number((v.sumHu / v.voxels).toFixed(1)),
    }));
  return {
    bins,
    profile,
    sampledVoxels: [...perSliceBins.values()].reduce((n, v) => n + v.voxels, 0),
    sliceStep: step,
    pixelStride: stride,
    sliceCount,
  };
}

/** Kesit profilinin özeti: en kötü kesit, apikal–bazal fark ve yön notu. */
export interface ProfileSummary {
  worstSlice: number;
  worstLaa950Pct: number;
  /** Alt yarı eksi üst yarı LAA-950 (yüzde puan); + ise bazalde daha fazla. */
  basalMinusApical: number | null;
  note: string;
}

export function profileSummary(profile: readonly SliceProfileEntry[]): ProfileSummary | null {
  const used = profile.filter((p) => p.voxels > 0);
  if (used.length === 0) return null;
  const worst = used.reduce((a, b) => (b.laa950Pct > a.laa950Pct ? b : a));
  if (used.length < 4) {
    return { worstSlice: worst.slice, worstLaa950Pct: worst.laa950Pct, basalMinusApical: null, note: "Dağılım için yeterli kesit yok." };
  }
  const mid = Math.floor(used.length / 2);
  const avg = (arr: SliceProfileEntry[]) => arr.reduce((n, p) => n + p.laa950Pct, 0) / arr.length;
  const diff = Number((avg(used.slice(mid)) - avg(used.slice(0, mid))).toFixed(1));
  const note = diff > 3
    ? "Alt (bazal) kesitlerde belirgin daha fazla düşük atenüasyon."
    : diff < -3
      ? "Üst (apikal) kesitlerde belirgin daha fazla düşük atenüasyon."
      : "Üst–alt dağılım benzer.";
  return { worstSlice: worst.slice, worstLaa950Pct: worst.laa950Pct, basalMinusApical: diff, note };
}

/** Rapora/akışa eklenecek tek satır özet. */
export function lungQuantText(r: LungQuantResult, profile?: { sliceStep: number; pixelStride: number } | null): string {
  const parts = [
    `LAA-950 %${r.laa950Pct.toFixed(1)}`,
    `ortalama HU ${r.meanHu.toFixed(0)}`,
    `PD15 ${r.pd15Hu === null ? "—" : `${r.pd15Hu.toFixed(0)} HU`}`,
  ];
  if (r.volumeMl !== null) parts.push(`akciğer hacmi ${r.volumeMl.toFixed(0)} mL`);
  parts.push(`sınıf ${r.category}`);
  const sample = profile ? ` (${profile.sliceStep} kesit / ${profile.pixelStride} piksel örnekleme)` : "";
  return `Akciğer kantitasyonu${sample}: ${parts.join(" · ")}. Kural tabanlı tahmindir; lob/fissür ayrımı yapılmaz, DSBG ile birlikte değerlendirilir.`;
}

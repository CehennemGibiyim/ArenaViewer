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
  let acc = 0;
  let pd15: number | null = null;
  for (const b of [...valid].sort((a, z) => a.lo - z.lo)) {
    acc += b.count;
    if (acc >= total * 0.15) { pd15 = (b.lo + b.hi) / 2; break; }
  }

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

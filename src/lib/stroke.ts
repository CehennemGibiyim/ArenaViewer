/**
 * İnme analiz yardımcıları: ASPECTS bölge skoru ve kural/bağlam tabanlı
 * perfüzyon özetleri (CTP).
 *
 * ÖNEMLİ: Bu modül **klinik karar aracı değildir** ve gerçek CTP yazılımı
 * (devolüsyon/deconvolution) değildir. Ölçümler hekimin belirlediği zaman-yoğunluk
 * eğrilerine dayalı basitleştirilmiş indekslerdir; tanı ve tedavi seçimi
 * radyolog/klinisyen sorumluluğundadır.
 */

// ─────────────── ASPECTS ───────────────

/** ASPECTS 10 bölgesi ( MCA territory, insular ribbon dahil). */
export const ASPECTS_REGIONS = [
  "caudate", "lentiform", "internalCapsule", "insularRibbon",
  "M1", "M2", "M3", "M4", "M5", "M6",
] as const;

export type AspectsRegion = (typeof ASPECTS_REGIONS)[number];

export const ASPECTS_LABELS: Record<AspectsRegion, string> = {
  caudate: "Caudatus",
  lentiform: "Lentiformis",
  internalCapsule: "İç kapsül",
  insularRibbon: "İnsüler bant",
  M1: "M1 (ön kortikal)",
  M2: "M2 (MDA ön temporal)",
  M3: "M3 (MDA arka temporal)",
  M4: "M4 (MDA parietal ön)",
  M5: "M5 (MDA parietal arka)",
  M6: "M6 (MDA oksipital)",
};

export interface AspectsResult {
  score: number;
  abnormal: string[];
  normal: string[];
  note: string;
}

/** ASPECTS: 10 üzerinden, anormal işaretli her bölge 1 puan düşer. */
export function aspectsScore(abnormal: readonly string[]): AspectsResult {
  const set = new Set(abnormal.filter((r) => (ASPECTS_REGIONS as readonly string[]).includes(r)));
  const score = 10 - set.size;
  const note =
    score >= 8
      ? "ASPECTS ≥8: geniş MDA alanında erken dönem lezyon sınırlı sayılabilir (seçilmiş hasta grubunda intrakanüler tedavi yanıtı ile korelasyon gösterilmiştir)."
      : score >= 6
        ? "ASPECTS 6–7: orta büyüklükte alan tutulumu."
        : "ASPECTS ≤5: geniş alan tutulumu; mortalite/morbidite riski artar.";
  return {
    score,
    abnormal: [...set],
    normal: ASPECTS_REGIONS.filter((r) => !set.has(r)),
    note: `${note} Skor yalnızca işaretlenen bölgelerden hesaplanır; bölge sınırlandırması radyologa aittir.`,
  };
}

// ─────────────── CTP / perfüzyon indeksleri ───────────────

export interface TimeCurve {
  /** Saniye cinsinden örnekleme zamanları (artan) */
  t: number[];
  /** Bu zamanlardaki yoğunluk (HU) */
  v: number[];
}

export interface PerfusionIndex {
  /** Zirve yoğunluk farkı */
  peak: number;
  /** Zirveye kaç saniyede ulaşıldı */
  timeToPeakSec: number;
  /** Eğrinin altındaki alan (özet ölçü) */
  auc: number;
  /** Basit yerel faz kalanıyla yaklaşık MTT (saniye) */
  mttApproxSec: number | null;
}

/** Tek bir zaman-yoğunluk eğrisinin basit özellikleri. */
export function curveFeatures(c: TimeCurve): PerfusionIndex {
  const n = Math.min(c.t.length, c.v.length);
  if (n === 0) return { peak: 0, timeToPeakSec: 0, auc: 0, mttApproxSec: null };
  let peak = -Infinity;
  let iPeak = 0;
  for (let i = 0; i < n; i++) if (c.v[i] > peak) { peak = c.v[i]; iPeak = i; }
  let auc = 0;
  for (let i = 1; i < n; i++) {
    const dt = c.t[i] - c.t[i - 1];
    if (dt <= 0) continue;
    auc += ((c.v[i] + c.v[i - 1]) / 2) * dt;
  }
  // Residue yaklaşımı: MTT ≈ AUC/peak (AIF düzeltilmemiş basit versiyon)
  const mtt = peak > 0 ? auc / peak : null;
  return { peak, timeToPeakSec: c.t[iPeak], auc, mttApproxSec: mtt };
}

export interface CtpInput {
  /** Doku eğrisi */
  tissue: TimeCurve;
  /** Arter giriş fonksiyonu (AIF) eğrisi */
  aif: TimeCurve;
}

export interface CtpSummary {
  ttpTissueSec: number;
  mttApproxSec: number | null;
  /** Doku/AIF zirve oranı — basit CBF göstergesi */
  cbfRatio: number | null;
  /** Doku/AIF alan oranı — basit CBV göstergesi */
  cbvRatio: number | null;
  /** Tmax benzeri gecikme: AIF zirvesine göre doku zirve gecikmesi (saniye) */
  delaySec: number | null;
  coreLikely: boolean;
  penumbraLikely: boolean;
  caveat: string;
}

/**
 * CTP yamuklaştırması: doku eğrisi AIF'e göre gecikirirse penumbra adayı,
 * zirve çok düşükse core adayı olarak işaretlenir. Gerçek dekonvolüsyon DEĞİLDİR.
 */
export function ctpSummary(input: CtpInput): CtpSummary {
  const t = curveFeatures(input.tissue);
  const a = curveFeatures(input.aif);

  const delaySec = Math.abs(t.timeToPeakSec - a.timeToPeakSec) || null;
  const cbfRatio = a.peak > 0 ? t.peak / a.peak : null;
  const cbvRatio = a.auc > 0 ? t.auc / a.auc : null;
  const mttApproxSec = t.mttApproxSec !== null && a.mttApproxSec !== null ? Math.max(0, t.mttApproxSec - a.mttApproxSec) : null;

  const coreLikely = cbfRatio !== null && cbfRatio < 0.3;
  const penumbraLikely = delaySec !== null && delaySec > 6 && !coreLikely;

  return {
    ttpTissueSec: t.timeToPeakSec,
    mttApproxSec,
    cbfRatio,
    cbvRatio,
    delaySec,
    coreLikely,
    penumbraLikely,
    caveat:
      "Bu ölçümler basitleştirilmiş residue/gorunur eğri özellikleridir; gerçek CBF/CBV/MTT/Tmax için AIF seçimi, hareket düzeltmesi ve dekonvolüsyon gereklidir.",
  };
}

/** CSV satırı (inme protokol çıktısı için). */
export function strokeCsv(p: { aspects?: AspectsResult; ctp?: CtpSummary }): string {
  const rows: string[][] = [["İnme analizi", ""]];
  if (p.aspects) {
    rows.push(["ASPECTS", String(p.aspects.score)]);
    rows.push(["Anormal bölgeler", p.aspects.abnormal.join(", ") || "yok"]);
    rows.push(["Not", p.aspects.note]);
  }
  if (p.ctp) {
    rows.push(["Doku TTP (sn)", p.ctp.ttpTissueSec.toFixed(1)]);
    rows.push(["Gecikme (sn)", p.ctp.delaySec === null ? "" : p.ctp.delaySec.toFixed(1)]);
    rows.push(["CBF oranı", p.ctp.cbfRatio === null ? "" : p.ctp.cbfRatio.toFixed(2)]);
    rows.push(["CBV oranı", p.ctp.cbvRatio === null ? "" : p.ctp.cbvRatio.toFixed(2)]);
    rows.push(["Core adayı", p.ctp.coreLikely ? "evet" : "hayır"]);
    rows.push(["Penumbra adayı", p.ctp.penumbraLikely ? "evet" : "hayır"]);
  }
  return rows.map((r) => r.join(";")).join("\n");
}

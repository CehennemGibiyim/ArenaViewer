/**
 * Model belirsizlik göstergesi (a-uncert).
 *
 * SINIR: Bu bir kalibrasyon veya güven ARALIĞI üretmez. Skor kalibre olasılık
 * DEĞİLDİR (model kartındaki makro AUROC/AUPRC'ye bakın); burada yalnızca
 * "skorun sınıf eşiğine uzaklığı"ndan doğan üç bant sunulur. Amaç: radyologa
 * "model bu vakada emin değil" uyarısını vermektir. Kalibrasyon eğrisi,
 * doğrulama seti/klinik süreç gerektirir.
 */

export type UncertaintyBand = "sinirda" | "orta" | "guclu";

export const BAND_MARGIN = 0.05;
export const BAND_STRONG = 0.2;

export const BAND_LABEL: Record<UncertaintyBand, string> = {
  sinirda: "SINIRDA",
  orta: "ORTA",
  guclu: "GÜÇLÜ",
};

/** Skor ile sınıf eşiği arasındaki mesafeden bant. */
export function uncertaintyBand(prob: number, threshold: number): UncertaintyBand {
  if (!Number.isFinite(prob) || !Number.isFinite(threshold)) return "sinirda";
  const d = prob - threshold;
  if (Math.abs(d) < BAND_MARGIN) return "sinirda";
  if (d >= BAND_STRONG) return "guclu";
  return "orta";
}

/**
 * Radyologa yönelik insan okunur not. "SINIRDA" vurgusu yapar: karar eşiğinin
 * hemen yanında olan model çıktısı klinik güven vermez.
 */
export function uncertaintyNote(band: UncertaintyBand, prob: number, threshold: number): string {
  const pct = `${Math.round(prob * 100)}%`;
  const th = `${Math.round(threshold * 100)}%`;
  switch (band) {
    case "sinirda":
      return `Model skoru ${pct}, sınıf eşiğinin (${th}) hemen yanında: SINIRDA bir aday; gündelik klinikte model "emin değil" der — mutlaka görüntüyü doğrulayın.`;
    case "orta":
      return `Model skoru ${pct} (eşik ${th}): orta düzeyde ayrım. Ölçek/ölçüm ve bulguyu birlikte değerlendirin.`;
    case "guclu":
      return `Model skoru ${pct}, eşiğin (${th}) oldukça üzerinde: model bu sınıfta güçlü görünüyor; yine de lokalizasyon kutusu üretmez, yerleştirme radyologa aittir.`;
  }
}

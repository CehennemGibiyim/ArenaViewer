/**
 * AI ısı haritası örtüsü (Grad-CAM görselleştirme) — paylaşılan kurallar (a-heat).
 *
 * Model aktivasyonu 0–255 gri gelir; düşük değerler gizlenir (eşik), renk
 * mavi→yeşil→sarı→kırmızı dörtlü geçişle verilir ve bulgu saydam oldukça alfa
 * uygulanır. Bu, yalnızca GÖRSELLEŞTİRME katmanıdır: model çıktısı radyolog
 * onayı olmadan klinik anlam taşımaz.
 */

/** Alt eşik: bu gri değerinin altı örtüye girmez (gürültü/karartı). */
export const HEAT_THRESHOLD = 26;
/** Saydamlık kaydırıcısının izin verdiği en yüksek alfa. */
export const HEAT_ALPHA_MAX = 0.95;

/** Jet-benzeri dörtlü renk geçişi (mavi→yeşil→sarı→kırmızı). */
export function heatColor(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(255, v)) / 255;
  if (t < 0.25) return [0, Math.round((t / 0.25) * 255), 255];
  if (t < 0.5) return [0, 255, Math.round((1 - (t - 0.25) / 0.25) * 255)];
  if (t < 0.75) return [Math.round(((t - 0.5) / 0.25) * 255), 255, 0];
  return [255, Math.round((1 - (t - 0.75) / 0.25) * 255), 0];
}

/** Görünürlük kararı: eşiğin altı tamamen şeffaf, üstü alfayla oturur. */
export function heatVisible(v: number): boolean {
  return v >= HEAT_THRESHOLD;
}

/** 8 bit RGBA paketi (kırmızı-mavi bayt sırası: BGRA, little-endian u32 görünümü). */
export function heatPixel(v: number, alpha: number): number {
  const [r, g, b] = heatColor(v);
  return ((alpha * (v / 255)) << 24) | (b << 16) | (g << 8) | r;
}

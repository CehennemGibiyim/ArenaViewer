/**
 * Erişilebilirlik yardımcıları (i-a11y): WCAG 2.1 kontrast matematiği, yüksek
 * kontrast teması sabitleri ve arayüz renk denetimi.
 *
 * Bu modül saf fonksiyonlardır; tema sınıfı `globals.css` içindeki `.hc`
 * kurallarıyla eşleşir. Kontrast oranı 1–21 arasındadır; WCAG AA normal metin
 * için 4,5:1, büyük metin (≥18,66 px kalın veya ≥24 px) ve arayüz bileşenleri
 * için 3:1 ister.
 */

export type WcagLevel = "AAA" | "AA" | "AA (büyük metin)" | "yetersiz";

/** Yüksek kontrast teması: `<html>` üzerine eklenen sınıf. */
export const HIGH_CONTRAST_CLASS = "hc";
/** Yüksek kontrast tercihinin saklandığı anahtar (localStorage). */
export const HIGH_CONTRAST_STORAGE_KEY = "atik-high-contrast";
/** Klavye kullanıcısı için ilk odak hedefi. */
export const SKIP_LINK_LABEL = "İçeriğe geç";

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
export const AAA_NORMAL = 7;
export const AAA_LARGE = 4.5;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** #rgb / #rrggbb → [r,g,b] (0–255). Geçersiz girişte null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const h = (hex ?? "").trim().replace(/^#/, "");
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return [r, g, b].some((n) => Number.isNaN(n)) ? null : [r, g, b];
  }
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b].some((n) => Number.isNaN(n)) ? null : [r, g, b];
}

/** WCAG bağıl parlaklık (0 = siyah, 1 = beyaz). Geçersiz renkte NaN. */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return Number.NaN;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** İki renk arasındaki kontrast oranı (1–21). Sıra önemsizdir. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (!Number.isFinite(la) || !Number.isFinite(lb)) return Number.NaN;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Oranı WCAG düzeyine çevirir. `large` = büyük metin/arayüz bileşeni. */
export function wcagLevel(ratio: number, large = false): WcagLevel {
  if (!Number.isFinite(ratio)) return "yetersiz";
  const r = clamp01(ratio / 21) * 21; // NaN koruması ve üst sınır
  if (large) {
    if (r >= AAA_LARGE) return "AAA";
    if (r >= AA_LARGE) return "AA (büyük metin)";
    return "yetersiz";
  }
  if (r >= AAA_NORMAL) return "AAA";
  if (r >= AA_NORMAL) return "AA";
  return "yetersiz";
}

/** Verilen metin boyutu/kalınlık için gereken en düşük oran. */
export function requiredRatio(sizePx: number, bold = false): number {
  const large = sizePx >= 24 || (bold && sizePx >= 18.66);
  return large ? AA_LARGE : AA_NORMAL;
}

/** Oranın gereken eşiği geçip geçmediği. */
export function meetsAA(ratio: number, sizePx = 14, bold = false): boolean {
  return Number.isFinite(ratio) && ratio >= requiredRatio(sizePx, bold);
}

export interface ContrastPair {
  name: string;
  fg: string;
  bg: string;
  /** Beklenen en düşük oran (arayüz bileşeni için 3, metin için 4,5). */
  min: number;
}

export interface ContrastRow extends ContrastPair {
  ratio: number;
  pass: boolean;
  level: WcagLevel;
}

/** Renk çiftlerini denetler; UI renk paletinin raporlanabilir hâli. */
export function auditContrast(pairs: readonly ContrastPair[]): ContrastRow[] {
  return pairs.map((p) => {
    const ratio = contrastRatio(p.fg, p.bg);
    return { ...p, ratio, pass: Number.isFinite(ratio) && ratio >= p.min, level: wcagLevel(ratio, p.min <= AA_LARGE) };
  });
}

/** Arayüzün ana zemin renkleri. */
export const APP_BG = "#0b0f16";
export const APP_BG_DEEP = "#070a0f";

/**
 * Kullanılan metin renkleri ve AA eşikleri. `slate-500` bilerek 3:1 (ikincil /
 * arayüz bileşeni) eşiğiyle listelenir; normal metin olarak kullanıldığında
 * yüksek kontrast teması (`.hc`) devreye girer.
 */
export const UI_TOKENS: ContrastPair[] = [
  { name: "slate-200 (ana metin)", fg: "#e2e8f0", bg: APP_BG, min: AA_NORMAL },
  { name: "slate-300", fg: "#cbd5e1", bg: APP_BG, min: AA_NORMAL },
  { name: "slate-400 (ikincil metin)", fg: "#94a3b8", bg: APP_BG, min: AA_NORMAL },
  { name: "slate-500 (etiket)", fg: "#64748b", bg: APP_BG, min: AA_LARGE },
  { name: "cyan-300 (vurgu)", fg: "#67e8f9", bg: APP_BG, min: AA_NORMAL },
  { name: "amber-300 (uyarı)", fg: "#fcd34d", bg: APP_BG, min: AA_NORMAL },
  { name: "rose-300 (hata)", fg: "#fda4af", bg: APP_BG, min: AA_NORMAL },
  { name: "emerald-300 (başarı)", fg: "#6ee7b7", bg: APP_BG, min: AA_NORMAL },
];

/** Yüksek kontrast temasında metin renklerinin yerine geçen değerler (CSS ile aynı). */
export const HC_TOKENS = {
  slate500: "#cbd5e1",
  slate400: "#e2e8f0",
  slate300: "#f1f5f9",
} as const;

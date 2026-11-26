/**
 * Okunabilirlik ölçümü (Türkçe) — hasta mektubu düzey doğrulaması.
 *
 * Yöntem: **Ateşman (1997)** okunabilirlik indeksi.
 *   İndeks = 198,825 − 40,175 × (hece/sözcük) − 2,610 × (sözcük/cümle)
 * İndeks **yükseldikçe metin kolaylaşır** (90–100 çok kolay … 1–29 çok zor).
 * Hece sayısı Türkçe için **ünlü harf grupları** ile sayılır (her ünlü yeni hece).
 *
 * Sınırlar:
 *  - Ölçüm yalnız Türkçe metinde anlamlıdır; EN/DE metinde `null` döner.
 *  - Formül bir *yaklaşımdır*: kısaltmalar, sayılar ve tıbbi terimler hece sayımını
 *    kaydırabilir; sonuç hekim onayının yerine geçmez.
 */

const TR_VOWELS = "aeıioöuü";
const TR_LOWER: Record<string, string> = { I: "ı", İ: "i" };

/** Türkçe küçük harfe çevirir (I→ı, İ→i; JS `toLowerCase` Türkçe'de yanlış sonuç verir). */
export function trLower(s: string): string {
  return s.replace(/[Iİ]/g, (c) => TR_LOWER[c]).toLowerCase();
}

/**
 * Bir sözcükteki hece sayısı: **ünlü sayısı** (Ateşman indeksinin kullandığı yaklaşım).
 * Türkçede yan yana gelen ünlüler ayrı hece okunur ("mu-a-ye-ne" = 4); bu yüzden ünlü
 * gruplama yerine sayım yapılır. Sözcükte ünlü yoksa 1 kabul edilir (kısaltma/sayı).
 */
export function syllableCount(word: string): number {
  const w = trLower(word).replace(/[^a-zçğıöşü]/g, "");
  if (!w) return 0;
  let n = 0;
  for (const ch of w) if (TR_VOWELS.includes(ch)) n++;
  return Math.max(1, n);
}

export interface ReadabilityStats {
  /** Metinde kalan sözcük sayısı. */
  words: number;
  /** Cümle sayısı (en az 1, metin varsa). */
  sentences: number;
  syllables: number;
  /** Ortalama sözcük/cümle (1 ondalık). */
  wordsPerSentence: number;
  /** Ortalama hece/sözcük (2 ondalık). */
  syllablesPerWord: number;
  /** Ateşman indeksi (0–100 aralığına kırpılır); ölçülemiyorsa null. */
  index: number | null;
  /** Ateşman sözel düzeyi. */
  level: ReadabilityLevel | null;
}

export type ReadabilityLevel = "çok kolay" | "kolay" | "orta" | "zor" | "çok zor";

/** Ateşman aralıkları (yüksek = kolay). */
export function atesmanLevel(index: number): ReadabilityLevel {
  if (index >= 90) return "çok kolay";
  if (index >= 70) return "kolay";
  if (index >= 50) return "orta";
  if (index >= 30) return "zor";
  return "çok zor";
}

/**
 * Düz metni cümlelere böler: cümle sonu noktalaması ve satır sonu sınır sayılır.
 * Yalnız noktalama/boşluktan oluşan parçalar atılır (kısa cümleler korunur — hasta
 * mektubunda "Kontrol önerilir." gibi kısa cümleler gerçektir).
 */
export function splitSentences(text: string): string[] {
  return (text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

/** Türkçe metin için Ateşman okunabilirlik ölçümü. */
export function analyzeReadability(text: string, lang: "tr" | "en" | "de" = "tr"): ReadabilityStats {
  const empty: ReadabilityStats = {
    words: 0, sentences: 0, syllables: 0, wordsPerSentence: 0, syllablesPerWord: 0, index: null, level: null,
  };
  const t = (text ?? "").trim();
  if (!t) return empty;
  if (lang !== "tr") return empty; // formül Türkçe hece yapısına göre kalibre edilmiştir

  const tokens = t
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const sentences = Math.max(1, splitSentences(t).length);
  if (tokens.length === 0) return empty;
  const syllables = tokens.reduce((a, w) => a + syllableCount(w), 0);
  const wordsPerSentence = tokens.length / sentences;
  const syllablesPerWord = syllables / tokens.length;
  const raw = 198.825 - 40.175 * syllablesPerWord - 2.61 * wordsPerSentence;
  const index = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  return {
    words: tokens.length,
    sentences,
    syllables,
    wordsPerSentence: Math.round(wordsPerSentence * 10) / 10,
    syllablesPerWord: Math.round(syllablesPerWord * 100) / 100,
    index,
    level: atesmanLevel(index),
  };
}

/** Düzey hedefi: "sade" için ≥ 70 (kolay), "standart" için ≥ 50 (orta). */
export const TARGET_INDEX = { sade: 70, standart: 50 } as const;

export interface ReadabilityVerdict {
  target: number;
  met: boolean;
  /** Kullanıcıya gösterilecek tek satır Türkçe değerlendirme. */
  message: string;
}

/** Ölçümü düzey hedefiyle karşılaştırır (hekim onayı yerine geçmez, uyarıdır). */
export function readabilityVerdict(
  stats: ReadabilityStats,
  level: "sade" | "standart",
): ReadabilityVerdict {
  const target = TARGET_INDEX[level];
  if (stats.index === null) {
    return { target, met: false, message: "Okunabilirlik ölçülemedi (metin yok veya dil Türkçe değil)." };
  }
  const met = stats.index >= target;
  const detail = `${stats.index} · ${stats.level} (hedef ≥ ${target}); cümle başına ${stats.wordsPerSentence} sözcük, sözcük başına ${stats.syllablesPerWord} hece`;
  return {
    target,
    met,
    message: met
      ? `${level === "sade" ? "Sade" : "Standart"} düzey hedefi tutuyor: ${detail}`
      : `${level === "sade" ? "Sade" : "Standart"} düzey hedefi TUTMUYOR: ${detail} — cümleleri kısaltın veya terim sözlüğünü genişletin.`,
  };
}

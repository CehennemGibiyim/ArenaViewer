/**
 * Şablon yer tutucü (makro) yardımcısı (r-template).
 *
 * Şablonlardaki "[KONUM]", "[BOYUT]", "[HU]" gibi alanlar rapora kopyalanır;
 * hekimin bunları doldurması gerekir. Bu modül tutucuları tanır, benzerini
 * bir araya toplar ve doldurma haritasıyla metni yeniden yazar.
 */

/** [içinde] boşluk/bölü işareti olmayan kısa etiketler. */
export const PLACEHOLDER_RE = /\[([^\[\]]{1,48})\]/g;

/** Metindeki benzersiz yer tutucular (sıra korunur). */
export function placeholders(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const key = m[1].trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Tüm rapor metinleri için kalan yer tutucular (benzersiz). */
export function reportPlaceholders(r: { technique?: string; findingsText?: string; impression?: string; recommendation?: string }): string[] {
  const all = [`${r.technique ?? ""}`, `${r.findingsText ?? ""}`, `${r.impression ?? ""}`, `${r.recommendation ?? ""}`].join("\n");
  return placeholders(all);
}

/**
 * Verilen doldurma haritasıyla tutucuları değiştirir; bırakılanlar aynen
 * kalır (henüz doldurulmamış olan gösterilebilir).
 */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  if (!text) return "";
  return text.replace(PLACEHOLDER_RE, (full, inner: string) => {
    const key = String(inner).trim();
    const v = values[key];
    return v !== undefined && v.trim() !== "" ? v.trim() : full;
  });
}

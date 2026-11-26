/**
 * Rapor cümlesi → bulgu kimliği bağlama (r-link).
 *
 * Amaç: rapordaki serbest metinde geçen cümlenin hangi bulguya (ve dolayısıyla
 * hangi kesite/kutuya) ait olduğunu göstermek; cümleye tıklanınca o kesit açılır ve
 * bulgu vurgulanır.
 *
 * Eşleme kuralları (deterministik, LLM yok):
 *  1. Cümlede açık **"Kesit N"** geçiyorsa o kesitin bulgusu kazanır.
 *  2. Aksi halde bulgu etiketindeki sözcüklerle **ortak sözcük** aranır (≥ 4 harf,
 *     Türkçe küçük harf, noktalama ayıklanır). En çok ortak sözcüğü olan bulgu seçilir;
 *     eşitlikte listede önce gelen kazanır.
 *  3. Eşleşme yoksa cümle bağlanmaz (`findingId = null`) — uydurma bağ kurulmaz.
 */
import { splitSentences, trLower } from "./readability";

export interface LinkTarget {
  id: string;
  /** Bulgu etiketi (ör. "Nodül", "Konsolidasyon"). */
  label: string;
  /** 1 tabanlı anahtar kesit numarası (rapor metnindeki "Kesit N" ile aynı). */
  keySliceNumber?: number;
  /** 0 tabanlı kesit indeksi. */
  sliceIndex?: number;
}

export interface LinkedSentence {
  /** Metindeki sıra (0 tabanlı). */
  index: number;
  text: string;
  findingId: string | null;
  /** 1 tabanlı kesit numarası (gidilecek kesit). */
  sliceNumber: number | null;
  matchedBy: "kesit" | "etiket" | null;
}

/** Sık geçen, ayırt edici olmayan sözcükler (eşleşmede kullanılmaz). */
const STOPWORDS = new Set([
  "olan", "olarak", "ile", "veya", "için", "gibi", "daha", "ancak", "fakat", "üzerinde", "arasında",
  "mevcut", "saptan", "saptandı", "izlendi", "görüldü", "vardır", "yoktur", "olup", "birlikte",
  "değişiklik", "değerlendirme", "inceleme", "kesit", "kesitte", "seri", "seride", "normal",
]);

/** Karşılaştırma için sözcüklere ayırır (≥ 4 harf, stopword ve sayı yok). */
export function linkTokens(text: string): string[] {
  const toks = trLower(text ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && /\p{L}/u.test(w))
    .filter((w) => !STOPWORDS.has(w));
  return [...new Set(toks)];
}

/** "Kesit 12" / "kesit: 12" ifadesindeki kesit numarası. */
export function sliceFromSentence(text: string): number | null {
  const m = (text ?? "").match(/\bkesit\b\s*[:#]?\s*(\d{1,3})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function targetSlice(f: LinkTarget): number | null {
  if (typeof f.keySliceNumber === "number" && f.keySliceNumber > 0) return f.keySliceNumber;
  if (typeof f.sliceIndex === "number") return f.sliceIndex + 1;
  return null;
}

/** Metni cümlelere bölüp her cümleyi bir bulguya bağlar. */
export function linkSentences(text: string, findings: LinkTarget[]): LinkedSentence[] {
  const sentences = splitSentences(text ?? "");
  const prepared = findings.map((f) => ({ f, tokens: linkTokens(f.label) }));
  return sentences.map((s, index) => {
    const sliceNo = sliceFromSentence(s);
    if (sliceNo !== null) {
      const byKs = findings.find((f) => targetSlice(f) === sliceNo);
      // Açık kesit numarası önceliklidir: o kesitte bulgu yoksa cümle etiketle
      // başka bir bulguya bağlanmaz (yanlış vurgulama yerine yalnız kesite gidilir).
      return byKs
        ? { index, text: s, findingId: byKs.id, sliceNumber: sliceNo, matchedBy: "kesit" }
        : { index, text: s, findingId: null, sliceNumber: sliceNo, matchedBy: null };
    }
    const sentTokens = new Set(linkTokens(s));
    let best: { f: LinkTarget; score: number } | null = null;
    for (const { f, tokens } of prepared) {
      if (tokens.length === 0) continue;
      let score = 0;
      for (const t of tokens) if (sentTokens.has(t)) score++;
      if (score > 0 && (!best || score > best.score)) best = { f, score };
    }
    if (best) {
      return { index, text: s, findingId: best.f.id, sliceNumber: targetSlice(best.f), matchedBy: "etiket" };
    }
    return { index, text: s, findingId: null, sliceNumber: sliceNo, matchedBy: null };
  });
}

/** Bağlanan cümle oranı (kullanıcıya "kaç cümle bağlı" bilgisi). */
export function linkCoverage(links: LinkedSentence[]): { linked: number; total: number; ratio: number } {
  const total = links.length;
  const linked = links.filter((l) => l.findingId !== null).length;
  return { linked, total, ratio: total === 0 ? 0 : Math.round((linked / total) * 100) / 100 };
}

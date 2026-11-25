/**
 * Hekim üslubuna uyum için üslup örneği seçimi (r-genai).
 *
 * GİZLİLİK: Örnek yalnızca rapor METNİNDEN (izlenim bölümü) alınır; hasta
 * adı/kimliği içermez ve istemciye LLM'e yalnızca bu metin örneği gönderilir.
 * Sunucu, örneği denetim kaydına yazmaz (metin sadece istek taşınır).
 */

export const STYLE_SAMPLE_MAX = 1200;

export interface StyleCandidate {
  impression: string;
  bodyPart?: string;
  modality?: string;
  status?: string;
}

/** Onaylı ve metni anlamlı olan adayları ayıklar. */
function usable(r: StyleCandidate): string | null {
  if (r.status && r.status !== "onaylandi") return null;
  const t = (r.impression ?? "").trim();
  return t.length >= 20 ? t : null;
}

/**
 * Aynı bölge tercihi öncelikli, ardından en uzun örnek (stili en iyi taşır).
 * Gönderilecek parça sınırlıdır (LLM bağlam/genel gizlilik).
 */
export function pickStyleSample(
  reports: StyleCandidate[],
  prefer: { bodyPart?: string; modality?: string } = {},
): string | null {
  const ok = reports.map(usable).filter((t): t is string => t !== null);
  if (!ok.length) return null;
  const sameRegion = ok.filter((_, i) => {
    const r = reports[i];
    return !!prefer.bodyPart && (r.bodyPart ?? "") === prefer.bodyPart;
  });
  const pool = sameRegion.length ? sameRegion : ok;
  const longest = [...pool].sort((a, b) => b.length - a.length)[0];
  return longest.slice(0, STYLE_SAMPLE_MAX);
}

/** LLM sistem talimatına eklenen üslup yönergesi. */
export function buildStyleInstruction(sample: string): string {
  return (
    `Aşağıdaki metin aynı hekimin geçmiş (kimliksiz) rapor örneğidir; cümle yapısı, ` +
    `sıralaması ve sözcük seçimine yaklaşık olarak uy: "${sample.replace(/"/g, "'").slice(0, 800)}"`
  );
}

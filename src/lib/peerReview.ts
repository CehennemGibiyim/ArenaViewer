/**
 * İkinci okuma / peer review (D): RADPEER tarzı uyum kaydı.
 *
 * Bu modül yalnızca veri modeli ve hesaplama içerir; DB/API katmanı ayrıştırılmıştır.
 * Değerlendirme üç sonuçla sınırlıdır; "uyumsuz" raporun klinik açıklaması zorunludur.
 */

export const PEER_RESULTS = ["uyumlu", "kismen-uyumlu", "uyumsuz"] as const;
export type PeerResult = (typeof PEER_RESULTS)[number];

/** Uyuşmazlığın klinik etki düzeyi (RADPEER fark kategorisi). */
export const DISCREPANCY_TYPES = [
  "", "eksik bulgu", "fazladan bulgu", "ölçüm/yerelizasyon hatası", "yanlış yorum", "teknik/kalite", "diğer",
] as const;

export interface PeerReviewRow {
  id: number;
  reportId: number;
  result: string;
  discrepancyType: string;
  note: string;
  reviewedBy: number | null;
  reviewedByName: string;
  contentHash: string;
  createdAt: string | Date;
}

export const RESULT_LABELS: Record<PeerResult, string> = {
  "uyumlu": "Uyumlu — ikinci okuma önceki yorumu doğruladı",
  "kismen-uyumlu": "Kısmen uyumlu — klinik olarak anlamlı olmayan küçük fark",
  "uyumsuz": "Uyumsuz — klinik açıdan anlamlı fark",
};

export function isPeerResult(v: unknown): v is PeerResult {
  return typeof v === "string" && (PEER_RESULTS as readonly string[]).includes(v);
}

export interface PeerSummary {
  total: number;
  uyumlu: number;
  kismen: number;
  uyumsuz: number;
  /** İkinci okumaların uyum oranı (0–1); kayıt yoksa null */
  agreementRate: number | null;
  lastResult: PeerResult | null;
}

/** Kayıtlardan özet üretir; bilinmeyen sonuçlar "uyumsuz" sayılmaz. */
export function summarizePeerReviews(rows: PeerReviewRow[]): PeerSummary {
  const uyumlu = rows.filter((r) => r.result === "uyumlu").length;
  const kismen = rows.filter((r) => r.result === "kismen-uyumlu").length;
  const uyumsuz = rows.filter((r) => r.result === "uyumsuz").length;
  const known = uyumlu + kismen + uyumsuz;
  const sorted = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return {
    total: rows.length,
    uyumlu,
    kismen,
    uyumsuz,
    agreementRate: known ? (uyumlu + kismen) / known : null,
    lastResult: sorted.length && isPeerResult(sorted[0].result) ? sorted[0].result : null,
  };
}

/** Sonuca göre eylem önerisi; rapor metninde doğrudan kullanılabilir. */
export function peerAdvice(result: PeerResult): string {
  if (result === "uyumlu") return "İkinci okuma uyumlu görüldü; ek işlem gerekmez.";
  if (result === "kismen-uyumlu") return "Küçük fark not edildi; izlenim cümlesini gözden geçirmeniz yeterli olabilir.";
  return "Klinik açıdan anlamlı fark — farkı raporlayan notu inceleyin; gerekirse raporu düzeltip yeniden onaylatın ve addendum ekleyin.";
}

/** Girdi doğrulaması: geçersiz durumda hata mesajı, geçerliyse temizlenmiş değer. */
export function validatePeerReview(input: unknown): { ok: true; value: { result: PeerResult; discrepancyType: string; note: string } } | { ok: false; error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!isPeerResult(o.result)) return { ok: false, error: "Sonuç uyumlu/kısmen-uyumlu/uyumsuz olmalı" };
  const type = typeof o.discrepancyType === "string" ? o.discrepancyType.trim().slice(0, 40) : "";
  if (!(DISCREPANCY_TYPES as readonly string[]).includes(type)) return { ok: false, error: "Geçersiz uyuşmazlık türü" };
  const note = typeof o.note === "string" ? o.note.trim().slice(0, 4000) : "";
  if (o.result === "uyumsuz" && note.length < 5) return { ok: false, error: "Uyumsuz değerlendirmede açıklama zorunludur" };
  return { ok: true, value: { result: o.result, discrepancyType: type, note } };
}

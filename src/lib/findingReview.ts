/**
 * Bulgu gözden geçirme gerekçeleri (r-review).
 *
 * Neden: hekim bir AI aday bulgusunu reddettiğinde veya düzenlediğinde, "neden"
 * bilgisi hiçbir yerde tutulmuyordu; denetim kaydında yalnız "reddedildi"
 * durumu kalıyordu. Bu modül gerekçenin zorunluluğunu, normalleştirmesini ve
 * rapora basılacak özetini tek yerde toplar (sunucu ve tarayıcı aynı kuralı
 * kullanır).
 *
 * Sınır: gerekçe serbest metindir — sınıflandırılmaz, NLP ile analiz edilmez.
 */
import type { Finding, FindingApprovalStatus } from "./types";

/** Gerekçe alanının üst sınırı (karakter). */
export const REVIEW_REASON_MAX = 200;

/** Gözden geçirme gerekçesi zorunlu durumlar: reddedilen ve düzenlenen bulgular. */
export function needsReviewReason(status: FindingApprovalStatus): boolean {
  return status === "reddedildi" || status === "duzenlendi";
}

/** Boşlukları sadeleştirir, kırpar ve uzunluğu sınırlar; metin değilse "". */
export function normalizeReviewReason(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().slice(0, REVIEW_REASON_MAX);
}

/**
 * Yalnız gerekçe gerektiren durumlar için temizlenmiş gerekçe haritası üretir
 * (veritabanına/şablona yazılacak biçim). Boş gerekçeler haritada yer almaz.
 */
export function sanitizeReviewReasons(
  reasons: Record<string, string> | null | undefined,
  approvals: Record<string, FindingApprovalStatus>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!reasons) return out;
  for (const [id, raw] of Object.entries(reasons)) {
    if (!needsReviewReason(approvals[id] ?? "bekliyor")) continue;
    const clean = normalizeReviewReason(raw);
    if (clean) out[id] = clean;
  }
  return out;
}

/** Gerekçesi zorunlu olduğu hâlde boş bırakılan bulguların kimlikleri (bulgu sırasıyla). */
export function missingReviewReasons(
  findings: Finding[],
  approvals: Record<string, FindingApprovalStatus>,
  reasons: Record<string, string> | null | undefined,
): string[] {
  const missing: string[] = [];
  for (const f of findings) {
    const status = approvals[f.id] ?? "bekliyor";
    if (!needsReviewReason(status)) continue;
    if (!normalizeReviewReason(reasons?.[f.id])) missing.push(f.id);
  }
  return missing;
}

export interface ReviewReasonLine {
  id: string;
  label: string;
  status: FindingApprovalStatus;
  reason: string;
}

/**
 * Rapora/yazdırma çıktısına basılacak gerekçe satırları. Yalnız gerekçesi
 * dolu olan reddedilen/düzenlenen bulgular döner; sıra bulgu sırasıdır.
 */
export function reviewReasonLines(
  findings: Finding[],
  approvals: Record<string, FindingApprovalStatus>,
  reasons: Record<string, string> | null | undefined,
): ReviewReasonLine[] {
  const out: ReviewReasonLine[] = [];
  for (const f of findings) {
    const status = approvals[f.id] ?? "bekliyor";
    if (!needsReviewReason(status)) continue;
    const reason = normalizeReviewReason(reasons?.[f.id]);
    if (!reason) continue;
    out.push({ id: f.id, label: f.label, status, reason });
  }
  return out;
}

/** Panodaki özet: kaç bulgu onaylandı/reddedildi/düzenlendi ve kaç gerekçe yazıldı. */
export function reviewTally(
  findings: Finding[],
  approvals: Record<string, FindingApprovalStatus>,
  reasons: Record<string, string> | null | undefined,
): { approved: number; rejected: number; edited: number; pending: number; withReason: number } {
  const t = { approved: 0, rejected: 0, edited: 0, pending: 0, withReason: 0 };
  for (const f of findings) {
    const status = approvals[f.id] ?? "bekliyor";
    if (status === "onaylandi") t.approved++;
    else if (status === "reddedildi") t.rejected++;
    else if (status === "duzenlendi") t.edited++;
    else t.pending++;
    if (needsReviewReason(status) && normalizeReviewReason(reasons?.[f.id])) t.withReason++;
  }
  return t;
}

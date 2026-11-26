/**
 * AI önerisi ↔ hekim kararı uyuşmazlığı (a-feedback / t-automation).
 *
 * Neden: AI performans panosu yalnız sayı (PPV) gösteriyordu; hangi kategoride
 * hekimin modeli reddettiği ve **neden** reddettiği (gerekçe metni) görünmüyordu.
 * Bu modül rapor kayıtlarından kategori bazlı uyuşmazlık oranını ve gerekçe
 * özetini deterministik biçimde üretir.
 *
 * Sınır: "uyuşmazlık" = hekimin reddettiği veya düzenlediği bulgu; klinik
 * doğruluk (duyarlılık/özgüllük) ÖLÇMEZ. Gerekçeler serbest metindir.
 */
import { needsReviewReason, normalizeReviewReason } from "./findingReview";
import type { Finding, FindingApprovalStatus } from "./types";

export interface DisagreementSource {
  findings: Finding[];
  approvals: Record<string, FindingApprovalStatus>;
  reasons?: Record<string, string> | null;
  engine?: string | null;
}

export interface CategoryDisagreement {
  engine: string;
  category: string;
  /** Karar verilmiş (onay/ret/düzenleme) bulgu sayısı. */
  decided: number;
  approved: number;
  rejected: number;
  edited: number;
  /** (red + düzenlenen) / karar verilen; karar yoksa null. */
  disagreementRate: number | null;
}

export interface ReasonDigestEntry {
  engine: string;
  category: string;
  label: string;
  status: "reddedildi" | "duzenlendi";
  reason: string;
}

/** Sistem/ROI satırları ile hekimin elle eklediği bulgular uyuşmazlık hesabına girmez. */
function counted(f: Finding): boolean {
  return f.category !== "Sistem" && f.category !== "ROI" && f.source !== "manual";
}

export function disagreementByCategory(sources: DisagreementSource[]): CategoryDisagreement[] {
  const map = new Map<string, CategoryDisagreement>();
  for (const src of sources) {
    const engine = src.engine?.trim() || "?";
    for (const f of src.findings ?? []) {
      if (!counted(f)) continue;
      const status = src.approvals?.[f.id] ?? "bekliyor";
      if (status === "bekliyor") continue;
      const key = `${engine}|${f.category}`;
      const row = map.get(key) ?? { engine, category: f.category, decided: 0, approved: 0, rejected: 0, edited: 0, disagreementRate: null };
      row.decided += 1;
      if (status === "onaylandi") row.approved += 1;
      else if (status === "reddedildi") row.rejected += 1;
      else if (status === "duzenlendi") row.edited += 1;
      map.set(key, row);
    }
  }
  const rows = [...map.values()].map((r) => ({
    ...r,
    disagreementRate: r.decided > 0 ? (r.rejected + r.edited) / r.decided : null,
  }));
  // En çok uyuşmazlık önce; eşitlikte karar sayısı, sonra kategori adı.
  return rows.sort((a, b) =>
    (b.disagreementRate ?? -1) - (a.disagreementRate ?? -1) ||
    b.decided - a.decided ||
    a.category.localeCompare(b.category, "tr"),
  );
}

/** Gerekçe metinleri (reddedilen/düzenlenen bulgular). En çok `limit` satır döner. */
export function reasonDigest(sources: DisagreementSource[], limit = 20): ReasonDigestEntry[] {
  const out: ReasonDigestEntry[] = [];
  const cap = Math.max(0, Math.floor(limit));
  for (const src of sources) {
    const engine = src.engine?.trim() || "?";
    for (const f of src.findings ?? []) {
      if (out.length >= cap) return out;
      if (!counted(f)) continue;
      const status = src.approvals?.[f.id] ?? "bekliyor";
      if (!needsReviewReason(status)) continue;
      const reason = normalizeReviewReason(src.reasons?.[f.id]);
      if (!reason) continue;
      out.push({ engine, category: f.category, label: f.label, status: status as "reddedildi" | "duzenlendi", reason });
    }
  }
  return out;
}

/** Pano başlığı için tek satır özet: toplam karar, ret, düzenleme ve gerekçe sayısı. */
export function disagreementTally(categories: CategoryDisagreement[], reasons: ReasonDigestEntry[]) {
  let decided = 0, rejected = 0, edited = 0;
  for (const c of categories) { decided += c.decided; rejected += c.rejected; edited += c.edited; }
  return {
    decided,
    rejected,
    edited,
    rate: decided > 0 ? (rejected + edited) / decided : null,
    withReason: reasons.length,
  };
}

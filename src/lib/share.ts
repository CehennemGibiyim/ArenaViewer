/**
 * Süreli paylaşım bağlantısı (F5): sonuç/anahtar kesitlerin süreli, kapatılabilir
 * ve denetlenen şekilde dışa paylaşılması.
 *
 * Bu dosya yalnızca saf hesaplama ve etiket içerir; DB ve HTTP katmanı ayrıdır.
 */

/** Seçilebilir geçerlilik süreleri (saat). */
export const SHARE_TTL_HOURS = [24, 72, 168, 720] as const;
/**
 * İki paylaşım türü:
 *  - `report`: onaylı rapor metni + anahtar kesit (mevcut).
 *  - `image`:  seçilen kesitlerin **anonim JPEG** hali (ham DICOM DEĞİL; WL/WW
 *    uygulanmış, hasta kimliği yakılmamış, ölçüm/AI çizimi yok). Sunucuda gömülü
 *    tutulur, süre/kapatma sonunda silinir. Ayrıntı: `src/lib/shareImage.ts`.
 */
export const SHARE_KINDS = ["report", "image"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/** Paylaşım sayfasında gösterilecek en fazla anahtar kesit sayısı. */
export const MAX_SHARED_KEY_IMAGES = 12;

export interface ShareRow {
  id: number;
  token: string;
  kind: string;
  reportId: number | null;
  studyId: number | null;
  createdBy: number | null;
  createdByName: string;
  expiresAt: Date | string;
  revokedAt: Date | string | null;
  accessCount: number;
  lastAccessAt: Date | string | null;
  createdAt: Date | string;
}

const HOUR = 3_600_000;

/** Geçerlilik süresini sona erme zaman damgasına çevirir. */
export function ttlToExpiresAt(ttlHours: number, now = new Date()): Date {
  return new Date(now.getTime() + ttlHours * HOUR);
}

export function isShareKind(v: unknown): v is ShareKind {
  return typeof v === "string" && (SHARE_KINDS as readonly string[]).includes(v);
}

/** Bağlantının şu an kullanılabilir olup olmadığı. */
export function isUsable(s: Pick<ShareRow, "expiresAt" | "revokedAt">, now = new Date()): boolean {
  if (s.revokedAt) return false;
  return new Date(s.expiresAt).getTime() > now.getTime();
}

export type ShareState = "aktif" | "suresi doldu" | "kapatildi";

export function shareState(s: Pick<ShareRow, "expiresAt" | "revokedAt">, now = new Date()): ShareState {
  if (s.revokedAt) return "kapatildi";
  return new Date(s.expiresAt).getTime() > now.getTime() ? "aktif" : "suresi doldu";
}

export function formatExpiry(s: Pick<ShareRow, "expiresAt">, now = new Date()): string {
  const ms = new Date(s.expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "süresi doldu";
  const h = Math.floor(ms / HOUR);
  if (h >= 48) return `${Math.floor(h / 24)} gün sonra`;
  if (h >= 1) return `${h} saat sonra`;
  return `${Math.max(1, Math.round(ms / 60000))} dakika sonra`;
}

export interface ShareSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
}

export function summarizeShares(rows: ShareRow[], now = new Date()): ShareSummary {
  let active = 0, expired = 0, revoked = 0;
  for (const r of rows) {
    const st = shareState(r, now);
    if (st === "aktif") active++;
    else if (st === "kapatildi") revoked++;
    else expired++;
  }
  return { total: rows.length, active, expired, revoked };
}

/** Paylaşım sayfasındaki filigran metni (token öneki ile izlenebilirlik). */
export function watermarkText(token: string, name = "ATIKVIEWER"): string {
  return `${name} · SÜRELİ PAYLAŞIM · ${token.slice(0, 8).toUpperCase()} · ${new Date().toISOString().slice(0, 10)}`;
}

/** Görüntü paylaşımının sayfa yükü (anonim başlık + kareler). */
export interface SharedImagePayload {
  kind: "image";
  createdAt: Date | string;
  expiresAt: Date | string;
  /** Seri etiketi (hasta adı YOK) */
  label: string;
  modality: string;
  studyDate: string;
  /** 1 tabanlı kare numaraları ve sunucudaki görüntü ucu */
  frames: { n: number; slice: number; width: number; height: number; bytes: number }[];
  /** `/api/share/{token}/image/{n}` — token dışında parametre yok */
  watermark?: string;
  note: string;
}

/** Paylaşım sayfasının salt okunur yükü. */
export interface SharedPayload {
  kind: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  patient: { name: string; id: string; sex: string; age: string };
  modality: string;
  studyDate: string;
  report: {
    status: string;
    technique: string;
    findings: string;
    impression: string;
    recommendation: string;
    approvedBy: string;
    doctorTitle: string;
    approvedAt: string | null;
    findingCount: number;
  };
  keyImages: string[];
  watermark?: string;
}

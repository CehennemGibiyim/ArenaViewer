/**
 * SEG/RTSTRUCT STOW yeniden deneme kuyruğu — saf yardımcılar (DB'siz).
 * DB okuma/yazma: `stowQueueRepo.ts`. İstemci tarafı asla buraya dokunmaz.
 *
 * Neden kuyruk: PACS anlık erişilemez olduğunda kullanıcının ürettiği SEG/RTSTRUCT
 * kaybolmasın. Nesne PACS'a içerik reddi (0008,1198) alırsa yeniden denemek çözüm
 * değildir — o durumda kuyruğa alınmaz. Ağ hatası / 5xx / zaman aşımı / yapılandırma
 * eksikliği yeniden denenebilir.
 */
import type { DerivedKind } from "../derivedStow";

export type QueuedKind = DerivedKind;

/** Kaç denemeden sonra kuyruk vazgeçer (satır silinmez — kullanıcıya görünür kalır). */
export const MAX_STOW_ATTEMPTS = 8;
/** Tek turda gönderilecek azami nesne (PACS'ı boğmamak için). */
export const STOW_BATCH = 20;

/** Yeniden deneme gecikmesi: 30 sn'den başlar, 1 saatte doygunlaşır. */
export function stowRetryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(30_000 * 2 ** n, 3_600_000);
}

/** Bir satır şimdi gönderilmeli mi? (vazgeçilenler ve süresi gelmeyenler hariç) */
export function dueForStowRetry(row: { attempts: number }, lastAttemptAt: Date | string | null, now = Date.now()): boolean {
  if (row.attempts >= MAX_STOW_ATTEMPTS) return false;
  if (!lastAttemptAt) return true;
  return now - new Date(lastAttemptAt).getTime() >= stowRetryDelayMs(row.attempts);
}

/**
 * Hata yeniden denenebilir mi?
 * - "reddetti": PACS nesneyi içerik olarak reddetti (0008,1198 / Failure Reason)
 *   — yeniden denemek aynı cevabı verir; DEĞİL.
 * - 4xx (408/429 hariç): kimlik/adres/yetki sorunu; sabit yeniden deneme faydasız — DEĞİL.
 * - Diğer her şey (ağ, zaman aşımı, 5xx, yapılandırma eksikliği): denenebilir.
 */
export function isRetryableStowError(message: string): boolean {
  const m = message ?? "";
  if (/reddetti/i.test(m)) return false;
  if (/\((4(?!08|29)\d\d)\)/.test(m)) return false;
  return true;
}

export interface QueueRowView {
  id: number;
  kind: string;
  studyUid: string;
  fileName: string;
  attempts: number;
  lastError: string;
  lastAttemptAt: Date | string | null;
  createdAt: Date | string;
  owner: string;
}

/** Yönetim ekranına/liste ucuna giden satır: asla payload içermez. */
export function publicRow(r: QueueRowView) {
  return {
    id: r.id,
    kind: r.kind,
    studyUid: r.studyUid,
    fileName: r.fileName,
    attempts: r.attempts,
    lastError: r.lastError,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
    owner: r.owner,
    exhausted: r.attempts >= MAX_STOW_ATTEMPTS,
  };
}

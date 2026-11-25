/**
 * Denetim → SIEM teslimat hattı (w-audit).
 *
 * Neden outbox: SIEM/toplayıcı çöktüğünde veya ağ kesildiğinde denetim
 * kayıtları KAYBOLMAMALI. Her CEF satırı önce `audit_delivery` tablosuna
 * yazılır (durum: bekliyor), teslimat başarısızsa `deneme` artar ve satır
 * kuyrukta kalır; başarılıysa `gonderildi` işaretlenir. Böylece ateşle-unut
 * UDP'nin "sessiz kayıp" davranışı telafi edilir.
 *
 * Saf yardımcılar burada (DB'siz) tutulur; DB okuma/yazma sunucu tarafında.
 */

export type DeliveryStatus = "bekliyor" | "denendi" | "gonderildi" | "vazgecildi";

export interface DeliveryRow {
  id: number;
  action: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string;
}

/** Kaç denemeden sonra vazgeçilir (satır silinmez — görünür kalır). */
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Tek turda gönderilecek azami olay (toplayıcıyı boğmamak için). */
export const DELIVERY_BATCH = 200;

/** Yeniden deneme gecikmesi: 30 sn'den başlar, 1 saatte doygunlaşır. */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(30_000 * 2 ** n, 3_600_000);
}

/** Bir satır şimdi gönderilmeli mi? (vazgeçilenler ve süresi gelmeyenler hariç) */
export function dueForDelivery(row: Pick<DeliveryRow, "status" | "attempts">, lastAttemptAt: Date | null, now = Date.now()): boolean {
  if (row.status === "gonderildi" || row.status === "vazgecildi") return false;
  if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  if (!lastAttemptAt) return true;
  return now - new Date(lastAttemptAt).getTime() >= retryDelayMs(row.attempts);
}

/** Teslimat sonucu satıra nasıl yansır. */
export function afterAttempt(row: Pick<DeliveryRow, "attempts">, ok: boolean, err = ""): { status: DeliveryStatus; attempts: number; lastError: string } {
  const attempts = row.attempts + 1;
  if (ok) return { status: "gonderildi", attempts, lastError: "" };
  return { status: attempts >= MAX_DELIVERY_ATTEMPTS ? "vazgecildi" : "denendi", attempts, lastError: err.slice(0, 500) };
}

/**
 * İmza başlığı: `sha256=<hex>`. Toplayıcı, paylaşılan sırla gövdeyi yeniden
 * hesaplayıp `X-Atik-Signature` başlığını doğrular; böylece araya giren bir
 * düğüm denetim kaydını değiştiremez. (hmacHex çağıran taraftan verilir.)
 */
export function signatureHeader(hmacHex: string): string {
  return `sha256=${hmacHex}`;
}

/** SIEM uç noktası yapılandırılmış mı (env). */
export function siemConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.AUDIT_SIEM_URL;
}

/** SIEM istek gövdesi: tek olay (NDJSON satırı olarak gönderilir). */
export function siemEvent(row: { id: number; ts: string | Date; username: string; action: string; entityType: string; entityId: string; details: string; hash: string }, cef: string) {
  return {
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    user: row.username,
    action: row.action,
    entity: { type: row.entityType, id: row.entityId },
    details: row.details,
    hash: row.hash,
    cef,
  };
}

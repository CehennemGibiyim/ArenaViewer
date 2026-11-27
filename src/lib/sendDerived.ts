/**
 * İstemcide üretilen SEG / RTSTRUCT DICOM baytlarını PACS'e STOW-RS ile gönderir.
 * `/api/pacs/stow` (kind="seg"|"rtstruct") sunucuda yeniden doğrulanır
 * (DICM + SOP Class + Study UID) ve audit'e yazılır; bu yalnız taşıma yardımcısıdır.
 * Üç arayüzden (Dışa aktar menüsü, Segmentasyon editörü, Diz MR paneli) paylaşılır.
 */
import { apiFetch } from "./csrfClient";
import type { DerivedKind } from "./derivedStow";

/** Büyük bayt dizilerini parça parça base64'e çevirir (spread sınırı aşılmaz). */
export function u8ToB64(u8: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(s);
}

export type DerivedSendResult =
  | { ok: true; stored: number; failed: number; pacs?: string; queued: number }
  | { ok: false; error: string; queued: number };

export async function sendDerivedToPacs(kind: DerivedKind, bytes: Uint8Array, studyUid: string, name: string): Promise<DerivedSendResult> {
  try {
    const r = await apiFetch("/api/pacs/stow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, studyUid, instances: [{ name, data: u8ToB64(bytes) }] }),
    });
    const d = (await r.json().catch(() => ({}))) as { stored?: number; failed?: number; pacs?: string; error?: string; queued?: number };
    if (!r.ok) return { ok: false, error: d.error ?? "PACS'e gönderilemedi", queued: d.queued ?? 0 };
    return { ok: true, stored: d.stored ?? 1, failed: d.failed ?? 0, pacs: d.pacs, queued: d.queued ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "PACS'e gönderilemedi", queued: 0 };
  }
}

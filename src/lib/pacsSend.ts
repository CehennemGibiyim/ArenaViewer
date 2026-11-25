/**
 * Anahtar kesit gönderim hazırlığı (w-pacs): seri durumu → DICOM KO / GSPS PR.
 *
 * Neden ayrı modül: KO/PR üretimi (`dicomSr`) saf ve testlidir; burada yalnızca
 * istemci durumundan (anahtar kesitler, pencere, döndürme) hangi nesnelerin
 * üretilebileceğine karar verilir ve PACS'e gönderim isteği kurulur.
 */

export interface KeyImageLike {
  slice: number;
  note?: string;
}

export interface SeriesUids {
  seriesUid?: string;
  sopClassUid?: string;
  sopUids?: string[];
}

export interface KeyObjectPlan {
  ok: boolean;
  /** Neden üretilemediği (kullanıcıya aynen gösterilebilir). */
  reason?: string;
  items: { sopUid: string; note?: string }[];
  /** UID'si eşlenemeyen (atlanan) kesit numaraları. */
  skipped: number[];
}

/**
 * Anahtar kesitleri (1-tabanlı kesit numarası) SOP UID'lerine eşler.
 * Sıra korunur; aynı SOP iki kez gönderilmez.
 */
export function planKeyObject(keyImages: KeyImageLike[], s: SeriesUids): KeyObjectPlan {
  if (!s.seriesUid || !s.sopClassUid || !s.sopUids?.length) {
    return { ok: false, reason: "Bu seride SOP Instance UID bilgisi yok (örnek vaka/UID'siz görüntü); KO yalnızca gerçek DICOM serileri için üretilir.", items: [], skipped: [] };
  }
  if (!keyImages.length) return { ok: false, reason: "Önce en az bir anahtar kesit (★) ekleyin.", items: [], skipped: [] };
  const items: { sopUid: string; note?: string }[] = [];
  const skipped: number[] = [];
  const seen = new Set<string>();
  for (const k of keyImages) {
    const uid = s.sopUids[k.slice];
    if (!uid) { skipped.push(k.slice); continue; }
    if (seen.has(uid)) continue;
    seen.add(uid);
    items.push({ sopUid: uid, note: k.note });
  }
  if (!items.length) return { ok: false, reason: "Anahtar kesitlerin SOP UID eşlemesi bulunamadı.", items: [], skipped };
  return { ok: true, items, skipped };
}

/** GSPS (PR) pencere/döndürme özeti — gönderim öncesi onay metni. */
export function presentationSummary(p: { wl: number; ww: number; rotation?: number; flipH?: boolean; flipV?: boolean; invert?: boolean }): string {
  const num = (v: number) => String(Math.round(v * 100) / 100);
  const parts = [`WL ${num(p.wl)} / WW ${num(Math.max(1, p.ww))}`];
  if (p.rotation) parts.push(`${p.rotation}° döndürme`);
  if (p.flipH) parts.push("yatay çevirme");
  if (p.flipV) parts.push("dikey çevirme");
  if (p.invert) parts.push("ters");
  return parts.join(", ");
}

export type StowKind = "sr" | "ko" | "pr";

/** Gönderim isteği gövdesi (sunucu ucu bunu bekler). */
export interface StowRequest {
  reportId?: number;
  studyUid?: string;
  seriesKey?: string;
  kind: StowKind;
}

/** İstemci doğrulaması: hedef ve tür tutarlı mı. */
export function validStowRequest(r: StowRequest): string | null {
  if (r.kind !== "sr" && r.kind !== "ko" && r.kind !== "pr") return "Geçersiz nesne türü";
  if (r.kind === "sr") return Number.isInteger(r.reportId) && (r.reportId ?? 0) > 0 ? null : "SR için onaylanmış rapor seçilmelidir";
  if (!r.studyUid) return "KO/PR için çalışma (StudyInstanceUID) gerekli";
  if (!r.seriesKey) return "KO/PR için seri anahtarı gerekli";
  return null;
}

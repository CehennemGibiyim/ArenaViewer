/**
 * PACS'e anonim seri gönderimi — istemci tarafı hazırlık (e-stow).
 *
 * Neden istemcide: anonim DICOM, görüntü BELLEKTEYKEN sıfırdan üretilir
 * (`dicomWrite.buildAnonymizedDicom`); sunucuya orijinal dosya gönderilmez.
 * Sunucu yalnız üretilmiş anonim baytları STOW-RS ile PACS'e iletir.
 *
 * Kurallar:
 *  - Örnek vaka / UID'siz seri gönderilemez (PACS'te kimliksiz çöp oluşmasın).
 *  - Tek istekte azami örnek ve bayt sınırı vardır (bellek/DoS koruması).
 *  - Yalnızca anonim bayt taşınır; hasta adı/kimliği istekte bulunmaz.
 */

export const ANON_MAX_INSTANCES = 400;
/** Tek istekte taşınacak azami anonim DICOM (bayt). */
export const ANON_MAX_BYTES = 80 * 1024 * 1024;

export interface AnonInstance {
  /** Dosya adı (kimlik içermez; denetim/iz için) */
  name: string;
  bytes: Uint8Array;
}

export interface AnonStowPlan {
  ok: boolean;
  reason?: string;
  count: number;
  bytes: number;
  /** base64 kodlanmış anonim örnekler */
  instances: { name: string; data: string }[];
}

function toBase64(b: Uint8Array): string {
  const b64 = typeof btoa === "function"
    ? (() => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); })()
    : Buffer.from(b).toString("base64");
  return b64;
}

/**
 * Anonim örnekleri STOW isteğine hazırlar.
 * @param sourceUids kaynak serinin SOP UID'leri (yoksa gönderim reddedilir)
 */
export function planAnonStow(instances: AnonInstance[], sourceUids?: string[]): AnonStowPlan {
  if (!sourceUids || sourceUids.length === 0) {
    return { ok: false, reason: "Bu seride SOP Instance UID bilgisi yok (örnek vaka veya UID'siz görüntü); anonim gönderim yalnız gerçek DICOM serilerinde yapılır.", count: 0, bytes: 0, instances: [] };
  }
  const list = instances.filter((i) => i.bytes?.length > 0);
  if (!list.length) return { ok: false, reason: "Gönderilecek anonim DICOM üretilemedi.", count: 0, bytes: 0, instances: [] };
  if (list.length > ANON_MAX_INSTANCES) {
    return { ok: false, reason: `Tek istekte en fazla ${ANON_MAX_INSTANCES} kesit gönderilebilir (${list.length} istendi); seriyi bölerek gönderin.`, count: list.length, bytes: 0, instances: [] };
  }
  const bytes = list.reduce((s, i) => s + i.bytes.length, 0);
  if (bytes > ANON_MAX_BYTES) {
    return { ok: false, reason: `Gönderim boyutu sınırı aşıldı (${megabytes(bytes)} MB > ${megabytes(ANON_MAX_BYTES)} MB).`, count: list.length, bytes, instances: [] };
  }
  return {
    ok: true,
    count: list.length,
    bytes,
    instances: list.map((i) => ({ name: i.name.slice(0, 120), data: toBase64(i.bytes) })),
  };
}

export const megabytes = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;

/** Sunucu tarafı doğrulama (istemciye güvenilmez). */
export function validateAnonStowBody(body: unknown): { ok: true; instances: { name: string; data: string }[] } | { ok: false; error: string } {
  const b = body as { instances?: unknown; studyUid?: string } | null;
  if (!b || !Array.isArray(b.instances)) return { ok: false, error: "instances dizisi gerekli" };
  if (!b.studyUid) return { ok: false, error: "studyUid gerekli (denetim kaydı için)" };
  if (b.instances.length === 0) return { ok: false, error: "Gönderilecek örnek yok" };
  if (b.instances.length > ANON_MAX_INSTANCES) return { ok: false, error: `En fazla ${ANON_MAX_INSTANCES} örnek` };
  const out: { name: string; data: string }[] = [];
  let total = 0;
  for (const raw of b.instances) {
    const it = raw as { name?: unknown; data?: unknown };
    if (typeof it?.data !== "string" || it.data.length === 0) return { ok: false, error: "Her örnek base64 'data' içermeli" };
    if (it.data.length > Math.ceil((ANON_MAX_BYTES / Math.max(1, b.instances.length)) * 1.5) + 1024) {
      return { ok: false, error: "Örnek boyutu sınırı aşıldı" };
    }
    total += Math.floor((it.data.length * 3) / 4);
    if (total > ANON_MAX_BYTES) return { ok: false, error: `Toplam boyut sınırı aşıldı (${megabytes(total)} MB)` };
    out.push({ name: typeof it.name === "string" ? it.name.slice(0, 120) : "anon.dcm", data: it.data });
  }
  return { ok: true, instances: out };
}

/** Toplu STOW sonucunu kullanıcıya özetler. */
export function summarizeAnonResult(results: { stored: number; failed: string[]; message?: string }[]): { stored: number; failed: number; ok: boolean; text: string } {
  const stored = results.reduce((s, r) => s + (r.stored || 0), 0);
  const failed = results.reduce((s, r) => s + (r.failed?.length ?? 0), 0);
  const ok = results.length > 0 && results.every((r) => (r.failed?.length ?? 0) === 0);
  return {
    stored,
    failed,
    ok,
    text: ok
      ? `${stored} anonim DICOM PACS'e gönderildi.`
      : `${stored} örnek gönderildi, ${failed} örnek reddedildi${results.find((r) => r.message)?.message ? ` (${results.find((r) => r.message)!.message})` : ""}.`,
  };
}

/**
 * e-stow seçim metaverisi: istemci «hangi kesit aralığını» göndermek istediğini bildirir.
 * Sunucu istemciye güvenmez ama PLANIN KENDİSİNİ doğrulayabilir: bildirilen aralığın
 * kesit sayısı, gelen örnek sayısına bire bir eşit olmalıdır — böylece seçim dışı
 * örnek gönderilmesi yapısal olarak engellenir. 1 tabanlı kapalı aralık.
 */
export interface AnonSelection { from: number; to: number; total: number }

export function parseAnonSelection(raw: unknown):
  | { ok: true; value: AnonSelection | null }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, error: "selection geçersiz (nesne bekleniyor)" };
  const r = raw as { from?: unknown; to?: unknown; total?: unknown };
  const from = Number(r.from), to = Number(r.to), total = Number(r.total);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(total)) {
    return { ok: false, error: "selection alanları sayısal olmalı" };
  }
  const f = Math.trunc(from), t = Math.trunc(to), tot = Math.trunc(total);
  if (f < 1 || t < f || tot < t || tot > 100_000) {
    return { ok: false, error: "selection aralığı geçersiz (1 ≤ from ≤ to ≤ total ≤ 100000)" };
  }
  return { ok: true, value: { from: f, to: t, total: tot } };
}

/** Bildirilen seçimle gelen örnek sayısı uyuşmuyorsa hata metni; uyuyorsa null. */
export function selectionInstanceCountError(sel: AnonSelection, count: number): string | null {
  const expected = sel.to - sel.from + 1;
  return count === expected
    ? null
    : `Seçim ${sel.from}–${sel.to} aralığını (${expected} kesit) bildirirken ${count} örnek gönderildi; istek reddedildi.`;
}

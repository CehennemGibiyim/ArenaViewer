/**
 * C-STORE (DIMSE) sözleşmesi — saf karar çekirdeği (DB/network'siz).
 *
 * Kıyaslama satırı `e-stow`'da kodda kanıtlanabilir kalan boşluk: STOW-RS
 * (DICOMweb) çalışıyor ama **C-STORE (DIMSE)** yoktu. Node içinde DIMSE TCP/PDU
 * yığını olmadığı için **sözleşme + köprü süreci** yaklaşımı benimsendi
 * (`mpps-bridge`/`hl7-mllp-server`/`fhir-pull` deseni):
 *
 *  - API (`/api/pacs/cstore`) C-STORE isteğini doğrular ve kuyruğa yazar,
 *  - köprü süreci (dcm4che `cstore-scu`) gerçeği DIMSE C-STORE'i konuşur ve
 *    her örnek için **durum kodu** raporunu geri getirir,
 *  - API durum koduları üzerinden sonucu sınıflandırır, yeniden deneme politikasını
 *    uygular, ilerleme/hata raporu üretir.
 *
 * Kurallar (dürüstlük):
 *  - **İçerik reddi** (0x0101 eşleşme yok, 0x0801 attribute hatası) yeniden
 *    denemEZ — PACS bu nesneyi kabul etmeyecek.
 *  - **Ağ/zaman aşımı/5xx/0x0102/0x0103/0x0105** yeniden denebilir.
 *  - Örnek bir kez kuyruğa girer (sha256+sopUid dedupe); deneme sınırı aşılırsa
 *    satır silinmez — görünür kalır (vazgeçildi işareti).
 *  - İlerleme gerçek öge durumları üzerinden hesaplanır (tahmin değil).
 */

/** DIMSE C-STORE durum kodları (PS3.7 Annex D.3.2). */
export const CSTORE_STATUS = {
  SUCCESS: 0x0000,
  NO_MATCHING_SOP: 0x0101,
  DUPLICATE_INVOCATION: 0x0102,
  INVOCATION_LIMIT: 0x0103,
  RESOURCE_LIMIT: 0x0105,
  SUBOPS_COMPLETE: 0x0210,
  SUBOPS_COMPLETE_WARNING: 0x0211,
  ATTRIBUTE_ERROR: 0x0801,
  PROCESSING_FAILURE: 0x0901,
} as const;

export type CstoreStatusCode = number;

export type CstoreStatusKind = "success" | "content-rejected" | "transient" | "unknown";

/** Durum kodu → sınıf (success hariç her şey sınıflandırılır). */
export function classifyCstoreStatus(code: number): CstoreStatusKind {
  if (code === CSTORE_STATUS.SUCCESS || code === CSTORE_STATUS.SUBOPS_COMPLETE) return "success";
  if (code === CSTORE_STATUS.SUBOPS_COMPLETE_WARNING) return "success";
  if (code === CSTORE_STATUS.NO_MATCHING_SOP || code === CSTORE_STATUS.ATTRIBUTE_ERROR) return "content-rejected";
  if (
    code === CSTORE_STATUS.DUPLICATE_INVOCATION ||
    code === CSTORE_STATUS.INVOCATION_LIMIT ||
    code === CSTORE_STATUS.RESOURCE_LIMIT ||
    code === CSTORE_STATUS.PROCESSING_FAILURE
  ) {
    return "transient";
  }
  return "unknown";
}

/** Durum kodu için insan gezinir etiket. */
export function cstoreStatusLabel(code: number): string {
  const map: Record<number, string> = {
    0x0000: "başarı",
    0x0101: "PACS eşleşmesi yok",
    0x0102: "yeniden çağrı",
    0x0103: "çağrı sınırı",
    0x0105: "kaynak sınırı",
    0x0210: "alt işlem tamam",
    0x0211: "alt işlem tamam (uyarı)",
    0x0801: "attribute hatası",
    0x0901: "işlem hatası",
  };
  return map[code] ?? `durum ${code}`;
}

/** Hata yeniden denenebilir mi? (içerik reddi kalıcı; ağ/5xx/transient tekrar denebilir) */
export function isRetryableCstoreError(code: number, message = ""): boolean {
  const kind = classifyCstoreStatus(code);
  if (kind === "success") return false;
  if (kind === "content-rejected") return false;
  if (/\(4(?!08|29)\d\d\)/.test(message ?? "")) return false;
  return true;
}

/** Tek C-STORE ögesi için talep meta verisi. */
export interface CstoreInstanceInput {
  name: string;
  /** DICOM baytları (base64) — köprü/istemden; API kuyruğa şifreli yazar. */
  data?: string;
  sopClassUid?: string;
  sopUid?: string;
  studyUid: string;
  seriesUid?: string;
  size?: number;
  sha256?: string;
}

export interface CstoreRequest {
  batchId: string;
  /** C-STORE hedefi: DIMSE AET'si + (köprü için) araştırma adresi. */
  target: { aet: string; host?: string; port?: number };
  instances: CstoreInstanceInput[];
}

export interface CstoreResultEntry {
  sopUid: string;
  /** 0x0000 = başarılı; diğerleri DIMSE durum kodu. */
  status: number;
  message?: string;
}

const isUid = (s: string) => /^[0-9]+(\.[0-9]+)*$/.test(s) && s.length <= 64;

/** UID biçimi +Study UID zorunluluğunu denetler (tahmin yok). */
export function validateCstoreInstance(it: CstoreInstanceInput): { ok: true } | { ok: false; error: string } {
  if (!it.name || !it.name.trim()) return { ok: false, error: "örnek adı boş" };
  if (!isUid(it.studyUid)) return { ok: false, error: `Study InstanceUID geçersiz: "${it.studyUid}"` };
  if (it.sopUid !== undefined && it.sopUid !== "" && !isUid(it.sopUid)) {
    return { ok: false, error: `SOP InstanceUID geçersiz: "${it.sopUid}"` };
  }
  if (it.sopClassUid !== undefined && it.sopClassUid !== "" && !isUid(it.sopClassUid)) {
    return { ok: false, error: `SOP ClassUID geçersiz: "${it.sopClassUid}"` };
  }
  return { ok: true };
}

/** Bir C-STORE isteğini doğrular + normalleştirir; hata → { ok:false }. */
export function validateCstoreRequest(body: unknown): { ok: true; request: CstoreRequest } | { ok: false; error: string } {
  const b = body as Partial<CstoreRequest> | null;
  if (!b || typeof b !== "object") return { ok: false, error: "C-STORE isteği JSON nesnesi değil" };
  if (!b.batchId || typeof b.batchId !== "string") return { ok: false, error: "batchId gerekli" };
  if (!b.target || typeof b.target !== "object" || !b.target.aet || !b.target.aet.trim()) {
    return { ok: false, error: "target.aet (DIMSE AET) gerekli" };
  }
  if (!Array.isArray(b.instances) || b.instances.length === 0) {
    return { ok: false, error: "instances boş olamaz" };
  }
  for (const it of b.instances) {
    const v = validateCstoreInstance(it);
    if (!v.ok) return { ok: false, error: v.error };
  }
  return {
    ok: true,
    request: {
      batchId: b.batchId,
      target: { aet: b.target.aet.trim(), host: b.target.host, port: b.target.port },
      instances: b.instances,
    },
  };
}

/** Kuyruğa eklenen öge için dedupe anahtarı (sha256+sopUid). */
export function cstoreDedupeKey(it: CstoreInstanceInput): string {
  return `${it.sha256 ?? ""}|${it.sopUid ?? ""}|${it.name}`;
}

/** Bir C-STORE isteğinin kuyruğa girecek ögelerini çıkarır (dedupe + sınır). */
export function planCstoreQueue(request: CstoreRequest, maxItems = 500): { accepted: CstoreInstanceInput[]; skipped: string[] } {
  const seen = new Set<string>();
  const accepted: CstoreInstanceInput[] = [];
  const skipped: string[] = [];
  for (const it of request.instances) {
    const key = cstoreDedupeKey(it);
    if (seen.has(key)) {
      skipped.push(it.name);
      continue;
    }
    seen.add(key);
    if (accepted.length >= maxItems) break;
    accepted.push(it);
  }
  return { accepted, skipped };
}

/** Yeniden deneme gecikmesi: 30 sn'den başlar, 1 saatte doygunlaşır. */
export function cstoreRetryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(30_000 * 2 ** n, 3_600_000);
}

/** Kaç denemeden sonra kuyruk ögesi vazgeçer (satır silinmez — görünür kalır). */
export const MAX_CSTORE_ATTEMPTS = 8;

/** Bir öge şimdi yeniden denenmeli mi? */
export function dueForCstoreRetry(row: { attempts: number; lastError: string; statusCode?: number }, lastAttemptAt: Date | string | null, now = Date.now()): boolean {
  if (row.attempts >= MAX_CSTORE_ATTEMPTS) return false;
  if (row.statusCode !== undefined && classifyCstoreStatus(row.statusCode) === "content-rejected") return false;
  if (!lastAttemptAt) return true;
  return now - new Date(lastAttemptAt).getTime() >= cstoreRetryDelayMs(row.attempts);
}

/** Kuyruk ögesi durumu. */
export type CstoreItemStatus = "pending" | "processing" | "done" | "failed";

export interface CstoreItemView {
  id: number;
  name: string;
  sopUid: string;
  studyUid: string;
  status: CstoreItemStatus;
  /** Son C-STORE durum kodu (0x0000 = başarılı). */
  statusCode: number;
  attempts: number;
  lastError: string;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

/** Bir ögenin tur sonucunu kaydet (saf fonksiyon). */
export function applyCstoreOutcome(item: CstoreItemView, result: CstoreResultEntry, now = new Date()): CstoreItemView {
  const failed = classifyCstoreStatus(result.status) !== "success";
  return {
    ...item,
    status: failed ? "failed" : "done",
    statusCode: result.status,
    attempts: item.attempts + 1,
    lastAttemptAt: now,
    lastError: failed ? `${cstoreStatusLabel(result.status)}: ${result.message ?? ""}`.trim() : "",
  };
}

/** Bir turun tasarlanan ögeleri: pending + süresi dolan yeniden-denemeli failed. */
export function planNextCstoreRound(items: CstoreItemView[], opts: { limit?: number; now?: number } = {}): CstoreItemView[] {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? Date.now();
  const pending = items.filter((i) => i.status === "pending");
  const due = items.filter(
    (i) => i.status === "failed" && i.lastError && isRetryableCstoreError(i.statusCode, i.lastError) && dueForCstoreRetry(i, i.lastAttemptAt, now)
  );
  return [...due, ...pending].slice(0, limit).map((i) => ({ ...i, status: "processing" as const }));
}

/** C-STORE sonucu raporu → öge durumları (gerçek durum kodları üzerinden). */
export function applyCstoreReport(items: CstoreItemView[], report: CstoreResultEntry[]): CstoreItemView[] {
  const byUid = new Map(items.map((i) => [i.sopUid, i]));
  return items.map((it) => {
    const r = report.find((x) => x.sopUid === it.sopUid);
    if (!r) return it; // raporda yok: durumu değiştirme
    return applyCstoreOutcome(it, r);
  });
}

export interface CstoreProgressSummary {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  percent: number;
  /** Başarısız ve yeniden denenebilir öge sayısı. */
  retryable: number;
}

/** İlerleme özeti: gerçek durumlar üzerinden, tahmin değil. */
export function cstoreProgressSummary(items: CstoreItemView[]): CstoreProgressSummary {
  const s: CstoreProgressSummary = { total: items.length, pending: 0, processing: 0, done: 0, failed: 0, percent: 0, retryable: 0 };
  for (const it of items) {
    if (it.status === "pending") s.pending++;
    else if (it.status === "processing") s.processing++;
    else if (it.status === "done") s.done++;
    else {
      s.failed++;
      if (isRetryableCstoreError(it.statusCode, it.lastError)) s.retryable++;
    }
  }
  s.percent = items.length ? Math.round(((s.done + s.failed) / items.length) * 100) : 0;
  return s;
}

/** Hata raporu: içerik reddi / geçici / bilinmeyen gruplarına ayrılır. */
export function buildCstoreErrorReport(items: CstoreItemView[]) {
  const groups = new Map<CstoreStatusKind, { kind: CstoreStatusKind; label: string; files: string[]; count: number }>();
  for (const it of items) {
    if (it.status !== "failed" || !it.lastError) continue;
    const kind = classifyCstoreStatus(it.statusCode) === "success" ? "unknown" : classifyCstoreStatus(it.statusCode);
    const label = kind === "content-rejected" ? "İçerik reddi" : kind === "transient" ? "Geçici (yeniden denebilir)" : "Bilinmeyen hata";
    const g = groups.get(kind) ?? { kind, label, files: [], count: 0 };
    g.count++;
    if (g.files.length < 50) g.files.push(it.name);
    groups.set(kind, g);
  }
  return [...groups.values()];
}

/** Kuyruğun arındırılmış görünümü (payload sızmaz). */
export function publicCstoreItem(item: CstoreItemView) {
  return {
    id: item.id,
    name: item.name,
    sopUid: item.sopUid,
    studyUid: item.studyUid,
    status: item.status,
    statusCode: item.statusCode,
    statusLabel: cstoreStatusLabel(item.statusCode),
    attempts: item.attempts,
    lastError: item.lastError,
    exhausted: item.attempts >= MAX_CSTORE_ATTEMPTS,
    createdAt: item.createdAt.toISOString(),
  };
}

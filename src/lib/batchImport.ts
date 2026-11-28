/**
 * Toplu/arka plan içe aktarma kuyruğu — saf karar çekirdeği (DB'siz).
 *
 * Kıyaslama satırı `f-batch`'te kodda kanıtlanabilir kalan boşluk: klasör/seri
 * toplu içe aktarma (tarayıcı) çalışıyor ama **arka plan kuyruğu, ilerleme
 * durumu, hata raporu ve yeniden deneme** yoktu. Bu modül kuyruğun karar
 * mantığını taşır; DB okuma/yazma `batchImportRepo.ts`'tedir. İstemci tarafı
 * asla buraya dokunmaz.
 *
 * Kurallar (dürüstlük):
 * - **Geçersiz DICOM** (parse hatası, desteklenmeyen biçim) yeniden denenmez —
 *   içerik sorunudur, tekrar deneme aynı cevabı verir.
 * - **Ağ/zaman aşımı/5xx/429** yeniden denenir; 4xx (kimlik/adres) kalıcı,
 *   yeniden deneme faydasız.
 * - Yinelemeden yanma: aynı `sha256` + isim kuyruğa bir kez girer (dedupe).
 * - Ilerleme % bireysel öge durumları üzerinden hesaplanır (tahmin değil).
 */

/** Bir kuyruk ögesi: dosya meta verileri (baytlar DB'de, burası karar). */
export interface BatchItemInput {
  name: string;
  size: number;
  sha256?: string;
  studyUid?: string;
  modality?: string;
}

export type BatchItemStatus = "pending" | "processing" | "done" | "failed";

/** Kuyruk ögesi arındırılmış görünüm. */
export interface BatchItemView {
  id: number;
  name: string;
  size: number;
  sha256: string;
  studyUid: string;
  modality: string;
  status: BatchItemStatus;
  attempts: number;
  lastError: string;
  lastAttemptAt: Date | null;
  createdAt: Date;
}

export interface BatchProgressSummary {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  /** Tamamlanan + başarısız öge oranı (0–100, tam sayı). */
  percent: number;
  /** Hata raporu grup sayısı (boş dizi = temiz). */
  errorGroups: number;
}

export interface BatchErrorGroup {
  kind: "invalid" | "network" | "rejected" | "unknown";
  label: string;
  /** Bu gruptaki hataları kaynaklı öge adları (en fazla 50). */
  files: string[];
  count: number;
}

/** Tek ögenin üretilen hata türünü sınıflandırır. */
export function classifyBatchError(message: string): BatchErrorGroup["kind"] {
  const m = message ?? "";
  if (/parse|DICOM dosyası|desteklenmeyen| biçim/i.test(m)) return "invalid";
  if (/reddetti|içerik|Failure Reason|0008,1198/i.test(m)) return "rejected";
  if (/zaman aşımı|timeout|bağlantı|ağ hatası|ECONN|ETIMEDOUT|5\d\d \(|429 \(|408 \(/i.test(m)) return "network";
  return "unknown";
}

/** Hata yeniden denenebilir mi? (içerik/4xx kalıcı; ağ/5xx/429 tekrar denebilir) */
export function isRetryableBatchError(message: string): boolean {
  const kind = classifyBatchError(message);
  if (kind === "invalid" || kind === "rejected") return false;
  if (/\((4(?!08|29)\d\d)\)/.test(message ?? "")) return false;
  return true;
}

/** Yeniden deneme gecikmesi: 20 sn'den başlar, 10 dk'da doygunlaşır. */
export function batchRetryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(20_000 * 2 ** n, 600_000);
}

/** Kaç denemeden sonra kuyruk ögesi vazgeçer (satır silinmez — görünür kalır). */
export const MAX_BATCH_ATTEMPTS = 6;

/** Bir öge şimdi yeniden denenmeli mi? (vazgeçilenler ve süresi gelmeyenler hariç) */
export function dueForBatchRetry(item: { attempts: number }, lastAttemptAt: Date | string | null, now = Date.now()): boolean {
  if (item.attempts >= MAX_BATCH_ATTEMPTS) return false;
  if (!lastAttemptAt) return true;
  return now - new Date(lastAttemptAt).getTime() >= batchRetryDelayMs(item.attempts);
}

/** Hata raporu etiketi (gürültülü metin → kısa etiket). */
export function batchErrorLabel(message: string): string {
  const kind = classifyBatchError(message);
  if (kind === "invalid") return "DICOM geçersiz/desteklenmeyen";
  if (kind === "rejected") return "İçerik reddi";
  if (kind === "network") return "Ağ/zaman aşımı";
  return "Bilinmeyen hata";
}

/** Kuyruğa eklenen ögeleri dedupe ve sınırla: aynı sha256+isim bir kez girer. */
export function planBatchImport(items: BatchItemInput[], opts: { maxItems?: number } = {}): { accepted: BatchItemInput[]; skippedDuplicates: string[] } {
  const maxItems = opts.maxItems ?? 2000;
  const seen = new Set<string>();
  const accepted: BatchItemInput[] = [];
  const skippedDuplicates: string[] = [];
  for (const it of items) {
    const name = (it.name ?? "").trim();
    if (!name) continue;
    const key = `${it.sha256 ?? ""}|${name}`;
    if (seen.has(key)) {
      skippedDuplicates.push(name);
      continue;
    }
    seen.add(key);
    if (accepted.length >= maxItems) break;
    accepted.push({ ...it, name });
  }
  return { accepted, skippedDuplicates };
}

/** Öge durum değişikliği (saf fonksiyon): pending → processing → done/failed. */
export function applyBatchItemOutcome(
  item: BatchItemView,
  outcome: "done" | "failed",
  now = new Date(),
  error = ""
): BatchItemView {
  return {
    ...item,
    status: outcome,
    attempts: item.attempts + 1,
    lastAttemptAt: now,
    lastError: outcome === "done" ? "" : error,
  };
}

/** Kuyruğun bir turu için tasarlanan ögeler: sıra pending → due failed. */
export function planNextBatchRound(items: BatchItemView[], opts: { limit?: number; now?: number } = {}): BatchItemView[] {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? Date.now();
  const pending = items.filter((i) => i.status === "pending");
  const due = items.filter((i) => i.status === "failed" && isRetryableBatchError(i.lastError) && dueForBatchRetry(i, i.lastAttemptAt, now));
  const ordered = [...due, ...pending].slice(0, limit);
  return ordered.map((i) => ({ ...i, status: "processing" as const }));
}

/** Ilerleme özeti: gerçek durumlar üzerinden, tahmin değil. */
export function batchProgressSummary(items: BatchItemView[]): BatchProgressSummary {
  const summary: BatchProgressSummary = {
    total: items.length,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    percent: 0,
    errorGroups: 0,
  };
  for (const it of items) {
    if (it.status === "pending") summary.pending++;
    else if (it.status === "processing") summary.processing++;
    else if (it.status === "done") summary.done++;
    else summary.failed++;
  }
  summary.percent = items.length ? Math.round(((summary.done + summary.failed) / items.length) * 100) : 0;
  summary.errorGroups = buildBatchErrorReport(items).length;
  return summary;
}

/** Hata raporu: hata türüne göre gruplanır, file isimleri listesinde görünür. */
export function buildBatchErrorReport(items: BatchItemView[]): BatchErrorGroup[] {
  const groups = new Map<BatchErrorGroup["kind"], BatchErrorGroup>();
  for (const it of items) {
    if (it.status !== "failed" || !it.lastError) continue;
    const kind = classifyBatchError(it.lastError);
    const g = groups.get(kind) ?? { kind, label: batchErrorLabel(it.lastError), files: [], count: 0 };
    g.count++;
    if (g.files.length < 50) g.files.push(it.name);
    groups.set(kind, g);
  }
  return [...groups.values()];
}

/** Hata raporu CSV satırı (küçük rapor/CLI için). */
export function batchErrorReportCsv(items: BatchItemView[]): string {
  const groups = buildBatchErrorReport(items);
  const rows = [`hata_turu;sayı;dosyalar`];
  for (const g of groups) rows.push(`${g.label};${g.count};${g.files.join("; ")}`);
  return rows.join("\n");
}

/** Kuyruğun toplama görünümü: payload/bayt sızdırmaz. */
export function publicBatchItem(item: BatchItemView) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    studyUid: item.studyUid,
    modality: item.modality,
    status: item.status,
    attempts: item.attempts,
    lastError: item.lastError,
    exhausted: item.attempts >= MAX_BATCH_ATTEMPTS,
    createdAt: item.createdAt.toISOString(),
  };
}

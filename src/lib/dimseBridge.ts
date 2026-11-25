/**
 * DIMSE köprüsü istemcisi (w-pacs) — C-FIND / C-MOVE'ın HTTP yüzü.
 *
 * Neden köprü: tarayıcı ya da Next.js sunucusu DICOM ağ protokolünü (TCP 104/11112,
 * A-ASSOCIATE, PDU) doğrudan konuşamaz; kurum içinde bu iş için küçük bir köprü
 * (dcm4che `dcmqrscp`/`findscu`+`movescu`, Orthanc `/dicom-web` yanında DIMSE,
 * veya kendi yazdığımız `scripts/mwl-cfind-proxy.ts`) çalışır. Bu modül köprünün
 * **sözleşmesini** tanımlar ve yanıtı doğrular; ağ çağrısı `fetch` üzerinden,
 * enjekte edilebilir taşıyıcıyla yapılır (testte ağa çıkmadan).
 *
 * Sözleşme (JSON):
 *   POST {bridge}/cfind  { level: "STUDY"|"SERIES"|"IMAGE", query: {…}, limit }
 *     → { results: [ { "00100020": {vr:"LO",Value:["…"]}, … } ], truncated?: boolean }
 *   POST {bridge}/cmove  { studyUid, seriesUid?, destinationAe, level? }
 *     → { accepted: boolean, subOperations: n, completed: n, failed: n, warnings: n }
 *
 * Köprü **hasta verisi** taşır; bu yüzden yalnız yapılandırılmış iç ağ adresine
 * izin verilir (https ya da açıkça izin verilmiş http) ve yanıt boyutu sınırlanır.
 */

/** Köprünün desteklediği sorgu düzeyleri. */
export type DimseLevel = "STUDY" | "SERIES" | "IMAGE";
export const DIMSE_LEVELS: DimseLevel[] = ["STUDY", "SERIES", "IMAGE"];

/** Yaygın DICOM etiketleri (köprü sorgusu için). */
export const TAGS = {
  patientName: "00100010",
  patientId: "00100020",
  studyDate: "00080020",
  modality: "00080060",
  studyDescription: "00081030",
  accession: "00080050",
  studyUid: "0020000D",
  seriesUid: "0020000E",
  seriesDescription: "0008103E",
  instanceUid: "00080018",
  instanceNumber: "00200013",
} as const;

export interface DimseQuery {
  level: DimseLevel;
  /** Etiket → değer (boş = joker/tekrar eden alanlar gönderilmez). */
  query: Record<string, string>;
  limit?: number;
}

export interface DimseResponse {
  /** DICOM JSON: etiket → {vr, Value[]}. */
  results: Record<string, unknown>[];
  truncated?: boolean;
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
};

/**
 * Köprü yanıtını doğrular: `results` dizisi ve her öğenin nesne olması şart.
 * Köprülerin çoğu DICOM JSON döndürür; bozuk yanıt sessizce boş listeye
 * dönüştürülmez — hata olarak bildirilir (klinik listede "boş" görünmesin).
 */
export function validateDimseResponse(raw: unknown): DimseResponse {
  if (!raw || typeof raw !== "object") throw new Error("Köprü yanıtı JSON nesnesi değil.");
  const o = raw as { results?: unknown; truncated?: unknown };
  if (!Array.isArray(o.results)) throw new Error("Köprü yanıtında 'results' dizisi yok.");
  const results = o.results.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (results.length !== o.results.length) throw new Error("Köprü yanıtında geçersiz satır(lar) var.");
  return { results, truncated: o.truncated === true };
}

/** DICOM JSON alanından ilk metin değeri. */
export function tagValue(row: Record<string, unknown>, tag: string): string {
  const f = row[tag] as { Value?: unknown[] } | undefined;
  const v = f?.Value?.[0];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    // PN/PN benzeri {"Alphabetic": "…"} ya da {"Value": "…"}
    const o = v as { Alphabetic?: string; Value?: string };
    return (o.Alphabetic ?? o.Value ?? "").trim();
  }
  return "";
}

export interface StudyRow {
  studyUid: string;
  patientId: string;
  patientName: string;
  studyDate: string;
  modality: string;
  description: string;
  accession: string;
}

/** C-FIND yanıtını çalışma satırlarına çevirir (UID'siz satırlar atlanır). */
export function toStudyRows(res: DimseResponse): StudyRow[] {
  const out: StudyRow[] = [];
  for (const r of res.results) {
    const studyUid = tagValue(r, TAGS.studyUid);
    if (!studyUid) continue;
    out.push({
      studyUid,
      patientId: tagValue(r, TAGS.patientId),
      patientName: tagValue(r, TAGS.patientName),
      studyDate: tagValue(r, TAGS.studyDate),
      modality: tagValue(r, TAGS.modality),
      description: tagValue(r, TAGS.studyDescription),
      accession: tagValue(r, TAGS.accession),
    });
  }
  return out;
}

/** Sorgu gövdesini üretir (boş değerler gönderilmez; limit 1–500). */
export function buildCfindBody(q: DimseQuery): { level: DimseLevel; query: Record<string, string>; limit: number } {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(q.query ?? {})) {
    const t = (v ?? "").trim();
    if (t) query[k] = t.slice(0, 64);
  }
  return { level: q.level, query, limit: Math.max(1, Math.min(500, q.limit ?? 100)) };
}

/** Tarih sorgusunu DICOM DA biçimine çevirir ("2026-01-15" / "20260115" → "20260115"). */
export function toDicomDate(s: string): string {
  const d = (s ?? "").replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(d) ? d : "";
}

/**
 * C-FIND çağrısı. Köprü yoksa `null` döner (çağıran DICOMweb'e düşebilir).
 * HTTP hatası Türkçe ve ayırt edilebilir mesaja çevrilir (kimlik mi, yol mu?).
 */
export async function cfind(
  bridgeUrl: string,
  q: DimseQuery,
  opts: { transport?: Transport; timeoutMs?: number; allowHttp?: boolean } = {},
): Promise<StudyRow[] | null> {
  const url = joinUrl(bridgeUrl, "cfind");
  if (!url) return null;
  assertAllowed(url, opts.allowHttp);
  const body = JSON.stringify(buildCfindBody(q));
  const transport = opts.transport ?? defaultTransport;
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? 30_000) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/timeout|abort/i.test(msg) ? "DIMSE köprüsü zaman aşımına uğradı." : `DIMSE köprüsüne ulaşılamadı: ${msg.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(friendlyDimseStatus(res.status));
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error("DIMSE köprüsü geçerli JSON döndürmedi.");
  }
  return toStudyRows(validateDimseResponse(raw));
}

/** HTTP durumunu okunur mesaja çevirir. */
export function friendlyDimseStatus(status: number): string {
  if (status === 401 || status === 403) return `DIMSE köprüsü yetki hatası (${status}) — köprünün kimlik bilgisini kontrol edin.`;
  if (status === 404) return `DIMSE köprüsü yolu bulunamadı (404) — köprü adresini kontrol edin.`;
  if (status === 408 || status === 504) return `DIMSE köprüsü zaman aşımı (${status}) — PACS yanıt vermedi.`;
  if (status >= 500) return `DIMSE köprüsü sunucu hatası (${status}).`;
  return `DIMSE köprüsü isteği başarısız (${status}).`;
}

export interface CMoveResult {
  accepted: boolean;
  subOperations: number;
  completed: number;
  failed: number;
  warnings: number;
}

/**
 * C-MOVE (PACS → hedef AE). Yalnız **çalışma/seri** düzeyinde izin verilir;
 * görüntü düzeyinde tek tek taşıma köprüde genelde kapalıdır.
 * `destinationAe` AE Title 1–16 karakter (DICOM).
 */
export function validateMove(req: { destinationAe: string; studyUid: string; seriesUid?: string }): string | null {
  const ae = (req.destinationAe ?? "").trim();
  if (!/^[A-Za-z0-9 _-]{1,16}$/.test(ae)) return "Hedef AE Title 1–16 karakter olmalı (harf, rakam, boşluk, _ -).";
  if (!/^[0-9]+(\.[0-9]+)*$/.test(req.studyUid ?? "")) return "Çalışma UID geçersiz.";
  if (req.seriesUid !== undefined && req.seriesUid !== "" && !/^[0-9]+(\.[0-9]+)*$/.test(req.seriesUid)) return "Seri UID geçersiz.";
  return null;
}

export async function cmove(
  bridgeUrl: string,
  req: { studyUid: string; seriesUid?: string; destinationAe: string },
  opts: { transport?: Transport; timeoutMs?: number; allowHttp?: boolean } = {},
): Promise<CMoveResult | null> {
  const url = joinUrl(bridgeUrl, "cmove");
  if (!url) return null;
  const bad = validateMove(req);
  if (bad) throw new Error(bad);
  assertAllowed(url, opts.allowHttp);
  const transport = opts.transport ?? defaultTransport;
  const res = await transport(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      studyUid: req.studyUid,
      seriesUid: req.seriesUid ?? "",
      destinationAe: req.destinationAe.trim(),
      level: req.seriesUid ? "SERIES" : "STUDY",
    }),
    signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? 120_000) : undefined,
  });
  if (!res.ok) throw new Error(friendlyDimseStatus(res.status));
  const raw = (await res.json().catch(() => null)) as Partial<CMoveResult> | null;
  if (!raw || typeof raw !== "object") throw new Error("C-MOVE yanıtı geçersiz.");
  return {
    accepted: raw.accepted === true,
    subOperations: Number(raw.subOperations ?? 0) || 0,
    completed: Number(raw.completed ?? 0) || 0,
    failed: Number(raw.failed ?? 0) || 0,
    warnings: Number(raw.warnings ?? 0) || 0,
  };
}

/** Köprü kökü + yol (çift eğik çizgi olmadan). */
export function joinUrl(base: string, path: string): string {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  if (!b) return "";
  return `${b}/${path.replace(/^\/+/, "")}`;
}

/**
 * Adres güvenliği: hasta verisi taşıyan köprüye yalnız http(s) ve (varsayılan)
 * https ya da açıkça izin verilmiş http ile gidilir; kimlik bilgisi URL'de olamaz.
 */
export function assertAllowed(url: string, allowHttp = true): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Köprü adresi geçersiz: ${url}`);
  }
  if (u.username || u.password) throw new Error("Köprü adresinde kullanıcı/şifre olamaz — kimlik ayrı yapılandırılır.");
  if (u.protocol === "https:") return;
  if (u.protocol === "http:") {
    if (!allowHttp) throw new Error("Köprü için https gerekir (http yalnızca açıkça izin verilirse).");
    return;
  }
  throw new Error(`Desteklenmeyen protokol: ${u.protocol}`);
}

/** Köprü sağlık kontrolü (yönetici "test" düğmesi): GET {bridge}/health → {ok, aeTitle?, version?}. */
export async function bridgeHealth(
  bridgeUrl: string,
  opts: { transport?: Transport; timeoutMs?: number; allowHttp?: boolean } = {},
): Promise<{ ok: boolean; message: string; aeTitle?: string; version?: string }> {
  const url = joinUrl(bridgeUrl, "health");
  if (!url) return { ok: false, message: "Köprü adresi boş." };
  assertAllowed(url, opts.allowHttp);
  const transport = opts.transport ?? defaultTransport;
  try {
    const r = await transport(url, { method: "GET", headers: {}, body: "", signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? 8000) : undefined });
    if (!r.ok) return { ok: false, message: friendlyDimseStatus(r.status) };
    const raw = (await r.json().catch(() => ({}))) as { aeTitle?: string; version?: string };
    return { ok: true, message: "Köprü yanıt veriyor.", aeTitle: raw.aeTitle, version: raw.version };
  } catch (e) {
    return { ok: false, message: `Köprüye ulaşılamadı: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}

/** Yönetici kartı için sorgu şablonları (hangi düzeyde ne sorulur). */
export const CFIND_TEMPLATES: { label: string; q: DimseQuery }[] = [
  { label: "Bugünün çalışmaları", q: { level: "STUDY", query: { [TAGS.studyDate]: "TODAY" }, limit: 100 } },
  { label: "Hasta kimliğiyle", q: { level: "STUDY", query: { [TAGS.patientId]: "…" }, limit: 50 } },
  { label: "Erişim numarasıyla", q: { level: "STUDY", query: { [TAGS.accession]: "…" }, limit: 20 } },
  { label: "Çalışmanın serileri", q: { level: "SERIES", query: { [TAGS.studyUid]: "…" }, limit: 200 } },
];

/**
 * HBYS/RIS sonuç çekimi sözleşmesi — HL7 v2 ORU^R01 + FHIR DiagnosticReport (d-followup).
 *
 * Takip önerileri (`followupQueue.ts`) açık görevleri, HBYS/RIS'ten çekilen sonuca
 * pas edecek şekilde tasarlandı: bir `ReturnedResult` (rapor kimliği → çalışma
 * UID → tek modalite/bölge aday) açık görevi belirlirse `matchReturnedResult`,
 * belirsizse eşleşme YAPILMAZ. Bu dosya çekim afişinin **saf karar çekirdeği**
 * olacak: ayrıştırma, dedupe, eşleme planı ve kapatma planı fonksiyonlar; DB
 * ve HTTP olarak dışarıda.
 *
 * Köprü süreçleri:
 *  - HL7 MLLP sunucusu (`scripts/hl7-mllp-server.ts`) ORU^R01 alır → `resultFromHl7`
 *    ile `Hl7ResultPayload` → `/api/his/results` (push).
 *  - FHIR çekim köprüsü (`scripts/result-pull.ts`) DiagnosticReport serilerini
 *    çeker → `diagnosticReportToResult` → `/api/his/results` (push).
 */

import type { ParsedHl7 } from "@/lib/hl7";
import type { FollowupTask, ReturnedResult } from "@/lib/followupQueue";
import { closeWithOutcome, matchReturnedResult } from "@/lib/followupQueue";
import type { FhirResource } from "@/lib/fhirIn";
import { guessModalityText, modalityFromFhir } from "@/lib/fhirIn";

const asObj = (v: unknown): FhirResource => (v && typeof v === "object" ? (v as FhirResource) : {});
const asArr = (v: unknown): FhirResource[] => (Array.isArray(v) ? (v as FhirResource[]) : []);
const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** HL7 ORU^R01 → çıkarılan sonuç yükü. */
export interface Hl7ResultPayload {
  patientId: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  /** Sonuç metni (OBX-5). */
  text: string;
  at?: string;
  sourceType: string;
}

/** FHIR DiagnosticReport → çıkarılan sonuç yüku (HL7 ile aynı çizgide). */
export interface FhirResultPayload {
  patientId: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  text: string;
  at?: string;
  /** DiagnosticReport → ImagingStudy referansı (çalışma UID eşlemesi için). */
  studyUid?: string;
  fhirSource: string;
  warnings: string[];
}

/** Kuyruğa yazılacak sonuç kaydı (çift arşiv; hem HL7'den hem FHIR'den gelir). */
export type ResultSource = "hl7" | "fhir";

export interface ResultRecordInput {
  source: ResultSource;
  patientId: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  text: string;
  at?: string;
  studyUid?: string;
  fhirSource?: string;
}

/** Kuyruk öge görünümü (DB'den döndürülen kayıt). */
export interface ResultItemView {
  id: number;
  batchId: string;
  source: ResultSource;
  patientId: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  text: string;
  at: string;
  studyUid: string;
  fhirSource: string;
  status: "pending" | "matched" | "unmatched" | "closed";
  matchedTaskId: number;
  createdAt: Date;
}

/** Sonuç çekimi yapılandırması (FHIR köprü için). */
export interface ResultPullConfig {
  baseUrl: string;
  token: string;
  username: string;
  password: string;
  timeoutMs: number;
  defaultModality: string;
}

export const DEFAULT_RESULT_PULL: ResultPullConfig = {
  baseUrl: "",
  token: "",
  username: "",
  password: "",
  timeoutMs: 15000,
  defaultModality: "",
};

/** Çekim yapılandırmasını doğrular; hata metni boş string = geçerli. */
export function validateResultConfig(cfg: ResultPullConfig): string | null {
  if (!cfg.baseUrl || !/^https?:\/\//i.test(cfg.baseUrl)) return "FHIR_URL http(s) URL olmalıdır";
  if (!cfg.token && !cfg.username) return "FHIR_TOKEN veya FHIR_USER+FHIR_PASSWORD gerekir";
  return null;
}

/** ORU^R01'den sonuç yükü çıkarır; gereken alanlar eksikse null. */
export function resultFromHl7(msg: ParsedHl7): Hl7ResultPayload | null {
  const seg = (name: string) => msg.segments.find((s) => s.name === name);
  const pid = seg("PID");
  const obr = seg("OBR");
  const comp = (s: string, i: number) => (s && s.split("^")[i] !== undefined ? s.split("^")[i].trim() : "");

  const patientId = comp(pid?.fields[3] ?? "", 0) || "";
  const accessionNumber = (obr?.fields[2] ?? "").trim();
  // OBR-4 (universal service identifier): "CT^CT TORAKSI^LN" — modalite kodu.
  const universalDesc = (obr?.fields[4] ?? "").trim();
  const modality = modalityFromFhir(universalDesc.split("^")[1] ?? universalDesc)
    || guessModalityFromText(universalDesc)
    || "";
  // OBR-16: examination body part ("Göğüs").
  const bodyPart = (obr?.fields[16] ?? "").trim();
  const description = (obr?.fields[13] ?? "").trim() || universalDesc;

  // Sonuç metni: ilk OBX-5 (text observation); çoklu OBX varsa ilki kullanılır.
  const obx = msg.segments.filter((s) => s.name === "OBX");
  const text = (obx[0]?.fields[5] ?? "").trim();

  // OBR-7 (sont zamanı); HL7 tarih YYYYMMDDHHMMSS → ISO.
  const rawDate = ((obr?.fields[7] ?? "") || (obr?.fields[6] ?? "")).trim().replace(/[^0-9]/g, "");
  let at: string | undefined;
  if (rawDate.length >= 8) {
    const y = rawDate.slice(0, 4), m = rawDate.slice(4, 6), d = rawDate.slice(6, 8);
    const hh = rawDate.slice(8, 10) || "00", mm = rawDate.slice(10, 12) || "00";
    at = `${y}-${m}-${d}T${hh}:${mm}:00`;
  }

  if (!patientId || !accessionNumber || !text) return null;
  return { patientId, accessionNumber, modality, bodyPart, description, text, ...(at ? { at } : {}), sourceType: msg.type || "HL7" };
}

/** ORU^R01'den modalite tahmini (kodu tanınmazsa metinden). */
function guessModalityFromText(text: string): string {
  const m = /(?:^|[^a-z])((?:CT|MR|MG|US|CR|DX|PT|PET|NM|RF|XA|DS|BI|FL|RM|TG|ES)\b)/i.exec(text ?? "");
  return m ? m[1].toUpperCase() : "";
}

/** FHIR DiagnosticReport → sonuç yükü; zorunlu alanlar eksikse null. */
export function diagnosticReportToResult(dr: FhirResource): FhirResultPayload | null {
  const warnings: string[] = [];
  const subject = asObj(dr.subject);
  const identifiers = asArr(subject.identifier);
  const pid = asStr(identifiers[0]?.value);

  const ids = asArr(dr.identifier);
  let accessionNumber = "";
  for (const id of ids) {
    if (/accession/i.test(asStr(id.system))) {
      accessionNumber = asStr(id.value);
      break;
    }
  }
  if (!accessionNumber) accessionNumber = asStr(ids[0]?.value) || `FHIR-DR-${asStr(dr.id) || "sonuc"}`;

  const code = asObj(dr.code);
  const modality = modalityFromFhir(asArr(code.coding), (w) => warnings.push(w)) || guessModalityText(asStr(code.text));
  const conclusion = asStr(dr.conclusion ?? dr.conclusionText);
  if (!conclusion) {
    warnings.push("DiagnosticReport.conclusion yok — sonuç metni boş, sonuç reddedildi.");
    return null;
  }

  // ImagingStudy referansı → çalışma UID (referans sonundaki kimlik).
  let studyUid = "";
  const imgRef = asStr(asObj(dr.imagingStudy)?.reference);
  if (imgRef) {
    studyUid = imgRef.split("#")[1] ?? imgRef.split("/").pop() ?? "";
  }

  const effective = asStr(dr.effectiveDateTime) || asStr(asObj(dr.effectivePeriod)?.start);
  return {
    patientId: pid || `FHIR-${asStr(dr.id) || "patient"}`,
    accessionNumber,
    modality,
    bodyPart: asStr(code.text),
    description: asStr(code.text) || "DiagnosticReport (FHIR)",
    text: conclusion,
    ...(effective ? { at: effective } : {}),
    ...(studyUid ? { studyUid } : {}),
    fhirSource: `DiagnosticReport/${asStr(dr.id)}`,
    warnings,
  };
}

/** Çekilen bir sonuç → `ReturnedResult` (eşleme sözleşmesi). */
export function toReturnedResult(r: ResultRecordInput): ReturnedResult {
  const numeric = Number(r.accessionNumber);
  return {
    reportId: Number.isFinite(numeric) && /^[0-9]+$/.test(r.accessionNumber) ? numeric : null,
    studyUid: r.studyUid || "",
    modality: r.modality,
    bodyRegion: r.bodyPart,
    text: r.text,
    at: r.at,
  };
}

/** Kuyruk öge → eşleme sözleşmesi (DB kayıt形式u). */
export function resultItemToReturned(r: ResultItemView): ReturnedResult {
  return toReturnedResult({
    source: r.source,
    patientId: r.patientId,
    accessionNumber: r.accessionNumber,
    modality: r.modality,
    bodyPart: r.bodyPart,
    description: r.description,
    text: r.text,
    at: r.at,
    studyUid: r.studyUid,
    fhirSource: r.fhirSource,
  });
}

/**
 * Dedupe anahtarı: rapor kimliği + çalışma UID + sonuç metni çini.
 * Aynı Accession + aynı metinซ้ำ çekildiğinde kuyruğa yeniden yazılmaz.
 */
export function resultDedupeKey(r: { accessionNumber: string; studyUid?: string; text: string }): string {
  const base = `${r.accessionNumber}|${r.studyUid ?? ""}|${r.text.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  return base;
}

/** Kuyruğa yazılacak ögeleri planlar: dedupe + zorunlu alan kontrolü. */
export function planResultQueue(
  inputs: ResultRecordInput[]
): { accepted: ResultRecordInput[]; skipped: string[] } {
  const accepted: ResultRecordInput[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const r of inputs) {
    if (!r.accessionNumber.trim() || !r.text.trim()) {
      skipped.push(`${r.accessionNumber || "(accession)"}: accessionNumber/text gerekli`);
      continue;
    }
    const key = resultDedupeKey(r);
    if (seen.has(key)) {
      skipped.push(`${r.accessionNumber}: tekrarlayan sonuç (dedupe)`);
      continue;
    }
    seen.add(key);
    accepted.push(r);
  }
  return { accepted, skipped };
}

/** Kuyruk öge görünümü → dedupe anahtarı. */
export function resultViewDedupeKey(r: ResultItemView): string {
  return resultDedupeKey({ accessionNumber: r.accessionNumber, studyUid: r.studyUid, text: r.text });
}

/** Bir sonuç çekimi turu için eşleme planı. */
export interface ResultMatchPlan {
  /** Sonuç → kapatılan görev (eşleşti). */
  matches: { item: ResultItemView; task: FollowupTask; reason: string }[];
  /** Eşleşmeyen sonuçlar (açık görev belirsiz/yok). */
  unmatched: ResultItemView[];
}

/** Kuyruk ögelerini açık takip görevlerine eşler (belirsizse eşleşme YAPILMAZ). */
export function planResultMatches(items: ResultItemView[], tasks: FollowupTask[]): ResultMatchPlan {
  const matches: ResultMatchPlan["matches"] = [];
  const unmatched: ResultItemView[] = [];
  const closedIds = new Set<number>();
  for (const item of items) {
    if (item.status === "closed") {
      unmatched.push(item);
      continue;
    }
    const match = matchReturnedResult(resultItemToReturned(item), tasks);
    if (!match.task || closedIds.has(match.task.id)) {
      unmatched.push(item);
      continue;
    }
    closedIds.add(match.task.id);
    matches.push({ item, task: closeWithOutcome(match.task, resultItemToReturned(item)), reason: match.reason });
  }
  return { matches, unmatched };
}

/** Çekim özeti (kuyruk geneli). */
export function resultPullSummary(items: ResultItemView[]) {
  const matched = items.filter((i) => i.status === "matched" || i.status === "closed").length;
  const pending = items.filter((i) => i.status === "pending").length;
  const unmatched = items.filter((i) => i.status === "unmatched").length;
  return { total: items.length, matched, pending, unmatched };
}

/** Sonuç metni (kuyruk öge) → denetim/raporlama için kısa özet. */
export function resultTextSummary(text: string, max = 120): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}


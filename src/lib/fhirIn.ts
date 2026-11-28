/**
 * FHIR R4 girişi çekirdek sözleşmesi — `src/lib/fhir.ts` yalnız FHIR **çıktı** (DiagnosticReport)
 * üretiyordu; bu modül **giriş** yönünü taşır: `ServiceRequest` (sipariş) ve
 * `ImagingStudy` (çalışma) kaynaklarından ArenaViewer'ın sipariş yükünü çıkarır.
 *
 * Boşluk belirlemede edilmiyen kurallar:
 * - Yetersiz bilgi **reddedilir**, tahmin ile doldurulmaz (`null`).
 * - `patient.identifier` oyunu: sistem belirtilmediyse FHIR sisteminin
 *   `http://terminology.hl7.org/CodeSystem/v2-0074` olmayacağı, ID+accession
 *   MPI/RIS sisteminden çalışmak için `identifier.system` ile söylenir.
 * - `StudyInstanceUID` FHIR'de `imagingStudy.imagingStudyUid` yerine
 *   `identifier[urn:dicom:uid]`'dedir; geçerli UID güvenilerek MWL'de kullanılacak
 *   StudyInstanceUID yine de `studyUid` adıyla taşınır (eski MWL köprüsü ile uyum).
 * - Modalite kodu MTI'ye gitmez; `ServiceRequest.code.text`/coding-code'dan veya
 *   ImagingStudy `modality` kodundan ayrıştırılır; bilinmeyen kod "OT" olamaz —
 *   boş bırakılır ve uyarı üretilir.
 *
 * Saf fonksiyonlar: DB, fetch, `next/headers` yok — testler Node içinde çalışır.
 */

export type FhirResource = Record<string, unknown>;

/** Sipariş/çalışma çıkarılması için birlikte gidebilerek zenginleştirilmiş sipariş yükü. */
export interface FhirOrderPayload {
  patientId: string;
  patientName: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  studyDate?: string;
  studyUid: string;
  /** FHIR kaynağı (ServiceRequest.id / ImagingStudy.id); eşleme için tutulabilir. */
  fhirSource: string;
  /** Eşleştirme/uyarılar; boş dizi = temiz. */
  warnings: string[];
}

const PRIMER = "http://terminology.hl7.org/CodeSystem/v2-0074";
const DICOM_UID_SYSTEM = "urn:dicom:uid";

const asObj = (v: unknown): FhirResource => (v && typeof v === "object" ? (v as FhirResource) : {});
const asArr = (v: unknown): FhirResource[] => (Array.isArray(v) ? (v as FhirResource[]) : []);
const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Reference tipini («Type#id») parçalar; yalnız 《id》 kısmı döndürülür. */
export function fhirReferenceId(ref: unknown): string {
  return asStr(ref).split("#")[0].split("/")[1] ?? asStr(ref);
}

/** FHIR `patient.identifier`'lerden eklerilik kimlik arıyor. */
export function patientIdentifier(patient: FhirResource, warn?: (w: string) => void): string {
  for (const id of asArr(patient.identifier)) {
    const value = asStr(id.value);
    if (!value) continue;
    const system = asStr(id.system).replace(/\/$/, "");
    // Bilinen sistemler tek başına kesindir; bilmeyen sistemler ikazla çalışır
    // (kurum kendi EPIC/MPI sistemini `fhir.patient.identifier.system` ile söylemeli).
    if (!system || system === PRIMER || system === "urn:oid:2.16.840.1.113883.19.5") return value;
    if (warn) warn(`Hasta kimlik sistemi "${system}" tanınmıyor; yine de kullanılıyor (kurum sistemi olabilir).`);
    return value;
  }
  return "";
}

/** FHIR patient → desteklendiği kadar doldurulan {patientId, patientName}. */
export function patientFromFhir(patient: FhirResource, warn?: (w: string) => void): { patientId: string; patientName: string } {
  const pid = patientIdentifier(patient, warn);
  // FHIR HumanName: [{ given: [...], family: "..." }] — "GIVEN FAMILY" veya family.
  const nameParts: string[] = [];
  for (const n of asArr(patient.name)) {
    for (const g of asArr(n.given)) nameParts.push(asStr(g));
    if (asStr(n.family)) nameParts.push(asStr(n.family));
  }
  const name = nameParts.filter(Boolean).join(" ");
  return {
    patientId: pid,
    patientName: name || pid,
  };
}

/** FHIR tarih/saat → `YYYYMMDD`; başlatılabilir kısmı siler; geçersizse boş. */
export function fhirToStudyDate(dt: unknown): string {
  const s = asStr(dt);
  if (!s) return "";
  // ISO 8601 (2026-03-14T…, trailing timezone/extension ile) veya kompakt (20260314).
  const compact = s.startsWith("20") && /^20\d{2}[-]?\d{2}[-]?\d{2}/.test(s)
    ? s.slice(0, 10).replace(/-/g, "")
    : s.replace(/[^0-9]/g, "").slice(0, 8);
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(compact);
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt2 = new Date(Date.UTC(y, mo - 1, d));
  if (dt2.getUTCFullYear() !== y || dt2.getUTCMonth() !== mo - 1 || dt2.getUTCDate() !== d) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

const MODALITY_CODES = new Set([
  "CT", "MR", "MG", "US", "CR", "DX", "PT", "NM", "PET", "OT", "BI", "DO", "DS",
  "FL", "LC", "RM", "RF", "TG", "XA", "ES", "NM", "US", "MR", "CT", "MG", "CR",
  "DX", "PT", "PET", "RF", "XA", "OT", "BI", "DO", "DS", "FL", "LC", "RM", "TG", "ES",
]);

/** FHIR modalite kodu → DICOM modalite kodu; bilinmeyen kodu **boş** bırakır (tahmin yok). */
export function modalityFromFhir(value: unknown, warn?: (w: string) => void): string {
  if (Array.isArray(value)) {
    for (const coding of asArr(value)) {
      const code = asStr(coding.code);
      if (!code) continue;
      if (MODALITY_CODES.has(code.toUpperCase())) return code.toUpperCase();
      if (warn) warn(`Modalite kodu "${code}" tanınmıyor; modalite boş bırakıldı.`);
    }
    return "";
  }
  const code = asStr(value);
  if (!code) return "";
  if (MODALITY_CODES.has(code.toUpperCase())) return code.toUpperCase();
  if (warn) warn(`Modalite kodu "${code}" tanınmıyor; modalite boş bırakıldı.`);
  return "";
}

/** FHIR `code.text` gibi metinlerden modalite adayını bir önceki adımdan arama. */
export function guessModalityText(text: string): string {
  const m = /(?:^|[^a-z])((?:CT|MR|MG|US|CR|DX|PT|PET|NM|RF|XA|DS|BI|FL|RM|TG|ES)\b)/i.exec(text ?? "");
  if (!m) return "";
  return m[1].toUpperCase();
}

/** ServiceRequest → sipariş yükü; gereken alanlar eksikse null. */
export function serviceRequestToOrder(sr: FhirResource): FhirOrderPayload | null {
  const warnings: string[] = [];
  const patient = asObj(sr.patient);
  const pid = patientIdentifier(patient, (w) => warnings.push(w));
  if (!pid) {
    warnings.push("ServiceRequest.patient.identifier yok — hasta kimliği yok, sipariş reddedildi.");
    return null;
  }
  const accIdent = asArr(sr.identifier);
  const accession = asStr(accIdent.find((id) => asStr(id.value))?.value);
  const code = asObj(sr.code);
  let modality = modalityFromFhir(code.coding, (w) => warnings.push(w));
  if (!modality) {
    const fromText = guessModalityText(asStr(code.text));
    modality = fromText;
    if (!fromText) warnings.push("ServiceRequest.code.coding/text'te modalite kodu yok.");
  }
  const bodySite = asArr(sr.bodySite);
  const bodyPart = asStr(asObj(bodySite[0])?.text) || asStr(asObj(bodySite.find((b) => asStr(b?.text)))?.text);
  const desc = asStr(code.text) || `${modality} çalışması (FHIR)`;
  const occ = asObj(sr.occurrencePeriod);
  const studyDate = fhirToStudyDate(sr.occurrenceDateTime ?? occ.start);
  const source = asStr(sr.id) || asStr(accIdent[0]?.value);
  if (!accession || !modality) {
    warnings.push("ServiceRequest'te accessionNumber veya modalite eksik — sipariş reddedildi.");
    return null;
  }
  return {
    patientId: pid,
    patientName: patientFromFhir(patient).patientName || pid,
    accessionNumber: accession,
    modality,
    bodyPart,
    description: desc,
    ...(studyDate ? { studyDate } : {}),
    studyUid: `fhir.${accession}`,
    fhirSource: `ServiceRequest/${source}`,
    warnings,
  };
}

/**
 * ImagingStudy → sipariş yükü. FHIR'de ImagingStudy'de StudyInstanceUID bir
 * `identifier`'dir; bu yüzden `identifier[urn:dicom:uid]`'den **kesin** UID'ni çıkarır.
 * Yoksa `imagingStudyUid` açık olmayı denemesi; en son fallback `study.${accession}`.
 */
export function imagingStudyToOrder(img: FhirResource, accession = ""): FhirOrderPayload | null {
  const warnings: string[] = [];
  const patient = asObj(img.subject);
  const pid = patientIdentifier(patient, (w) => warnings.push(w));
  if (!pid) {
    warnings.push("ImagingStudy.subject.identifier yok — hasta kimliği yok, çalışma reddedildi.");
    return null;
  }
  const ids = asArr(img.identifier);
  let uid = "";
  for (const id of ids) {
    if (asStr(id.system).replace(/\/$/, "") === DICOM_UID_SYSTEM) {
      uid = asStr(id.value);
      break;
    }
  }
  if (!uid) uid = asStr(img.imagingStudyUid);
  const accId = ids.find((i) => /accession/i.test(asStr(i.system)) || !/^[0-9.]+$/.test(asStr(i.value)));
  const accessionNum = accession || asStr(accId?.value) || asStr(ids[0]?.value);
  if (!uid) {
    warnings.push("ImagingStudy.identifier[urn:dicom:uid] yok ve imagingStudyUid boş — çalışma reddedildi.");
    return null;
  }
  const modality = modalityFromFhir(img.modality, (w) => warnings.push(w));
  const code = asObj(img.code);
  const bodySite = asArr(img.bodySite);
  const bodyPart = asStr(asObj(bodySite[0])?.text) || asStr(code.text);
  const studyDate = fhirToStudyDate(img.startedDateTime ?? img.started);
  return {
    patientId: pid,
    patientName: patientFromFhir(patient).patientName || pid,
    accessionNumber: accessionNum || "FHIR-IMAGING",
    modality: modality || "OT",
    bodyPart,
    description: asStr(code.text) || `${modality || "IMAGING"} (FHIR)`,
    ...(studyDate ? { studyDate } : {}),
    studyUid: uid,
    fhirSource: `ImagingStudy/${asStr(img.id)}`,
    warnings,
  };
}

/**
 * FHIR `Bundle`'den sipariş/çalışma kaynaklarını çıkarır.
 * `searchParams.type=ServiceRequest` / `type=ImagingStudy`'de `entry[].resource`
 * kullanımıyla hem `Bundle` hem tek kaynak bireysel eleman olarak kabul edilir.
 */
export function fhirResourcesToOrders(body: unknown): FhirOrderPayload[] {
  const out: FhirOrderPayload[] = [];
  const push = (res: FhirResource) => {
    if (res.resourceType === "ServiceRequest") {
      const o = serviceRequestToOrder(res);
      if (o) out.push(o);
    } else if (res.resourceType === "ImagingStudy") {
      const o = imagingStudyToOrder(res);
      if (o) out.push(o);
    }
  };
  if (!body || typeof body !== "object") return out;
  const bundle = asObj(body);
  if (bundle.resourceType === "Bundle") {
    for (const entry of asArr(bundle.entry)) push(asObj(entry.resource));
  } else {
    push(bundle);
  }
  return out;
}

/**
 * Bir `ServiceRequest` ile kendi `ImagingStudy`'i birleştirir: UID ve erişim numarası
 * ImagingStudy'den, modalite/ad/vücut parçası ServiceRequest'ten gelir; warning'ler birleşir.
 */
export function mergeFhirPair(sr: FhirResource, img: FhirResource): FhirOrderPayload | null {
  const base = serviceRequestToOrder(sr);
  const srAcc = asArr(sr.identifier);
  const imgOrder = imagingStudyToOrder(img, asStr(srAcc.find((id) => asStr(id.value))?.value));
  if (!base) return imgOrder;
  if (!imgOrder) return base;
  return {
    ...base,
    studyUid: imgOrder.studyUid,
    accessionNumber: imgOrder.accessionNumber || base.accessionNumber,
    warnings: [...base.warnings, ...imgOrder.warnings],
  };
}

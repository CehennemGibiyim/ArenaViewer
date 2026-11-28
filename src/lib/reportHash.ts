/**
 * Rapor snapshot'ı için ölçüm / SR hash'leri (r-version).
 *
 * Rapor snapshot'ı gizlenen-kapsamı tedavi eder: sürüm geçmişi geri yüklendiğinde
 * klinik dışı metin (technique, impression, recommendation) geri gelir, ama
 * ölçümler ve DICOM SR metni snapshot'ta saklanmazdı — onlar sadece frontend
 * durumdaydı. Bu modül, save sırasında ölçüm metninin ve üretilecek SR metninin
 * SHA-256'sını snapshot'a yansıtır; bu sayede:
 *   - eski snapshot'ın hangi ölçüm/SR içeriğine karşılık geldiği belirlenebilir
 *    (özellik parola gibi `matchesMeasurementHash` / `matchesSrHash` ile kontrol edilir);
 *   - restore sonrası SR yeniden üretilirken kayıp olup olmadığını kontrol etmek
 *     mümkündür (`srRebuiltMatches`).
 *
 * Hash'ler saf metin tabanlıdır: ölçümler `measurementsText` şemasına uygun
 * metinden, SR ise `buildReportSr` çıktısından türetilir. Eski snapshot'larda
 * bu alanlar tanımlı değildir (toleranslıdır); ancak yeni sürümler her zaman
 * bu hash'leri içerir.
 */
import { createHash } from "crypto";

export interface ReportHashInput {
  /** Ekran ölçümlerinden türetilmiş metin (Workstation'ta `ÖLÇÜMLER` başlığıyla findingsText'e eklenir) */
  measurementsText?: string;
  /** Gizlenen-kapsam SR üretmek için gereken içerik */
  technique?: string;
  findingsText?: string;
  impression?: string;
  recommendation?: string;
  /** SR'ye dahil edilen ölçüm metni */
  srMeasurementsText?: string;
  /** SR üretimi için ek klinik bilgi (client'tan gelir; zorunlu değil) */
  clinicalInfo?: string;
}

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

/** Ölçüm metnini normalize eder (tırnak/boşluk variasyonları tek biçime indirir). */
export function normalizeMeasurementsText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Ölçüm metni → SHA-256 (boş metin → sabit boş hash, ancak ölçüm metni tanımlı ise içerik hash'i). */
export function measurementHash(measurementsText: string | undefined | null): string {
  if (measurementsText === undefined || measurementsText === null) return "";
  return sha256(normalizeMeasurementsText(measurementsText));
}

/**
 * Report SR metni → SHA-256.
 *
 * SR byte'ları restore sırasında client tarafından yeniden üretildiği için
 * byte-level hash tutarsız olurdu; bunun yerine **SR içerik hash'i** üretiriz:
 * SR'ye giren tüm metinlerin (clinicalInfo, technique, findings, impression,
 * recommendation, measurements) normalize edilmiş JSON temsiline dayanır.
 * Aynı içerikle üretilen SR her zaman aynı hash'e sahip olur; snapshot'ta SR
 * metni saklanmadığı için bu hash, "hangi içerikle üretilecek SR eşleşiyor"
 * sorusunu yanıtlar ve restore sonrası tutarlı kalır.
 */
export function srHashOf(input: ReportHashInput): string {
  const measurementsText = normalizeMeasurementsText(input.srMeasurementsText ?? input.measurementsText ?? "");
  const payload = {
    clinicalInfo: (input.clinicalInfo ?? "").replace(/\r/g, " ").trim(),
    technique: (input.technique ?? "").replace(/\r/g, " ").trim(),
    findings: (input.findingsText ?? "").replace(/\r/g, " ").trim(),
    impression: (input.impression ?? "").replace(/\r/g, " ").trim(),
    recommendation: (input.recommendation ?? "").replace(/\r/g, " ").trim(),
    measurements: measurementsText,
  };
  return sha256(JSON.stringify(payload));
}

/** Snapshot'taki ölçüm hash'i, kaydedilen ölçüm metniyle eşleşiyor mu? */
export function matchesMeasurementHash(snapshotHash: unknown, measurementsText: string | undefined | null): boolean {
  if (typeof snapshotHash !== "string" || snapshotHash.length === 0) return false;
  const current = measurementHash(measurementsText);
  return current !== "" && snapshotHash === current;
}

/** Snapshot'taki SR hash'i, yeniden üretilen SR metniyle eşleşiyor mu? */
export function matchesSrHash(snapshotHash: unknown, input: ReportHashInput): boolean {
  if (typeof snapshotHash !== "string" || snapshotHash.length === 0) return false;
  return snapshotHash === srHashOf(input);
}

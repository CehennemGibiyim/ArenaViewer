/**
 * MPPS — Modality Performed Procedure Step (e-hl7-mwl).
 *
 * Neden gerekli: MWL yalnız "bu iş **yapılacak**" bilgisini verir. Cihaz işi
 * bitirdiğinde MPPS ile "yapıldı" der; RIS bunu görmezse çalışma listede
 * **sonsuza dek "bekliyor"** kalır ve iş listesi şişer. Bu modül MPPS
 * N-CREATE (durum = IN PROGRESS) ve N-SET (durum = COMPLETED/DISCONTINUED)
 * mesajlarının **DICOM JSON sözleşmesini** üretir/ayrıştırır.
 *
 * Kapsam sınırı (dürüstçe): DIMSE (TCP/PDU) yığını Node içinde değildir; bu
 * modül DICOMweb/JSON köprüsüne verilecek yükü üretir. Köprü süreci
 * `scripts/mpps-bridge.ts`, DIMSE'yi konuşan kurum ağ geçidine (ör. dcm4che
 * `mpps-scu`) devreder.
 *
 * Etiket numaraları DICOM standardındandır; `dicom-parser`/DICOMweb JSON'da
 * anahtar "(gggg,eeee)" biçimidir.
 */

export type MppsStatus = "IN PROGRESS" | "COMPLETED" | "DISCONTINUED";

export interface MppsStudyRef {
  /** (0020,000D) Study Instance UID */
  studyUid: string;
  /** (0008,0050) Accession Number */
  accession: string;
  /** (0040,1001) Requested Procedure ID */
  requestedProcedureId?: string;
  /** (0008,0060) Modality */
  modality: string;
  /** (0010,0010)/(0010,0020) hasta — kimlik eşleşmesi için */
  patientName?: string;
  patientId?: string;
}

export interface MppsCreateInput extends MppsStudyRef {
  /** (0040,0253) Performed Procedure Step ID — cihaz üretir */
  performedProcedureStepId: string;
  /** (0040,0244) başlangıç tarihi YYYYMMDD */
  startDate?: string;
  /** (0040,0245) başlangıç saati HHMMSS */
  startTime?: string;
  /** (0008,0090) isteyen hekim */
  referringPhysician?: string;
  /** (0040,0007)/(0008,1030) tanım */
  description?: string;
  /** (0040,0241) Performed Station AE Title — cihazın AET'si */
  stationAet?: string;
}

export interface MppsSetInput {
  /** (0008,0110)≥(0008,1155) / MPPS örneğinin UID'si */
  mppsUid: string;
  status: Exclude<MppsStatus, "IN PROGRESS">;
  /** (0040,0254) yapılan işlem adı */
  description?: string;
  /** (0040,0250) bitiş tarihi */
  endDate?: string;
  /** (0040,0251) bitiş saati */
  endTime?: string;
  /** (0040,0340) üretilen seriler */
  performedSeriesUids?: string[];
  /** (0040,0280) yorum / iptal gerekçesi */
  comments?: string;
}

/** Bariz UID biçim hatalarını yakalar (nokta ayraçlı, 1..64 karakter, 0-9). */
export function isValidUid(uid: string): boolean {
  if (!uid || uid.length > 64) return false;
  if (!/^\d+(\.\d+)*$/.test(uid)) return false;
  if (uid.startsWith("0") || uid.includes("..") || uid.endsWith(".")) return false;
  return uid.split(".").every((p) => p.length >= 1 && p.length <= 20);
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const now = () => new Date().toISOString().slice(11, 19).replace(/:/g, "");

/**
 * (0040,0252) Performed Procedure Step Status. DICOM'da bu alan
 * `IN PROGRESS` / `COMPLETED` / `DISCONTINUED` değerlerini alır.
 */
export function mppsStatusTag(status: MppsStatus): { vr: "CS"; Value: string[] } {
  return { vr: "CS", Value: [status] };
}

/** N-CREATE yükü (DICOM JSON). `ScheduledStepAttributesSequence` ile MWL bağlanır. */
export function buildMppsCreate(input: MppsCreateInput): Record<string, unknown> {
  if (!isValidUid(input.studyUid)) throw new Error(`Geçersiz Study Instance UID: ${input.studyUid}`);
  if (!input.performedProcedureStepId) throw new Error("Performed Procedure Step ID zorunlu (0040,0253)");
  const tags: Record<string, unknown> = {
    "00080060": { vr: "CS", Value: [input.modality] }, // Modality
    "00080050": { vr: "SH", Value: [input.accession] }, // Accession Number
    "0020000D": { vr: "UI", Value: [input.studyUid] }, // Study Instance UID
    "00400253": { vr: "SH", Value: [input.performedProcedureStepId] },
    "00400244": { vr: "DA", Value: [input.startDate ?? today()] },
    "00400245": { vr: "TM", Value: [input.startTime ?? now()] },
    "00400252": mppsStatusTag("IN PROGRESS"),
    "00400270": {
      // (0040,0270) Scheduled Step Attributes Sequence — MWL öğesine köprü.
      // Dikkat: (0040,0275) Request Attributes Sequence'dur; karıştırılırsa
      // MWL bağı hiç kurulmaz ve MPPS yanlış çalışmaya bağlanır.
      vr: "SQ",
      Value: [
        {
          "00080050": { vr: "SH", Value: [input.accession] },
          "0020000D": { vr: "UI", Value: [input.studyUid] },
          "00401001": { vr: "SH", Value: [input.requestedProcedureId ?? input.accession] },
          ...(input.patientId ? { "00100020": { vr: "LO", Value: [input.patientId] } } : {}),
          ...(input.patientName ? { "00100010": { vr: "PN", Value: [{ Alphabetic: input.patientName }] } } : {}),
        },
      ],
    },
  };
  if (input.description || input.requestedProcedureId) {
    tags["00400254"] = { vr: "LO", Value: [input.description ?? input.requestedProcedureId!] }; // Performed Procedure Step Description
  }
  if (input.referringPhysician) tags["00080090"] = { vr: "PN", Value: [{ Alphabetic: input.referringPhysician }] };
  // (0008,0061) Institution Code Sequence'dir (SQ) — istasyon AET'si DEĞİL.
  // AET (0040,0241)'dir; yanlış etiket cihaz eşleşmesini bozar.
  if (input.stationAet) tags["00400241"] = { vr: "AE", Value: [input.stationAet] };
  return tags;
}

/**
 * N-SET yükü. `COMPLETED` için bitiş zamanı **zorunludur** (DICOM ret kuralı:
 * tamamlanmış bir adımın bitiş zamanı yoksa iş listesi "süresiz" görünür).
 */
export function buildMppsSet(input: MppsSetInput): Record<string, unknown> {
  if (!isValidUid(input.mppsUid)) throw new Error(`Geçersiz MPPS UID: ${input.mppsUid}`);
  if (input.status !== "COMPLETED" && input.status !== "DISCONTINUED") {
    throw new Error(`N-SET durumu COMPLETED/DISCONTINUED olmalı, gelen: ${String(input.status)}`);
  }
  if (input.status === "DISCONTINUED" && !input.comments) {
    throw new Error("DISCONTINUED için gerekçe (0040,0280) zorunlu");
  }
  const tags: Record<string, unknown> = {
    "00400252": mppsStatusTag(input.status),
    "00400250": { vr: "DA", Value: [input.endDate ?? today()] },
    "00400251": { vr: "TM", Value: [input.endTime ?? now()] },
  };
  if (input.description) tags["00400254"] = { vr: "LO", Value: [input.description] };
  if (input.comments) tags["00400280"] = { vr: "LT", Value: [input.comments] };
  if (input.performedSeriesUids?.length) {
    tags["00400340"] = {
      // Performed Series Sequence
      vr: "SQ",
      Value: input.performedSeriesUids.filter(isValidUid).map((uid) => ({ "0020000E": { vr: "UI", Value: [uid] } })),
    };
  }
  return tags;
}

export interface MppsReadResult {
  status: MppsStatus | "";
  mppsUid: string;
  accession: string;
  studyUid: string;
  /** COMPLETED/DISCONTINUED ama bitiş zamanı yok → çalışma "süresiz sürüyor" görünür. */
  warnings: string[];
}

const first = (tags: Record<string, unknown>, tag: string): string => {
  const v = tags[tag] as { Value?: unknown[] } | undefined;
  const x = v?.Value?.[0];
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && "Alphabetic" in (x as Record<string, unknown>)) return String((x as { Alphabetic: string }).Alphabetic);
  return "";
};

/** Cihazdan/köprüden gelen MPPS olayını okur (N-CREATE/N-SET yanıtı). */
export function readMppsResponse(tags: Record<string, unknown>, mppsUid: string): MppsReadResult {
  const status = first(tags, "00400252").toUpperCase() as MppsStatus | "";
  // ScheduledStepAttributesSequence içinden erişim/çalışma UID'si
  const sq = (tags["00400270"] as { Value?: Record<string, unknown>[] } | undefined)?.Value?.[0] ?? {};
  const out: MppsReadResult = {
    status,
    mppsUid,
    accession: first(tags, "00080050") || first(sq, "00080050"),
    studyUid: first(tags, "0020000D") || first(sq, "0020000D"),
    warnings: [],
  };
  if (!["IN PROGRESS", "COMPLETED", "DISCONTINUED"].includes(status)) out.warnings.push(`Beklenmeyen MPPS durumu: ${status || "(boş)"}`);
  if (status === "COMPLETED" && !first(tags, "00400251")) out.warnings.push("COMPLETED ama bitiş saati (0040,0251) yok");
  if (status === "DISCONTINUED" && !first(tags, "00400280")) out.warnings.push("DISCONTINUED ama gerekçe (0040,0280) yok");
  if (!out.studyUid) out.warnings.push("Study Instance UID yok — çalışmaya bağlanamaz");
  return out;
}

/** MPPS durumu → ArenaViewer çalışma durumu. Bilinmeyen durum **değiştirilmez**. */
export function workStatusFor(status: MppsStatus | ""): "okunuyor" | "bekliyor" | "onayli" | null {
  switch (status) {
    case "IN PROGRESS": return "okunuyor";
    case "COMPLETED": return "bekliyor"; // görüntü okunmayı bekliyor
    case "DISCONTINUED": return null; // iptal edilen iş çalışma listesine düşmez
    default: return null;
  }
}

/**
 * MPPS olayının çalışmaya **etkisini** saflaştırır (DB yok): yalnız karar.
 * Kurallar:
 *  - onaylı ("onayli") çalışma MPPS ile geri alınmaz (imzalı rapor bozulmaz),
 *  - DISCONTINUED çalışmayı işaretlemez, çalışma listesine düşürmez,
 *  - bilinmeyen durum hiçbir şey değiştirmez.
 */
export function decideMppsEffect(
  currentWorkStatus: string,
  ev: MppsReadResult,
): { apply: boolean; workStatus: string; reason: string } {
  const next = workStatusFor(ev.status);
  if (next === null) {
    return {
      apply: false,
      workStatus: currentWorkStatus,
      reason: ev.status === "DISCONTINUED" ? "Adım iptal (DISCONTINUED) — çalışma oluşturulmadı" : `Uygulanamayan MPPS durumu: ${ev.status || "(boş)"}`,
    };
  }
  if (currentWorkStatus === "onayli") {
    return { apply: false, workStatus: currentWorkStatus, reason: "Çalışma onaylı — MPPS durumu değiştirilmedi" };
  }
  if (currentWorkStatus === next) {
    return { apply: false, workStatus: next, reason: `Durum zaten ${next} — yinelenen bildirim` };
  }
  return { apply: true, workStatus: next, reason: `${ev.status} → ${next}` };
}

/**
 * Cihaz aynı adımı iki kez bildirirse (yeniden gönderim) ikinci N-CREATE
 * reddedilmelidir; aksi hâlde çift kayıt/çift zaman damgası oluşur.
 */
export function mppsIdempotency(existing: { status: MppsStatus; updatedAt: number } | undefined, status: MppsStatus, nowMs = Date.now(), windowMs = 120_000): "accept" | "duplicate" | "conflict" {
  if (!existing) return "accept";
  if (existing.status === status && nowMs - existing.updatedAt < windowMs) return "duplicate";
  if (existing.status === "COMPLETED" && status === "IN PROGRESS") return "conflict";
  return "accept";
}

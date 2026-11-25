/**
 * HL7 v2 ADT (hasta idari) mesajları — e-hl7-mwl.
 *
 * MWL akışında iki gerçek sorun vardır ve ikisi de ADT'den gelir:
 *   1. **ADT^A08** — hasta demografisi güncellenir (ad, doğum tarihi, cinsiyet).
 *      Çalışma listesi eski adı göstermeye devam ederse yanlış hastaya işlem
 *      yapılabilir; güncelleme iş listesine yansıtılmalıdır.
 *   2. **ADT^A40** — iki hasta kaydı birleştirilir (MRG segmenti). Birleşen
 *      kimliğin açık siparişleri/çalışmaları hedef kimliğe taşınmalıdır; aksi
 *      halde aynı hasta iki kayıt olarak görünür ve iş listesinde mükerrer olur.
 *
 * Saf fonksiyonlar: ayrıştırma + uygulanabilirlik kararı. Veritabanı işlemi
 * çağıranda (`/api/his/mwl` `action=adt`).
 */

import { parseHl7, type ParsedHl7 } from "./hl7";

export type AdtEvent = "A08" | "A40" | "A01" | "A31" | "diger";

export interface AdtPatient {
  patientId: string;
  patientName: string;
  birthDate?: string;
  sex?: string;
  accessionNumber?: string;
}

export interface AdtMessage {
  event: AdtEvent;
  trigger: string;
  /** A40/A18 gibi birleştirmelerde birleşen (eski) kimlik */
  mergedPatientId?: string;
  patient: AdtPatient;
  warnings: string[];
  /** MSH-10: ACK eşleştirmesi için */
  controlId: string;
}

const comp = (s: string, i: number): string => {
  const parts = (s ?? "").split("^");
  return parts[i] !== undefined ? parts[i].trim() : "";
};

/** HL7 DA (YYYYMMDD) → ISO tarih; geçersizse undefined (uydurma yok). */
export function hl7Date(raw: string): string | undefined {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  if (d.length < 8) return undefined;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

/** ADT mesajını ayrıştırır; yeterli kimlik yoksa null (işlem yapılmaz). */
export function adtFromHl7(msg: ParsedHl7): AdtMessage | null {
  const seg = (n: string) => msg.segments.find((s) => s.name === n);
  const pid = seg("PID");
  const mrg = seg("MRG");
  if (!pid) return null;

  const patientId = comp(pid.fields[3] ?? "", 0);
  if (!patientId) return null;

  const warnings: string[] = [];
  const trigger = (msg.trigger || msg.type.split("^")[1] || "").toUpperCase();
  const event: AdtEvent = ["A08", "A40", "A01", "A31"].includes(trigger) ? (trigger as AdtEvent) : "diger";

  const family = comp(pid.fields[5] ?? "", 0);
  const given = comp(pid.fields[5] ?? "", 1);
  const patientName = `${given} ${family}`.trim();
  if (!patientName) warnings.push("PID-5 (ad soyad) boş; eski ad korunur.");
  const birthDate = hl7Date(pid.fields[7] ?? "");
  if ((pid.fields[7] ?? "").trim() && !birthDate) warnings.push("PID-7 doğum tarihi okunamadı; yazılmaz.");
  const sexRaw = (pid.fields[8] ?? "").trim().toUpperCase();
  const sex = ["M", "F", "O", "U"].includes(sexRaw) ? sexRaw : undefined;
  if (sexRaw && !sex) warnings.push(`PID-8 cinsiyet kodu tanınmadı (${sexRaw.slice(0, 4)}); yazılmaz.`);

  const accession = comp((seg("PV1")?.fields[19] ?? ""), 0) || (pid.fields[18] ?? "").trim();

  let mergedPatientId: string | undefined;
  if (event === "A40") {
    const candidate = comp(mrg?.fields[1] ?? "", 0);
    if (!candidate) {
      warnings.push("ADT^A40 ama MRG-1 (birleşen kimlik) boş — birleştirme uygulanmaz.");
    } else if (candidate === patientId) {
      warnings.push("MRG-1 ile PID-3 aynı; birleştirme anlamsız (yok sayılır).");
    } else {
      mergedPatientId = candidate;
    }
  }

  return {
    event,
    trigger: trigger || "diger",
    mergedPatientId,
    patient: { patientId, patientName, birthDate, sex, accessionNumber: accession || undefined },
    warnings,
    controlId: msg.messageControlId,
  };
}

/** Ham metinden ADT; HL7 değilse null. */
export function parseAdt(raw: string): AdtMessage | null {
  const msg = parseHl7(raw);
  return msg ? adtFromHl7(msg) : null;
}

export interface AdtApplyPlan {
  ok: boolean;
  action: "guncelle" | "birlestir" | "yok-say" | "reddet";
  /** Uygulanacak kimlik (birleştirmede hedef) */
  patientId?: string;
  /** Birleştirmede taşınacak eski kimlik */
  fromPatientId?: string;
  /** Yazılacak alanlar (yalnız dolu olanlar) */
  changes: Partial<Pick<AdtPatient, "patientName" | "birthDate" | "sex">>;
  warnings: string[];
  reason: string;
}

/**
 * ADT'yi uygulanabilir plana çevirir. **Boş alan mevcut değeri silmez**;
 * birleştirmede hedef kimlik yoksa işlem yapılmaz.
 */
export function planAdt(msg: AdtMessage | null, existing?: { patientName?: string } | null): AdtApplyPlan {
  if (!msg) return { ok: false, action: "reddet", changes: {}, warnings: [], reason: "ADT mesajı ayrıştırılamadı (PID-3 eksik veya HL7 değil)." };
  if (msg.event === "A40") {
    if (!msg.mergedPatientId) {
      return { ok: false, action: "reddet", changes: {}, warnings: msg.warnings, reason: "A40 için birleşen kimlik (MRG-1) gerekli." };
    }
    // Hedef kayıt sistemde olmalı; yoksa birleştirme yazılmaz.
    if (!existing) {
      return { ok: false, action: "reddet", changes: {}, warnings: msg.warnings, reason: `Hedef hasta kaydı bulunamadı (${msg.patient.patientId}); birleştirme yapılmadı.` };
    }
    return {
      ok: true,
      action: "birlestir",
      patientId: msg.patient.patientId,
      fromPatientId: msg.mergedPatientId,
      changes: {},
      warnings: msg.warnings,
      reason: `${msg.mergedPatientId} kaydı ${msg.patient.patientId} ile birleştirilecek.`,
    };
  }
  if (msg.event === "diger") {
    return { ok: true, action: "yok-say", changes: {}, warnings: msg.warnings, reason: `ADT^${msg.trigger} bu akışta işlenmiyor (yalnız A08/A40/A01/A31).` };
  }
  const changes: AdtApplyPlan["changes"] = {};
  if (msg.patient.patientName && msg.patient.patientName !== existing?.patientName) changes.patientName = msg.patient.patientName;
  if (msg.patient.birthDate) changes.birthDate = msg.patient.birthDate;
  if (msg.patient.sex) changes.sex = msg.patient.sex;
  const n = Object.keys(changes).length;
  return {
    ok: true,
    action: n ? "guncelle" : "yok-say",
    patientId: msg.patient.patientId,
    changes,
    warnings: msg.warnings,
    reason: n ? `${n} alan güncellenecek (${Object.keys(changes).join(", ")}).` : "Değişen alan yok; yazma yapılmaz.",
  };
}

/** ADT ACK'i (AA/AR/AE) — MLLP çerçeveli. */
export function adtAck(msg: ParsedHl7, plan: AdtApplyPlan, buildAck: (m: ParsedHl7, c: "AA" | "AR" | "AE", t: string) => string): string {
  return plan.ok ? buildAck(msg, "AA", plan.reason) : buildAck(msg, "AE", plan.reason);
}

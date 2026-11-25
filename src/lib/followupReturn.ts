/**
 * Takip iadesi alımı — HL7 ORU^R01 ve FHIR DiagnosticReport (d-followup).
 *
 * Klinik bağlam: takip önerisi açılan hastanın **dönen sonucu** HBYS/RIS'ten
 * gelir. `followupQueue.matchReturnedResult` eşleştirmeyi yapar; eksik parça
 * iadenin **kendisini ayrıştırmaktı**. Bu modül:
 *
 *   1. HL7 ORU^R01 → `ReturnedResult` (hasta/erişim/çalışma UID, modalite,
 *      rapor metni: OBX gözlemleri + OBX yoksa OBR açıklaması).
 *   2. FHIR DiagnosticReport (R4) → `ReturnedResult` (identifier, imagingStudy,
 *      conclusion/presentedForm).
 *   3. Eşleştirme + kapatma kararı: belirsiz eşleşme **otomatik kapatılmaz**;
 *      yanıt bunu "hekim seçmeli" olarak döndürür.
 *
 * Güvenlik: iade metni 4000 karakterle sınırlanır, hasta kimliği denetim
 * gövdesine yazılmaz, eksik/kirli alanlar sessizce uydurulmaz (boş döner).
 */

import { parseHl7 } from "./hl7";
import { closeWithOutcome, matchReturnedResult, type FollowupTask, type ReturnedResult } from "./followupQueue";

const MAX_TEXT = 4000;

const comp = (s: string, i: number): string => {
  const parts = (s ?? "").split("^");
  return parts[i] !== undefined ? parts[i].trim() : "";
};

/** HL7 zaman damgası (YYYYMMDD[HHMM[SS]]) → ISO; okunamazsa undefined. */
export function hl7Timestamp(raw: string): string | undefined {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  if (d.length < 8) return undefined;
  const y = d.slice(0, 4), mo = d.slice(4, 6), day = d.slice(6, 8);
  const hh = d.slice(8, 10) || "00", mi = d.slice(10, 12) || "00", ss = d.slice(12, 14) || "00";
  const iso = `${y}-${mo}-${day}T${hh}:${mi}:${ss}`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

export interface ReturnParse {
  ok: boolean;
  result: ReturnedResult | null;
  /** Ayrıştırma uyarıları (kullanıcıya gösterilir) */
  warnings: string[];
  /** Kaynak biçimi */
  format: "hl7-oru" | "fhir-diagnosticreport" | "bilinmiyor";
}

/**
 * HL7 ORU^R01 (veya OBX içeren başka bir mesaj) → iade sonucu.
 * OBX-5 değerleri birleştirilir; OBX yoksa OBR-4/OBR-13 açıklaması kullanılır.
 */
export function parseOru(raw: string): ReturnParse {
  const msg = parseHl7(raw);
  if (!msg) return { ok: false, result: null, warnings: ["HL7 mesajı ayrıştırılamadı (MSH satırı yok veya bozuk)."], format: "bilinmiyor" };
  const warnings: string[] = [];
  const seg = (n: string) => msg.segments.find((s) => s.name === n);
  const pid = seg("PID"), obr = seg("OBR");
  const obx = msg.segments.filter((s) => s.name === "OBX");

  const patientId = comp(pid?.fields[3] ?? "", 0);
  // Erişim numarası: filler (OBR-3) önce, sonra placer (OBR-2). Rapora bağlanmış
  // sayısal kimlik varsa rapor kimliği olarak kullanılır; değilse uyarı verilir.
  const filler = (obr?.fields[3] ?? "").trim();
  const placer = (obr?.fields[2] ?? "").trim();
  const accession = filler || placer;
  const modality = guessModalityHl7(obr, obx);

  const obsText = obx
    .map((s) => {
      // OBX-3 gözlem tanımlayıcısı, OBX-5 değer
      const id = comp(s.fields[3] ?? "", 1) || comp(s.fields[3] ?? "", 0);
      const value = (s.fields[5] ?? "").trim();
      if (!value) return "";
      return id ? `${id}: ${value}` : value;
    })
    .filter(Boolean)
    .join(" | ");
  // OBX-5 birden çok satıra bölünmüşse (devam segmentleri) sırayla birleştirilir.
  const joined = obx.map((s) => (s.fields[5] ?? "").trim()).filter(Boolean).join(" ");
  const fallback = comp(obr?.fields[4] ?? "", 1) || (obr?.fields[13] ?? "").trim();
  const text = (obsText || fallback || joined).slice(0, MAX_TEXT);

  // Zaman: OBR-7 (gözlem) → OBR-22 (sonuç bildirimi) → OBX-14. Yalnız gerçek
  // tarih biçimindeki alanlar denenir; UID gibi sayı dizileri zaman sanılmaz.
  const dateCandidate = [
    obr?.fields[7],
    obr?.fields[21],
    obx[0]?.fields[14],
    obr?.fields[6],
  ].find((v) => hl7Timestamp(v ?? "") !== undefined);
  const at = dateCandidate ? hl7Timestamp(dateCandidate) : undefined;

  // Çalışma UID'si standart OBR alanında değildir; RIS'ler OBR-4/OBR-21/Z
  // segmentlerinde taşır. DICOM UID biçimindeki (noktalı, 4+ parça) ilk değer
  // alınır — **tahmin edilmez**, yalnız desende aranır.
  const oidRe = /^\d+(\.\d+){3,}$/;
  const oidFields: string[] = [];
  for (const segName of ["OBR", "ZDS", "OBX"]) {
    for (const sg of msg.segments.filter((x) => x.name === segName)) {
      for (const f of sg.fields) oidFields.push(f.trim());
    }
  }
  const studyUid = oidFields.find((f) => oidRe.test(f)) ?? "";

  if (!text) warnings.push("Rapor metni bulunamadı (OBX-5 / OBR-4 boş).");
  if (!patientId) warnings.push("Hasta kimliği (PID-3) boş.");
  if (!accession) warnings.push("Erişim numarası (OBR-2/OBR-3) boş; eşleştirme modalite/bölgeye kalır.");

  // Erişim numarası yalnız kısa ve sayısal ise rapor kimliği sayılır (bazı
  // RIS'ler erişim numarasını rapor kimliği olarak kullanır).
  const idCandidate = /^\d{1,9}$/.test(accession) ? Number(accession) : null;
  if (!idCandidate && accession) warnings.push(`Erişim numarası "${accession.slice(0, 20)}" sayısal rapor kimliği değil; eşleştirme çalışma UID/modaliteye kalır.`);
  if (!studyUid) warnings.push("Çalışma UID'si mesajda bulunamadı; eşleştirme rapor kimliği/modaliteye kalır.");

  const result: ReturnedResult = {
    studyUid: studyUid || undefined,
    modality: modality || undefined,
    text,
    at,
    reportId: idCandidate,
  };
  return { ok: text.length > 0, result: text.length > 0 ? result : null, warnings, format: "hl7-oru" };
}

function guessModalityHl7(obr: { fields: string[] } | undefined, obx: { fields: string[] }[]): string {
  const src = [obr?.fields[4] ?? "", obr?.fields[13] ?? "", ...obx.map((o) => o.fields[3] ?? "")].join(" ").toLocaleUpperCase("tr-TR");
  if (/CT|BT|TOMOGRAF/.test(src)) return "CT";
  if (/MR|REZONANS/.test(src)) return "MR";
  if (/US|ULTRASON/.test(src)) return "US";
  if (/CR|DX|GRAF/.test(src)) return "CR";
  if (/MG|MAMOGRAF/.test(src)) return "MG";
  return "";
}

/**
 * FHIR R4 DiagnosticReport → iade sonucu.
 *
 * Metin kaynağı sırası: `conclusion` → `presentedForm[].data` (base64) →
 * `text.div` (Narrative, etiketler ayıklanır).
 */
export function parseFhirDiagnosticReport(raw: unknown): ReturnParse {
  const warnings: string[] = [];
  const o = raw as {
    resourceType?: string;
    identifier?: { value?: string }[];
    subject?: { identifier?: { value?: string } };
    imagingStudy?: { identifier?: { value?: string } }[];
    conclusion?: string;
    presentedForm?: { contentType?: string; data?: string }[];
    text?: { div?: string };
    effectiveDateTime?: string;
    issued?: string;
    code?: { text?: string; coding?: { display?: string }[] };
  };
  if (!o || typeof o !== "object" || o.resourceType !== "DiagnosticReport") {
    return { ok: false, result: null, warnings: ["FHIR kaynağı DiagnosticReport değil."], format: "bilinmiyor" };
  }
  let text = (o.conclusion ?? "").trim();
  if (!text && Array.isArray(o.presentedForm)) {
    for (const f of o.presentedForm) {
      if (!f?.data) continue;
      try {
        text = Buffer.from(f.data, "base64").toString("utf8").trim();
        if (text) break;
      } catch {
        warnings.push("presentedForm base64 çözülemedi.");
      }
    }
  }
  if (!text && o.text?.div) {
    text = o.text.div.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!text) warnings.push("Rapor metni yok (conclusion/presentedForm/narrative boş).");

  const oidRaw = o.imagingStudy?.[0]?.identifier?.value ?? "";
  const studyUid = oidRaw.replace(/^urn:oid:/i, "").trim();
  const modality = (o.code?.coding?.[0]?.display ?? o.code?.text ?? "").toLocaleUpperCase("tr-TR").match(/\b(CT|MR|US|CR|DX|MG|PET)\b/)?.[1] ?? "";
  const idCandidate = (o.identifier ?? []).map((i) => i.value ?? "").find((v) => /^\d{1,9}$/.test(v));
  const at = o.effectiveDateTime ?? o.issued;

  return {
    ok: text.length > 0,
    result: text.length > 0
      ? { reportId: idCandidate ? Number(idCandidate) : null, studyUid: studyUid || undefined, modality: modality || undefined, text: text.slice(0, MAX_TEXT), at }
      : null,
    warnings,
    format: "fhir-diagnosticreport",
  };
}

/** Otomatik algılama: JSON ise FHIR, `MSH|` ile başlıyorsa HL7. */
export function parseReturnedPayload(raw: string): ReturnParse {
  const t = (raw ?? "").trim();
  if (!t) return { ok: false, result: null, warnings: ["Boş iade."], format: "bilinmiyor" };
  if (t.startsWith("{")) {
    try {
      return parseFhirDiagnosticReport(JSON.parse(t));
    } catch {
      return { ok: false, result: null, warnings: ["JSON çözülemedi."], format: "bilinmiyor" };
    }
  }
  return parseOru(t);
}

export interface ApplyOutcome {
  /** Görev kapatıldı mı */
  closed: boolean;
  task: FollowupTask | null;
  /** Eşleşme gerekçesi */
  reason: string;
  /** Hekim seçimi gerekiyorsa aday sayısı */
  ambiguousCandidates: number;
  warnings: string[];
  /** Kullanıcıya gösterilecek satır */
  message: string;
}

/**
 * İade → görev eşleştirme ve kapatma. Belirsiz eşleşmede **kapatmaz**;
 * hekimin seçmesi için aday sayısını ve gerekçeyi döndürür.
 */
export function applyReturnedResult(payload: string, tasks: FollowupTask[], now = Date.now()): ApplyOutcome {
  const parsed = parseReturnedPayload(payload);
  if (!parsed.ok || !parsed.result) {
    return { closed: false, task: null, reason: "İade ayrıştırılamadı", ambiguousCandidates: 0, warnings: parsed.warnings, message: `İade okunamadı: ${parsed.warnings[0] ?? "bilinmeyen biçim"}` };
  }
  const m = matchReturnedResult(parsed.result, tasks);
  if (!m.task) {
    const ambiguous = /aday/.test(m.reason);
    return {
      closed: false,
      task: null,
      reason: m.reason,
      ambiguousCandidates: ambiguous ? Number(/(\d+) aday/.exec(m.reason)?.[1] ?? 0) : 0,
      warnings: parsed.warnings,
      message: ambiguous ? `Eşleşme belirsiz (${m.reason}); görev otomatik kapatılmadı — hekim seçmeli.` : `Açık görev eşleşmedi: ${m.reason}`,
    };
  }
  const closed = closeWithOutcome(m.task, parsed.result, now);
  return {
    closed: true,
    task: closed,
    reason: m.reason,
    ambiguousCandidates: 0,
    warnings: parsed.warnings,
    message: `Görev #${closed.id} sonuçla kapatıldı (${m.reason}).`,
  };
}

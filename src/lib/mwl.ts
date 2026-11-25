/**
 * Modality Worklist (MWL) — C-FIND yanıtlarının çözümlenmesi ve iş istasyonu
 * listesi için saf fonksiyonlar.
 *
 * DICOM MWL, Modality Performed Procedure Step'e geçmeden önce modalitenin
 * "bugün benim ne işim var?" sorusuna yanıt verir: `0040,0100 Scheduled Procedure
 * Step Sequence` içindeki ögeler, hastayı ve çekimi tarif eder. Bu modül:
 *   1. `wadoFrames`/`qidoStudies` gibi ağ katmanından BAĞIMSIZDIR (testi kolay),
 *   2. DICOM JSON (DICOMweb standart modeli) girdisini `MwlItem`'a indirger,
 *   3. eksik/bozuk ögeleri sessizce atar (modalite listesinde çöp göstermeyiz).
 *
 * Kapsam dışı: gerçek DIMSE C-FIND soketi (bkz. `scripts/mwl-cfind-proxy.ts`
 * açıklaması) ve MPPS (`N-CREATE/N-SET`) bildirimi.
 */

export type MwlStatus = "SCHEDULED" | "ARRIVED" | "STARTED" | "COMPLETED" | "CANCELLED";

export interface MwlItem {
  /** Accession number (0008,0050); yoksa boş. */
  accession: string;
  patientId: string;
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  modality: string;
  bodyPart: string;
  /** İnceleme açıklaması (0032,1060) veya istenen işlem açıklaması (0040,0007). */
  description: string;
  /** Planlanan başlangıç: ISO 8601 yerel saat ("2026-01-15T10:30:00") ya da boş. */
  scheduledStart: string;
  stationAeTitle: string;
  scheduledAeTitle: string;
  status: MwlStatus;
  /** İstenen işlem adımı kimliği (0040,0009); MPPS eşleştirmesinde kullanılır. */
  stepId: string;
  studyInstanceUid: string;
  /** Öncelik: STAT / HIGH / ROUTINE / "" */
  priority: string;
}

/** DICOM JSON modelindeki tek bir değer ögesi. */
type DicomJsonValue = Record<string, { vr?: string; Value?: unknown[] }>;

const str = (v: DicomJsonValue | undefined, tag: string): string => {
  const item = v?.[tag];
  if (!item || !Array.isArray(item.Value) || item.Value.length === 0) return "";
  const first = item.Value[0];
  if (typeof first === "string") return first.trim();
  // PN (PersonName) JSON'da { Alphabetic: "..." } olarak gelebilir.
  if (first && typeof first === "object" && "Alphabetic" in first) {
    const a = (first as { Alphabetic?: unknown }).Alphabetic;
    return typeof a === "string" ? a.trim() : "";
  }
  return "";
};

/** "YILMAZ^AHMET" → "AHMET YILMAZ"; boşluklu adlar korunur. */
export function formatPersonName(pn: string): string {
  if (!pn) return "";
  const parts = pn.split("^").map((p) => p.trim());
  const family = parts[0] ?? "";
  const given = parts[1] ?? "";
  const middle = parts[2] ?? "";
  const out = [given, middle, family].filter(Boolean).join(" ");
  return out || family;
}

/** DICOM DA ("20260115") + TM ("103000") → "2026-01-15T10:30:00". Geçersizse boş. */
export function formatDicomDateTime(da: string, tm = ""): string {
  const d = (da || "").replace(/[^0-9]/g, "");
  if (d.length < 8) return "";
  const y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
  const t = (tm || "").replace(/[^0-9.]/g, "");
  const hh = t.slice(0, 2).padEnd(2, "0");
  const mm = t.slice(2, 4).padEnd(2, "0");
  const ss = t.slice(4, 6).replace(/\./g, "").padEnd(2, "0");
  const ymd = `${y}-${m}-${day}`;
  const iso = t ? `${ymd}T${hh}:${mm}:${ss}` : ymd;
  // Taşan tarih/saat kabul edilmez: "2026-02-31" gibi değerler geri çevrilir.
  const back = new Date(t ? iso : `${ymd}T00:00:00Z`);
  if (Number.isNaN(back.getTime())) return "";
  if (back.toISOString().slice(0, 10) !== ymd) return "";
  return iso;
}

const VALID_STATUS: Record<string, MwlStatus> = {
  SCHEDULED: "SCHEDULED",
  ARRIVED: "ARRIVED",
  STARTED: "STARTED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

/**
 * DICOM JSON (modality worklist C-FIND yanıtı) → `MwlItem[]`.
 * Zorunlu alan eşikleri: hasta kimliği VE (accession VEYA işlem adımı kimliği).
 * Modalite boşsa öge atılmaz (iş istasyonu tüm listeyi gösterebilmeli) ama
 * `modality` boş döner; böylece çağıran "atanmamış" olarak işaretleyebilir.
 */
export function mwlFromDicomJson(json: unknown): MwlItem[] {
  if (!Array.isArray(json)) return [];
  const out: MwlItem[] = [];
  for (const entry of json) {
    if (!entry || typeof entry !== "object") continue;
    const v = entry as DicomJsonValue;
    const sps = Array.isArray(v["00400100"]?.Value) ? (v["00400100"].Value[0] as DicomJsonValue) : undefined;
    const patientId = str(v, "00100020");
    const stepId = str(sps, "00400009");
    const accession = str(v, "00080050");
    if (!patientId || (!accession && !stepId)) continue;

    // İstenen işlem adımı kod dizisi (0040,0008): yalnızca açıklama yedeği olarak kullanılır.
    const requested = sps?.["00400008"] && Array.isArray(sps["00400008"].Value)
      ? (sps["00400008"].Value[0] as DicomJsonValue)
      : undefined;

    const statusRaw = str(sps, "00400020").toUpperCase();
    const startDate = str(sps, "00400002");
    const startTime = str(sps, "00400003");
    out.push({
      accession,
      patientId,
      patientName: formatPersonName(str(v, "00100010")),
      patientBirthDate: formatDicomDateTime(str(v, "00100030")),
      patientSex: str(v, "00100040"),
      modality: str(v, "00080060") || str(sps, "00080060"),
      bodyPart: str(v, "00180015") || str(sps, "00180015"),
      description: str(v, "00321060") || str(sps, "00400007") || str(requested, "00400007"),
      scheduledStart: formatDicomDateTime(startDate, startTime),
      stationAeTitle: str(sps, "00400010"),
      scheduledAeTitle: str(sps, "00400001"),
      status: VALID_STATUS[statusRaw] ?? "SCHEDULED",
      stepId,
      studyInstanceUid: str(v, "0020000D"),
      priority: str(sps, "00400005"),
    });
  }
  return out;
}

/** Test kancası: `mwlFromDicomJson`'ın zorunlu alan kuralını tek yerde tutar. */
export function isUsableMwlItem(item: MwlItem): boolean {
  return Boolean(item.patientId && (item.accession || item.stepId));
}

/** Durum rozetleri (arayüzde renk/etiket için). */
export const MWL_STATUS_LABEL: Record<MwlStatus, string> = {
  SCHEDULED: "Planlandı",
  ARRIVED: "Geldi",
  STARTED: "Başladı",
  COMPLETED: "Tamamlandı",
  CANCELLED: "İptal",
};

/**
 * Liste süzgeci: modalite, arama metni (hasta/accession/açıklama), tarih ve
 * "yalnızca açık işler" seçenekleri. Arama Türkçe küçültme ile yapılır.
 */
export interface MwlFilter {
  modality?: string;
  query?: string;
  date?: string; // YYYY-MM-DD (planlanan başlangıç günü)
  onlyOpen?: boolean;
}

export function filterMwl(items: MwlItem[], f: MwlFilter): MwlItem[] {
  const q = (f.query ?? "").toLocaleLowerCase("tr-TR").trim();
  return items.filter((it) => {
    if (f.modality && it.modality !== f.modality) return false;
    if (f.date && it.scheduledStart.slice(0, 10) !== f.date) return false;
    if (f.onlyOpen && (it.status === "COMPLETED" || it.status === "CANCELLED")) return false;
    if (!q) return true;
    const hay = [it.patientName, it.patientId, it.accession, it.description, it.bodyPart, it.modality]
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return hay.includes(q);
  });
}

/** Sıralama: planlanan başlangıç, sonra hasta adı; boş tarih en sona. */
export function sortMwl(items: MwlItem[]): MwlItem[] {
  return [...items].sort((a, b) => {
    if (!a.scheduledStart && b.scheduledStart) return 1;
    if (a.scheduledStart && !b.scheduledStart) return -1;
    if (a.scheduledStart !== b.scheduledStart) return a.scheduledStart < b.scheduledStart ? -1 : 1;
    return a.patientName.localeCompare(b.patientName, "tr-TR");
  });
}

/**
 * MWL ögesini ArenaViewer çalışmasına çevirir (`/api/his/orders` gövdesiyle aynı
 * biçim). `studyUid` DICOM'da varsa o kullanılır; yoksa accession'dan türetilir
 * ve modalite PACS'ten geldiğinde bu UID ile eşleşir.
 */
export function mwlToOrder(item: MwlItem): {
  patientId: string;
  patientName: string;
  patientAge?: string;
  patientSex?: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  studyDate?: string;
  studyUid: string;
} | null {
  if (!isUsableMwlItem(item)) return null;
  const accessionNumber = item.accession || item.stepId;
  const age = ageFromBirthDate(item.patientBirthDate);
  return {
    patientId: item.patientId,
    patientName: item.patientName || item.patientId,
    ...(age ? { patientAge: age } : {}),
    ...(item.patientSex ? { patientSex: item.patientSex } : {}),
    accessionNumber,
    modality: item.modality || "OT",
    bodyPart: item.bodyPart,
    description: item.description || "MWL isteği",
    ...(item.scheduledStart ? { studyDate: item.scheduledStart } : {}),
    studyUid: item.studyInstanceUid || `mwl.${accessionNumber}`,
  };
}

/** Doğum tarihinden yaş (yıl); geçersizse boş. Tarih taşması kabul edilmez. */
export function ageFromBirthDate(birth: string, today = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birth ?? "");
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const bd = new Date(Date.UTC(y, mo - 1, d));
  if (bd.getUTCFullYear() !== y || bd.getUTCMonth() !== mo - 1 || bd.getUTCDate() !== d) return "";
  let age = today.getUTCFullYear() - y;
  const before = today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d);
  if (before) age -= 1;
  if (age < 0 || age > 130) return "";
  return String(age);
}

/** İş istasyonu rozeti için kısa özet: "3 açık / 1 tamamlandı". */
export function mwlSummary(items: MwlItem[]): { total: number; open: number; done: number; cancelled: number } {
  let open = 0, done = 0, cancelled = 0;
  for (const it of items) {
    if (it.status === "COMPLETED") done++;
    else if (it.status === "CANCELLED") cancelled++;
    else open++;
  }
  return { total: items.length, open, done, cancelled };
}

// ───────────── İmplicit VR Little Endian okuyucu (DIMSE köprüsü için) ─────────────

export interface DcmElement {
  tag: number;
  vr: string;
  /** Metin/UID değerleri; ikili değerlerde boş. */
  text: string;
  /** Ham değer baytları (piksel/SQ hariç). */
  bytes: Uint8Array;
  /** SQ ise alt ögeler. */
  items: DcmElement[][];
  /** Bilinmeyen/implicit VR (sözlükten çözülemedi). */
  unknownVr: boolean;
}

/**
 * Implicit VR sözlüğü — yalnız MWL yanıtında anlamlı olan etiketler.
 * Bilinmeyen etiketler `UN` sayılır ve metin olarak çözülmeye çalışılır
 * (MWL yanıtları neredeyse tamamen metin/UID taşır).
 */
const VR: Record<number, string> = {
  0x00080005: "CS", 0x00080016: "UI", 0x00080018: "UI", 0x00080020: "DA", 0x00080030: "TM",
  0x00080050: "SH", 0x00080060: "CS", 0x00080080: "LO", 0x00080090: "PN", 0x00081030: "LO",
  0x00081050: "PN", 0x00100010: "PN", 0x00100020: "LO", 0x00100030: "DA", 0x00100040: "CS",
  0x00180015: "CS", 0x0020000D: "UI", 0x0020000E: "UI", 0x00321060: "LO", 0x00321064: "SQ",
  0x00400001: "AE", 0x00400002: "DA", 0x00400003: "TM", 0x00400005: "SH", 0x00400006: "PN",
  0x00400007: "LO", 0x00400008: "SQ", 0x00400009: "SH", 0x00400010: "SH", 0x00400011: "SH",
  0x00400020: "CS", 0x00400100: "SQ", 0x00401001: "SH",
};

const LONG_VRS = new Set(["OB", "OW", "OF", "SQ", "UT", "UN"]);
const NUMERIC_VRS = new Set(["US", "SS", "UL", "SL", "FL", "FD", "AT", "OB", "OW"]);

/** Baytları karakter kümesine göre metne çevirir (varsayılan latin1/UTF-8 denemesi). */
function decodeText(bytes: Uint8Array): string {
  const ascii = bytes.every((b) => b < 0x80);
  if (ascii) return Buffer.from(bytes).toString("latin1").replace(/[\0 ]+$/g, "").trim();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/[\0 ]+$/g, "").trim();
  } catch {
    return Buffer.from(bytes).toString("latin1").replace(/[\0 ]+$/g, "").trim();
  }
}

const ITEM = 0xfffee000;
const ITEM_END = 0xfffee00d;
const SEQ_END = 0xfffee0dd;

/**
 * Implicit VR LE veri kümesini okur. `limit` sınırına kadar ögeleri toplar;
 * öge/seri sonu işaretlerine (FFFE,E00D / FFFE,E0DD) gelince durur ve tüketilen
 * konumu döndürür — böylece tanımsız uzunluklu yapılar özyinelemeli okunabilir.
 */
function readElements(buf: Uint8Array, charset: string, start: number, limit: number): { els: DcmElement[]; next: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const els: DcmElement[] = [];
  let p = start;
  while (p + 8 <= limit) {
    const tag = dv.getUint32(p, true);
    if (tag === ITEM_END || tag === SEQ_END) return { els, next: p + 8 };
    let len = dv.getUint32(p + 4, true);
    p += 8;
    if (tag >>> 16 === 0xfffe) {
      // Beklenmeyen öge başlığı: içeriği atla.
      if (len === 0xffffffff) return { els, next: p };
      p = Math.min(p + len, limit);
      continue;
    }
    const vr = VR[tag] ?? "UN";
    if (vr === "SQ") {
      const items: DcmElement[][] = [];
      const endSeq = len === 0xffffffff ? limit : Math.min(p + len, limit);
      while (p + 8 <= endSeq) {
        const t2 = dv.getUint32(p, true);
        if (t2 === SEQ_END) { p += 8; break; }
        if (t2 !== ITEM) break;
        const ilen = dv.getUint32(p + 4, true);
        p += 8;
        const r = readElements(buf, charset, p, ilen === 0xffffffff ? endSeq : Math.min(p + ilen, endSeq));
        items.push(r.els);
        p = ilen === 0xffffffff ? r.next : Math.min(p + ilen, endSeq);
      }
      if (len !== 0xffffffff) p = endSeq;
      els.push({ tag, vr, text: "", bytes: new Uint8Array(0), items, unknownVr: false });
      continue;
    }
    if (len === 0xffffffff) len = limit - p; // tanımsız uzunluk: kalanı al (piksel verisi)
    if (p + len > limit) break; // bozuk mesaj: kalanı yok say
    const value = buf.subarray(p, p + len);
    p += len;
    els.push({
      tag,
      vr,
      text: NUMERIC_VRS.has(vr) ? "" : decodeText(value),
      bytes: value,
      items: [],
      unknownVr: !VR[tag],
    });
  }
  return { els, next: p };
}

/**
 * DIMSE C-FIND yanıt gövdesini (Implicit VR LE, komut kümesi olmadan) ayrıştırır.
 *
 * Neden kendi ayrıştırıcımız: `dicom-parser` (bağımlılık) dosya biçimi bekler ve
 * dosya meta bilgisi (0002,xxxx) ister; C-FIND yanıtı ise çıplak veri kümesidir.
 * MWL için gereken etiketler metin/UID/SQ olduğundan küçük bir okuyucu yeterli.
 */
export function parseImplicitVr(buf: Uint8Array): DcmElement[] {
  // (0008,0005) Specific Character Set çoğu yanıtta ilk ögedir; ASCII dışı metin
  // UTF-8 olarak çözülür, bu da ISO_IR 192 için doğrudur.
  return readElements(buf, "ISO_IR 192", 0, buf.length).els;
}

/** Düz öge listesinde etiket arar (dizi içine girmez). */
export function findElement(els: DcmElement[], tag: number): DcmElement | undefined {
  return els.find((e) => e.tag === tag);
}

/** Veri kümesini DICOMweb JSON modeline çevirir; böylece `mwlFromDicomJson` yeniden kullanılır. */
export function datasetToDicomJson(els: DcmElement[]): Record<string, { vr: string; Value?: unknown[] }> {
  const out: Record<string, { vr: string; Value?: unknown[] }> = {};
  for (const e of els) {
    const key = tagKey(e.tag);
    if (e.vr === "SQ") {
      out[key] = { vr: "SQ", Value: e.items.map((item) => datasetToDicomJson(item)) };
    } else if (e.vr === "PN") {
      out[key] = { vr: e.vr, Value: [{ Alphabetic: e.text }] };
    } else {
      out[key] = { vr: e.vr, Value: [e.text] };
    }
  }
  return out;
}

/** Etiket → DICOM JSON anahtarı ("00100010"). */
export function tagKey(tag: number): string {
  return tag.toString(16).padStart(8, "0").toUpperCase();
}

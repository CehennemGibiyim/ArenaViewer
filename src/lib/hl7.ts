/**
 * HL7 v2 (MLLP) ayrıştırıcı — HBYS/RIS istem köprüsü için saf fonksiyonlar.
 *
 * Yalnızca metinleme/açma ve ACK üretimi içerir; soket ve HTTP yoktur (test edilebilir).
 * Kapsam: ORM^O01, ORU^R01, MDM^T02 (ve tip alanı boş mesajlar). MWL/C-FIND burada değil;
 * bu modül gelen siparişi `/api/his/orders` ucuna çevirir.
 */

export interface Hl7Segment {
  name: string;
  fields: string[];
}

export interface ParsedHl7 {
  /** MSH-9: "ORM^O01" gibi */
  type: string;
  trigger: string;
  sendingApp: string;
  sendingFacility: string;
  messageControlId: string;
  segments: Hl7Segment[];
}

const HL7_ESCAPES: Record<string, string> = { F: "|", S: "^", T: "&", E: "\\", ".BR": "\n" };

/** HL7 kaçış dizilerini (| ^ & \ ve satır sonu) çözer. */
export function unescape(s: string): string {
  return s.replace(/\\([FSTE]|\.[bB][rR])\\/g, (_, esc: string) => HL7_ESCAPES[esc.toUpperCase()] ?? esc);
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\E\\").replace(/\|/g, "\\F\\").replace(/\^/g, "\\S\\").replace(/&/g, "\\T\\").replace(/\r|\n/g, "\\.br\\");
}

/** Ham MLLP akışından ya da çerçevesiz metinden bir HL7 mesajı çıkarır. */
export function parseHl7(raw: string): ParsedHl7 | null {
  if (!raw) return null;
  let text = raw;
  // MLLP: VT (0x0B) ile başlar, FS (0x1C) + CR ile biter.
  if (text.charCodeAt(0) === 0x0b) text = text.slice(1);
  text = text.replace(/\x1c\r?\n?$/, "").replace(/\r\n/g, "\r").trim();
  if (!text) return null;
  const lines = text.split("\r").filter((l) => l.trim().length > 0);
  if (lines.length === 0 || !lines[0].startsWith("MSH|")) return null;

  const segs: Hl7Segment[] = [];
  for (const line of lines) {
    const fields = line.split("|").map(unescape);
    if (!fields[0]) continue;
    segs.push({ name: fields[0], fields });
  }
  const msh = segs[0];
  // MSH'de ayraç MSH-1'dir; dizinde kaymasın diye normale çeviriyoruz (parse sırasında
  // zaten ayraçla bölündüğü için burada sadece erişim kolaylığı sağlanır).
  return {
    type: msh.fields[8] ?? "",
    trigger: (msh.fields[8] ?? "").split("^")[1] ?? "",
    sendingApp: msh.fields[2] ?? "",
    sendingFacility: msh.fields[3] ?? "",
    messageControlId: msh.fields[9] ?? "",
    segments: segs,
  };
}

export interface Hl7OrderPayload {
  patientId: string;
  patientName: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
  description: string;
  studyDate?: string;
  sourceType: string;
}

const MODALITY_WORDS: [RegExp, string][] = [
  [/tomografi|\bBT\b|kbt/i, "CT"],
  [/mr\b|manyetik rezonans|magnetogram|\bMR\b/i, "MR"],
  [/mamografi|mammografi|meme\s*gr|db\s*t|mamografi/i, "MG"],
  [/ultrason|usg|doppler|echocard/i, "US"],
  [/grafi|\bKGT\b|\bPA\b|\bAP\b|röntgen|x.?ray/i, "CR"],
  [/anjiyo|ds?sa|\bDSA\b/i, "DSA"],
  [/nukleer|kemik.?odak|nükleer|\bNM\b/i, "NM"],
  [/pet.?ct|pet.?mr|sintigrafi/i, "PET/CT"],
  [/floroskopi|floroskop/i, "RF"],
];

/** Açıklamadan modalite adayı bulur; bulunamazsa boş döner (tahmin yok). */
export function guessModality(...texts: string[]): string {
  // Türkçe küçültme (İ→i, I→ı) ile eşleştir; böylece "MAMOGRAFİSİ" de yakalanır.
  const joined = texts.filter(Boolean).join(" ").toLocaleLowerCase("tr-TR");
  for (const [re, code] of MODALITY_WORDS) if (re.test(joined)) return code;
  return "";
}

const comp = (s: string, i: number) => (s && s.split("^")[i] !== undefined ? s.split("^")[i].trim() : "");

/** HL7 mesajından sipariş yükü çıkarır; yeterli bilgi yoksa null. */
export function orderFromHl7(msg: ParsedHl7): Hl7OrderPayload | null {
  const seg = (name: string) => msg.segments.find((s) => s.name === name);
  const pid = seg("PID");
  const orc = seg("ORC");
  const obr = seg("OBR");

  // PID-3 (fields[3]) hasta tanımlayıcı listesi; PID-5 (fields[4]) ad soyad.
  const patientId = comp(pid?.fields[3] ?? "", 0);
  const family = comp(pid?.fields[4] ?? "", 0);
  const given = comp(pid?.fields[4] ?? "", 1);
  const patientName = `${given} ${family}`.trim();

  const accessionNumber = (orc?.fields[2] ?? "").trim() || (obr?.fields[2] ?? "").trim();
  const universalDesc = (obr?.fields[4] ?? "").trim();
  // OBR-4'ün ikinci bileşeni inceleme adıdır ("71045^BEYIN BT^LN").
  const descName = universalDesc.split("^")[1]?.trim() ?? "";
  const description = (obr?.fields[13] ?? "").trim() || descName || universalDesc;
  const bodyPart = (obr?.fields[15] ?? "").trim() || descName;

  // Öncelik OBR-7 (ölçüm zamanı); yoksa OBR-6 (istek zamanı).
  const rawDate = ((obr?.fields[7] ?? "") || (obr?.fields[6] ?? "")).trim().replace(/[^0-9]/g, "");
  let studyDate: string | undefined;
  if (rawDate.length >= 8) {
    const y = rawDate.slice(0, 4), m = rawDate.slice(4, 6), d = rawDate.slice(6, 8);
    const hh = rawDate.slice(8, 10) || "00", mm = rawDate.slice(10, 12) || "00";
    studyDate = `${y}-${m}-${d}T${hh}:${mm}:00`;
  }

  const modality = guessModality(universalDesc, description, bodyPart, (orc?.fields[12] ?? ""));
  if (!patientId || !accessionNumber || !modality) return null;
  return { patientId, patientName, accessionNumber, modality, bodyPart, description, studyDate, sourceType: msg.type || "HL7" };
}

/** ACK (AA/AR/AE) mesajı üretir; MLLP çerçevesi eklendiği gibi döner. */
export function buildAck(inMsg: ParsedHl7, ackCode: "AA" | "AR" | "AE", text: string, controlId = ""): string {
  const id = controlId || inMsg.messageControlId || String(Date.now());
  const msh2 = escape(`${inMsg.sendingFacility}^${inMsg.sendingApp}`);
  const body = [
    `MSH|^~\\&|AtikViewer|HIS-Koprusu|${msh2}|${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}||ACK|${id}|P|2.5`,
    `MSA|${ackCode}|${inMsg.messageControlId}|${escape(text).slice(0, 100)}`,
  ].join("\r");
  return `\x0b${body}\x1c\r`;
}

/** Metni MLLP karelerine böler (kokpit/gövde uzunluklarına göre). */
export function frameMllp(text: string): string {
  return `\x0b${text.replace(/\x1c\r?$/, "")}\x1c\r`;
}

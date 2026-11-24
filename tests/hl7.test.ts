/** HL7 v2 (MLLP) ayrıştırma/ACK testleri. */
import { buildAck, frameMllp, guessModality, orderFromHl7, parseHl7, unescape } from "../src/lib/hl7";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const orm = [
  "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORM^O01|MSG001|P|2.5",
  "PID|1|EXT-1|ID-123|YILMAZ^AHMET|19800101|M",
  "PV1||O|||||||||||||||||||",
  "ORC|NW|ACC-9001|||||||20260115110000",
  "OBR|1|ACC-9001|FILL-1|71045^BEYIN BT^LN||20260115100000|||||||BEYIN|||||CT",
].join("\r");

const framed = "\x0b" + orm + "\x1c\r";
const m = parseHl7(framed);
ok(m !== null && m.type === "ORM^O01" && m.trigger === "O01", "MLLP çerçevesi ve tip");
ok(m?.messageControlId === "MSG001" && m?.sendingFacility === "HASTA", "MSH alanları");
ok(parseHl7(orm) !== null, "Çerçevesiz metin de ayrıştırılır");
ok(parseHl7("") === null && parseHl7("NOT|HL7") === null, "Geçersiz girdi reddedilir");

const o = orderFromHl7(m!);
ok(o !== null, "Sipariş yükü üretildi");
ok(o?.patientName === "AHMET YILMAZ" && o?.accessionNumber === "ACC-9001", `Hasta/istek ${o?.patientName}/${o?.accessionNumber}`);
ok(o?.modality === "CT" && o?.bodyPart === "BEYIN BT", `Modalite/bölge ${o?.modality}/${o?.bodyPart}`);
ok(o?.studyDate === "2026-01-15T10:00:00", `Tarih ${o?.studyDate}`);
ok(orderFromHl7(parseHl7("MSH|^~\\&|A|B|C|D||20260115||ORM^O01|X|P|2.5\rPID||123||KIM^A\rORC|NW|")!) === null, "Eksik istem reddedilir");

ok(unescape("A\\T\\B\\F\\C\\.br\\D") === "A&B|C\nD", "Kaçış çözme");
ok(guessModality("SAĞ MEME MAMOGRAFİSİ") === "MG" && guessModality("MR KARMAŞIK") === "MR" && guessModality("tanımsız şey") === "", "Modalite adayı");

const ack = buildAck(m!, "AA", "Istem alindi: ACC-9001", "ACK-1");
ok(ack.charCodeAt(0) === 0x0b && ack.endsWith("\x1c\r"), "ACK MLLP çerçeveli");
ok(ack.includes("MSA|AA|MSG001|Istem alindi: ACC-9001"), "ACK gövdesi");
ok(frameMllp("MSA|AA|X").endsWith("\x1c\r"), "frameMllp");

if (failed) { console.error(`${failed} HL7 testi başarısız`); process.exit(1); }
console.log("Tüm HL7 testleri geçti.");

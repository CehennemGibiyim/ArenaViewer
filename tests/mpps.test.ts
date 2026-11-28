/**
 * e-hl7-mwl — MPPS (N-CREATE/N-SET) sözleşmesi.
 *
 * Doğrulama "kaynak metni arama" değil, **gerçek bayt** üzerinden yapılır:
 * üretilen DICOM JSON → Implicit VR LE baytlara çevrilir → `mwl.ts`teki bağımsız
 * DIMSE okuyucusu (`parseImplicitVr` + `datasetToDicomJson`) ile geri okunur ve
 * aynı etiket/değerlerin çıktığı kanıtlanır. Böylece hem üretici hem okuyucu
 * birbirini bağımsız olarak sınar.
 */
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import {
  buildMppsCreate, buildMppsSet, decideMppsEffect, isValidUid, mppsIdempotency, mppsStatusTag,
  readMppsResponse, workStatusFor, type MppsStatus,
} from "../src/lib/mpps";
import { datasetToDicomJson, parseImplicitVr, tagKey } from "../src/lib/mwl";
import { eventFromCreate, eventFromSet, validateEvent } from "../scripts/mpps-bridge";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const STUDY = "1.2.840.113619.2.55.3.604688.1";
const SERIES = "1.2.840.113619.2.55.3.604688.2";
const MPPS = "1.2.826.0.1.3680043.8.498.1";

// ── DICOM JSON → Implicit VR LE bayt (test yardımcısı, bağımsız üretici) ──
const TAGS: Record<string, number> = {
  "00080050": 0x00080050, "00080060": 0x00080060, "00080061": 0x00080061,
  "00080090": 0x00080090, "00100010": 0x00100010, "00100020": 0x00100020,
  "0020000D": 0x0020000d, "00400244": 0x00400244, "00400245": 0x00400245,
  "00400250": 0x00400250, "00400251": 0x00400251, "00400252": 0x00400252,
  "00400253": 0x00400253, "00400254": 0x00400254,
  "00400280": 0x00400280, "00400340": 0x00400340, "00401001": 0x00401001,
  "00400241": 0x00400241, "00400270": 0x00400270,
  "0020000E": 0x0020000e,
};
function elementBytes(tag: number, v: { vr: string; Value?: unknown[] }): Buffer {
  if (v.vr === "SQ") {
    const items = (v.Value ?? []) as Record<string, { vr: string; Value?: unknown[] }>[];
    const parts: Buffer[] = [];
    for (const item of items) {
      const body = Buffer.concat(Object.entries(item).map(([k, val]) => elementBytes(TAGS[k] ?? Number.parseInt(k, 16), val)));
      const ih = Buffer.alloc(8);
      ih.writeUInt32LE(0xfffee000, 0);
      ih.writeUInt32LE(body.length, 4);
      parts.push(ih, body, Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]));
    }
    const b = Buffer.alloc(8); b.writeUInt32LE(tag, 0); b.writeUInt32LE(0xffffffff, 4);
    // Tanımsız uzunluklu SQ: her öge (FFFE,E00D) ile, dizi (FFFE,E0DD) ile biter.
    // Yalnız öge sonu yazmak gerçek bir DICOM hatasıdır: okuyucu diziyi kapatamaz
    // ve sonraki ögeler kaybolur (bu test hatası bayt düzeyinde yakalandı).
    const seqEnd = Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
    return Buffer.concat([b, ...parts, seqEnd]);
  }
  let value = "";
  const first = (v.Value ?? [])[0];
  if (typeof first === "string") value = first;
  else if (first && typeof first === "object" && "Alphabetic" in (first as Record<string, unknown>)) value = String((first as { Alphabetic: string }).Alphabetic);
  const padded = Buffer.from(value, "latin1");
  const body = padded.length % 2 ? Buffer.concat([padded, Buffer.from(" ")]) : padded;
  const h = Buffer.alloc(8); h.writeUInt32LE(tag, 0); h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
function toImplicitVr(tags: Record<string, { vr: string; Value?: unknown[] }>): Buffer {
  return Buffer.concat(Object.entries(tags).map(([k, v]) => elementBytes(TAGS[k] ?? Number.parseInt(k, 16), v)));
}

// ── 1. UID doğrulama ──
ok(isValidUid(STUDY) && isValidUid("1.2.3"), "geçerli UID kabul edilir");
ok(!isValidUid("") && !isValidUid("1..2") && !isValidUid("1.2.") && !isValidUid("abc"), "bozuk UID reddedilir");
ok(!isValidUid("0.1.2"), "sıfırla başlayan bileşen reddedilir");
ok(!isValidUid("1." + "9".repeat(70)), "64 karakterden uzun UID reddedilir");

// ── 2. N-CREATE: gerçek bayt → DIMSE okuyucu ile geri okuma ──
{
  const create = buildMppsCreate({
    studyUid: STUDY, accession: "ACC-42", modality: "CT",
    performedProcedureStepId: "PPS-1", startDate: "20261127", startTime: "101500",
    requestedProcedureId: "RP-42", patientId: "MRK1", patientName: "YILMAZ^AYSE",
    description: "Toraks BT", referringPhysician: "DR^AHMET", stationAet: "CT1",
  });
  ok((create["00400252"] as { Value: string[] }).Value[0] === "IN PROGRESS", "N-CREATE durumu IN PROGRESS");
  ok((create["0020000D"] as { Value: string[] }).Value[0] === STUDY, "çalışma UID yükü taşır");
  const raw = toImplicitVr(create as Record<string, { vr: string; Value?: unknown[] }>);
  const back = datasetToDicomJson(parseImplicitVr(new Uint8Array(raw)));
  ok((back["00400252"].Value as string[])[0] === "IN PROGRESS", "bayttan geri okunan durum doğru");
  ok((back["0020000D"].Value as string[])[0] === STUDY, "bayttan geri okunan çalışma UID doğru");
  ok((back["00080060"].Value as string[])[0] === "CT", "modality baytta korunur");
  ok(((back["00080090"].Value as { Alphabetic: string }[])[0]).Alphabetic === "DR^AHMET", "PN (hekim) baytta korunur");
  const sq = (back["00400270"].Value as unknown as Record<string, { Value: unknown[] }>[])[0];
  ok((sq["00080050"].Value as string[])[0] === "ACC-42", "iç içe SQ: accession okunur (MWL köprüsü)");
  ok((sq["00401001"].Value as string[])[0] === "RP-42", "iç içe SQ: istenen işlem no");
  ok((sq["00100010"].Value as { Alphabetic: string }[])[0].Alphabetic === "YILMAZ^AYSE", "iç içe SQ: hasta adı");
  const read = readMppsResponse(back, MPPS);
  ok(read.status === "IN PROGRESS" && read.studyUid === STUDY && read.warnings.length === 0, "readMppsResponse temiz yükü kabul eder");
  ok(read.accession === "ACC-42", "erişim numarası SQ'dan da okunur");
}
ok((() => { try { buildMppsCreate({ studyUid: "bozuk", accession: "A", modality: "CT", performedProcedureStepId: "P" }); return false; } catch { return true; } })(), "geçersiz UID ile N-CREATE reddedilir");
ok((() => { try { buildMppsCreate({ studyUid: STUDY, accession: "A", modality: "CT", performedProcedureStepId: "" }); return false; } catch { return true; } })(), "boş adım kimliği reddedilir");

// ── 3. N-SET: COMPLETED / DISCONTINUED kuralları ──
{
  const set = buildMppsSet({ mppsUid: MPPS, status: "COMPLETED", endDate: "20261127", endTime: "103000", performedSeriesUids: [SERIES] });
  ok((set["00400252"] as { Value: string[] }).Value[0] === "COMPLETED", "N-SET COMPLETED");
  const raw = toImplicitVr(set as Record<string, { vr: string; Value?: unknown[] }>);
  const back = datasetToDicomJson(parseImplicitVr(new Uint8Array(raw)));
  ok((back["00400251"].Value as string[])[0] === "103000", "bitiş saati baytta korunur");
  const seq = (back["00400340"].Value as unknown as Record<string, { Value: unknown[] }>[])[0];
  ok((seq["0020000E"].Value as string[])[0] === SERIES, "üretilen seri UID'leri SQ'da");
  ok((() => { try { buildMppsSet({ mppsUid: MPPS, status: "IN PROGRESS" as never }); return false; } catch { return true; } })(), "N-SET IN PROGRESS reddedilir (yalnız N-CREATE)");
  ok((() => { try { buildMppsSet({ mppsUid: MPPS, status: "DISCONTINUED" }); return false; } catch { return true; } })(), "DISCONTINUED gerekçesiz reddedilir");
  const disc = buildMppsSet({ mppsUid: MPPS, status: "DISCONTINUED", comments: "Hasta hareket etti" });
  ok((disc["00400280"] as { Value: string[] }).Value[0] === "Hasta hareket etti", "iptal gerekçesi yazılır");
  ok((() => { try { buildMppsSet({ mppsUid: "x", status: "COMPLETED" }); return false; } catch { return true; } })(), "geçersiz MPPS UID reddedilir");
}

// ── 4. Yanıt okuma + uyarılar: eksik alan sessizce geçmez ──
{
  const missingEnd = readMppsResponse({ "00400252": { vr: "CS", Value: ["COMPLETED"] }, "0020000D": { vr: "UI", Value: [STUDY] } }, MPPS);
  ok(missingEnd.warnings.some((w) => /bitiş saati/.test(w)), "COMPLETED + bitiş saati yok → uyarı");
  const noReason = readMppsResponse({ "00400252": { vr: "CS", Value: ["DISCONTINUED"] }, "0020000D": { vr: "UI", Value: [STUDY] } }, MPPS);
  ok(noReason.warnings.some((w) => /gerekçe/.test(w)), "DISCONTINUED + gerekçe yok → uyarı");
  const noStudy = readMppsResponse({ "00400252": { vr: "CS", Value: ["COMPLETED"] } }, MPPS);
  ok(noStudy.warnings.some((w) => /Study Instance UID yok/.test(w)), "çalışma UID yoksa uyarı (uydurma eşleşme yok)");
  const bogus = readMppsResponse({ "00400252": { vr: "CS", Value: ["FINISHED"] } }, MPPS);
  ok(bogus.warnings.some((w) => /Beklenmeyen MPPS durumu/.test(w)) && workStatusFor(bogus.status as MppsStatus) === null, "bilinmeyen durum çalışma durumunu değiştirmez");
}

// ── 5. Durum eşleme + idempotency ──
{
  ok(workStatusFor("IN PROGRESS") === "okunuyor", "IN PROGRESS → okunuyor");
  ok(workStatusFor("COMPLETED") === "bekliyor", "COMPLETED → bekliyor (onay değil)");
  ok(workStatusFor("DISCONTINUED") === null, "DISCONTINUED çalışma listesine düşmez");
  ok(workStatusFor("") === null, "boş durum değiştirmez");
  ok(mppsIdempotency(undefined, "IN PROGRESS") === "accept", "ilk bildirim kabul");
  ok(mppsIdempotency({ status: "IN PROGRESS", updatedAt: 1_000_000 }, "IN PROGRESS", 1_030_000) === "duplicate", "yinelenen bildirim (2 dk içinde) duplicate");
  ok(mppsIdempotency({ status: "IN PROGRESS", updatedAt: 1_000_000 }, "IN PROGRESS", 1_500_000) === "accept", "süre aşımından sonra kabul");
  ok(mppsIdempotency({ status: "COMPLETED", updatedAt: 1_000_000 }, "IN PROGRESS", 1_100_000) === "conflict", "tamamlanmış adım geri IN PROGRESS'e alınamaz");
}

// ── 5b. Karar tablosu (DB'siz, saf): kim ne zaman değişir ──
{
  const ev = (status: MppsStatus | ""): Parameters<typeof decideMppsEffect>[1] =>
    ({ status, mppsUid: MPPS, accession: "A", studyUid: STUDY, warnings: [] });
  ok(decideMppsEffect("bekliyor", ev("IN PROGRESS")).apply === true, "bekliyor + IN PROGRESS → uygulanır");
  ok(decideMppsEffect("bekliyor", ev("IN PROGRESS")).workStatus === "okunuyor", "… durum okunuyor olur");
  ok(decideMppsEffect("taslak", ev("COMPLETED")).workStatus === "bekliyor", "COMPLETED → bekliyor");
  const signed = decideMppsEffect("onayli", ev("IN PROGRESS"));
  ok(!signed.apply && signed.workStatus === "onayli" && /onaylı/.test(signed.reason), "onaylı çalışma MPPS ile geri alınmaz");
  const dup = decideMppsEffect("okunuyor", ev("IN PROGRESS"));
  ok(!dup.apply && /yinelenen/.test(dup.reason), "aynı durum yinelenen bildirim sayılır (boşuna yazma yok)");
  const disc = decideMppsEffect("okunuyor", ev("DISCONTINUED"));
  ok(!disc.apply && disc.workStatus === "okunuyor", "DISCONTINUED çalışma durumunu değiştirmez");
  const empty = decideMppsEffect("okunuyor", ev(""));
  ok(!empty.apply && empty.workStatus === "okunuyor", "boş durum hiçbir şeyi değiştirmez");
}

// ── 6. Köprü: olay üretimi + doğrulama ──
{
  const ev = eventFromCreate({ studyUid: STUDY, accession: "ACC-9", modality: "MR", performedProcedureStepId: "PPS-9" });
  const v = validateEvent(ev);
  ok(v.ok && (ev.tags["00400252"] as { Value: string[] }).Value[0] === "IN PROGRESS", "köprü N-CREATE olayı üretir");
  const ev2 = eventFromSet({ mppsUid: MPPS, status: "COMPLETED" });
  ok(validateEvent(ev2).ok, "köprü N-SET olayı üretir");
  ok(!validateEvent({}).ok && !validateEvent(null).ok, "boş olay reddedilir");
  ok(!validateEvent({ mppsUid: "1.2.3" }).ok, "tags yoksa reddedilir");
  ok(!validateEvent({ mppsUid: "1.2.3", tags: { "00080050": { vr: "SH", Value: ["A"] } } }).ok, "durum etiketi yoksa reddedilir");
  ok(tagKey(0x00400252) === "00400252", "etiket anahtarı DICOM JSON biçiminde");
  ok(mppsStatusTag("COMPLETED").Value[0] === "COMPLETED" && mppsStatusTag("IN PROGRESS").vr === "CS", "durum etiketi VR=CS");
}

console.log(`\nmpps: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
process.exit(fail === 0 ? 0 : 1);

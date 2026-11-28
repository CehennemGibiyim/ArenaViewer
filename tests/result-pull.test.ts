/** d-followup: HBYS/RIS sonuç çekimi — HL7 ORU^R01 + FHIR DiagnosticReport sözleşmesi. */
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { parseHl7, buildAck } from "../src/lib/hl7";
import {
  diagnosticReportToResult,
  planResultMatches,
  planResultQueue,
  resultFromHl7,
  resultPullSummary,
  resultTextSummary,
  toReturnedResult,
  validateResultConfig,
  type ResultItemView,
  type ResultRecordInput,
} from "../src/lib/resultPull";
import { matchReturnedResult } from "../src/lib/followupQueue";
import { bundleToResults, cfgFromEnv, pullOnce, validateEnv } from "../scripts/result-pull";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`[FAIL] ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, `${label} (beklenen ${JSON.stringify(b)}, geldi ${JSON.stringify(a)})`);
}

async function main(): Promise<void> {
  // ── 1. HL7 ORU^R01 ayrıştırma (gerçek HL7 mesajı) ──────────────────────────
  {
    const raw = [
      "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORU^R01|MSG100|P|2.5",
      "PID|||12345^^^KURUM^MRN|||KIM^A||19800101",
      "OBR||ACC9001||MR^MAGNETIK REZONANS^LN^MR Brain^LN|||202601151130|||||||||GÖĞÜS",
      "OBX|||ST||BEYIN BT'DE NORMAL BULGU||||||F|",
    ].join("\r");
    const msg = parseHl7(raw)!;
    ok(msg !== null, "ORU^R01 parse edilir");
    eq(msg.type, "ORU^R01", "MSH-9 tip");
    eq(msg.trigger, "R01", "triggger");

    const r = resultFromHl7(msg);
    ok(r !== null, "resultFromHl7 null değil");
    if (r) {
      eq(r.patientId, "12345", "PID-3 hasta kimliği");
      eq(r.accessionNumber, "ACC9001", "OBR-2 accession");
      eq(r.modality, "MR", "OBR-4 modalite kodu");
      eq(r.bodyPart, "GÖĞÜS", "OBR-16 vücut bölgesi");
      eq(r.text, "BEYIN BT'DE NORMAL BULGU", "OBX-5 sonuç metni");
      eq(r.at, "2026-01-15T11:30:00", "OBR-7 sonuç zamanı");
      eq(r.sourceType, "ORU^R01", "sourceType");
    }
  }

  // ── 2. ORU^R01 sınır koşulları ─────────────────────────────────────────────
  {
    // Sonuç metni yok → null.
    const noObx = parseHl7([
      "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORU^R01|MSG101|P|2.5",
      "PID|||12345^^^KURUM^MRN|||KIM^A||19800101",
      "OBR||ACC9002||CT^CT TORAKSI^LN",
    ].join("\r"))!;
    eq(resultFromHl7(noObx), null, "sonuç metni yok → null");

    // Accession yok → null.
    const noAcc = parseHl7([
      "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORU^R01|MSG102|P|2.5",
      "PID|||12345^^^KURUM^MRN|||KIM^A||19800101",
      "OBR||||CT^CT TORAKSI^LN",
      "OBX|||ST||NORMAL||||||F|",
    ].join("\r"))!;
    eq(resultFromHl7(noAcc), null, "accession yok → null");

    // ORM^O01 sipariş mesajı ORU olarak ayrıştırılmaz (tip eşleşmesi).
    const orm = parseHl7([
      "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORM^O01|MSG103|P|2.5",
      "PID|||12345^^^KURUM^MRN|||KIM^A||19800101",
      "OBR||ACC9003||CT^CT TORAKSI^LN",
      "OBX|||ST||NORMAL||||||F|",
    ].join("\r"))!;
    eq(orm.type.startsWith("ORU"), false, "ORM^O01 ORU değildir");
  }

  // ── 3. FHIR DiagnosticReport → sonuç ──────────────────────────────────────
  {
    const dr = {
      resourceType: "DiagnosticReport",
      id: "dr-1",
      status: "final",
      identifier: [{ system: "https://example.org/acc", value: "ACC7001" }],
      subject: { reference: "Patient/p1", identifier: [{ value: "PT-77" }] },
      code: { coding: [{ code: "MR", system: "http://dicom.nema.org/medical/sdodata" }], text: "MR Beyin" },
      conclusion: "Beyın BT'de lezyon yok.",
      effectiveDateTime: "2026-01-15T11:30:00",
      imagingStudy: { reference: "ImagingStudy/1.2.3.4.5" },
    };
    const r = diagnosticReportToResult(dr as never);
    ok(r !== null, "DiagnosticReport → sonuç null değil");
    if (r) {
      eq(r.accessionNumber, "ACC7001", "accessionNumber (identifier)");
      eq(r.patientId, "PT-77", "patientId (subject.identifier)");
      eq(r.modality, "MR", "modalite kodu");
      eq(r.bodyPart, "MR Beyin", "bodyPart (code.text)");
      eq(r.text, "Beyın BT'de lezyon yok.", "conclusion metni");
      eq(r.at, "2026-01-15T11:30:00", "effectiveDateTime");
      eq(r.studyUid, "1.2.3.4.5", "ImagingStudy referansından çalışma UID");
      eq(r.fhirSource, "DiagnosticReport/dr-1", "fhirSource");
    }

    // conclusion eksik → null + uyarı.
    const noConc = diagnosticReportToResult({ resourceType: "DiagnosticReport", id: "x", conclusion: "" } as never);
    eq(noConc, null, "conclusion eksik → null");

    // Coding modalite kodu tanınmaz → metinden tahmin (CT).
    const textMod = diagnosticReportToResult({
      resourceType: "DiagnosticReport", id: "y",
      code: { text: "CT TORAKSI" },
      conclusion: "Normal",
    } as never)!;
    eq(textMod.modality, "CT", "modalite metinden tahmin (CT TORAKSI)");
  }

  // ── 4. Çekilen sonuç → eşleme sözleşmesi ─────────────────────────────────
  {
    const rr = toReturnedResult({
      source: "hl7", patientId: "1", accessionNumber: "9001", modality: "MR",
      bodyPart: "BELIN", description: "", text: "Normal",
    });
    eq(rr.reportId, 9001, "sayısal accession → reportId");
    eq(rr.modality, "MR", "modalite geçer");
    eq(rr.bodyRegion, "BELIN", "vücut bölgesi → bodyRegion");

    // Sayısal olmayan accession → reportId null.
    const rr2 = toReturnedResult({
      source: "fhir", patientId: "1", accessionNumber: "ACC-77", modality: "CT",
      bodyPart: "", description: "", text: "Normal",
    });
    eq(rr2.reportId, null, "kısmetli accession → reportId null");

    // Çalışma UID sözleşmesi.
    const rr3 = toReturnedResult({
      source: "fhir", patientId: "1", accessionNumber: "1", modality: "CT",
      bodyPart: "", description: "", text: "x", studyUid: "1.2.3",
    });
    eq(rr3.studyUid, "1.2.3", "studyUid geçer");
  }

  // ── 5. Kuyruk planı + dedupe ───────────────────────────────────────────────
  {
    const inputs: ResultRecordInput[] = [
      { source: "hl7", patientId: "1", accessionNumber: "9001", modality: "MR", bodyPart: "B", description: "", text: "Normal" },
      { source: "hl7", patientId: "1", accessionNumber: "9001", modality: "MR", bodyPart: "B", description: "", text: "Normal" },
      { source: "hl7", patientId: "1", accessionNumber: "9002", modality: "CT", bodyPart: "B", description: "", text: "  Normal   " },
      { source: "hl7", patientId: "1", accessionNumber: "", modality: "CT", bodyPart: "B", description: "", text: "Normal" },
      { source: "hl7", patientId: "1", accessionNumber: "9003", modality: "CT", bodyPart: "B", description: "", text: "" },
    ];
    const plan = planResultQueue(inputs);
    eq(plan.accepted.length, 2, "dedupe: 2 kabul (tekrarlayan + boşluklar atlandı)");
    eq(plan.skipped.length, 3, "3 atlandı");
    ok(plan.skipped.some((s) => s.includes("tekrarlayan")), "tekrarlayan sonuç atlandı");
    ok(plan.skipped.some((s) => s.includes("accessionNumber/text")), "zorunlu alan eksik atlandı");
  }

  // ── 6. Eşleme planı — açık görevlere kapatma ───────────────────────────────
  {
    const tasks = [
      { id: 1, status: "acik" as const, dueDate: "2026-01-10", severity: "orta", message: "MR izle", modality: "MR", bodyRegion: "BELIN", studyUid: "1.2.3", reportId: null },
      { id: 2, status: "acik" as const, dueDate: "2026-01-10", severity: "orta", message: "CT izle", modality: "CT", bodyRegion: "GÖĞÜS", studyUid: "1.2.4", reportId: null },
    ];
    const items: ResultItemView[] = [
      { id: 1, batchId: "b", source: "hl7", patientId: "1", accessionNumber: "9001", modality: "MR", bodyPart: "BELIN", description: "", text: "Normal", at: "2026-01-15T11:30:00", studyUid: "", fhirSource: "", status: "pending", matchedTaskId: 0, createdAt: new Date() },
      { id: 2, batchId: "b", source: "hl7", patientId: "1", accessionNumber: "9002", modality: "CT", bodyPart: "GÖĞÜS", description: "", text: "Lezyon var", at: "2026-01-15T11:30:00", studyUid: "", fhirSource: "", status: "pending", matchedTaskId: 0, createdAt: new Date() },
      // Belirsiz: iki aday (MR + CT, bölge eşleşmez) → eşleşme YAPILMAZ.
      { id: 3, batchId: "b", source: "hl7", patientId: "1", accessionNumber: "9003", modality: "US", bodyPart: "", description: "", text: "Sorunsuz", at: "2026-01-15T11:30:00", studyUid: "", fhirSource: "", status: "pending", matchedTaskId: 0, createdAt: new Date() },
      // Zaten kapalı öge ×.
      { id: 4, batchId: "b", source: "hl7", patientId: "1", accessionNumber: "9004", modality: "MR", bodyPart: "BELIN", description: "", text: "Kapali", at: "2026-01-15T11:30:00", studyUid: "", fhirSource: "", status: "closed", matchedTaskId: 1, createdAt: new Date() },
    ];
    const plan = planResultMatches(items, tasks);
    eq(plan.matches.length, 2, "2 eşleşme (belirsiz × kapalı öge pas edilir)");
    eq(plan.unmatched.length, 2, "2 eşleşmeyen");
    if (plan.matches.length === 2) {
      eq(plan.matches[0].task.id, 1, "ilk eşleşme görev 1");
      eq(plan.matches[0].task.status, "tamamlandi", "görev kapatıldı");
      eq(plan.matches[0].task.outcome, "Normal", "outcome metni");
      eq(plan.matches[0].task.outcomeAt, "2026-01-15T11:30:00", "outcome zamanı");
      eq(plan.matches[1].task.id, 2, "ikinci eşleşme görev 2");
      eq(plan.matches[1].task.outcome, "Lezyon var", "ikinci outcome");
    }
    // Eşleşme razones.
    ok(plan.matches[0].reason.includes("Tek aday"), "eşleşme razones (tek aday)");
  }

  // ── 7. matchReturnedResult ile tutarlılık ──────────────────────────────────
  {
    const task = { id: 5, status: "acik" as const, dueDate: "", severity: "", message: "x", modality: "CT", bodyRegion: "GÖĞÜS" };
    // İki aday: rapor kimliği eşleşmez + modalite fall-through belirsiz → eşleşme YAPILMAZ.
    const task2 = { id: 6, status: "acik" as const, dueDate: "", severity: "", message: "y", modality: "MR", bodyRegion: "BELIN" };
    const m = matchReturnedResult({ reportId: 9001, text: "x" }, [task, task2]);
    eq(m.task, null, "rapor kimliği eşleşmez + belirsiz → eşleşme yok");
    const m2 = matchReturnedResult({ reportId: 5, text: "x" }, [task]);
    ok(m2.task !== null, "rapor kimliği eşleşir");
    const m3 = matchReturnedResult({ modality: "CT", bodyRegion: "GÖĞÜS", text: "x" }, [task]);
    ok(m3.task !== null, "modalite+bölge tek aday eşleşir");
  }

  // ── 8. Özet + metin özeti ─────────────────────────────────────────────────
  {
    const items: ResultItemView[] = [
      { id: 1, batchId: "b", source: "hl7", patientId: "", accessionNumber: "1", modality: "", bodyPart: "", description: "", text: "a", at: "", studyUid: "", fhirSource: "", status: "matched", matchedTaskId: 1, createdAt: new Date() },
      { id: 2, batchId: "b", source: "hl7", patientId: "", accessionNumber: "2", modality: "", bodyPart: "", description: "", text: "b", at: "", studyUid: "", fhirSource: "", status: "unmatched", matchedTaskId: 0, createdAt: new Date() },
      { id: 3, batchId: "b", source: "hl7", patientId: "", accessionNumber: "3", modality: "", bodyPart: "", description: "", text: "c", at: "", studyUid: "", fhirSource: "", status: "pending", matchedTaskId: 0, createdAt: new Date() },
    ];
    const sum = resultPullSummary(items);
    eq(sum.total, 3, "toplam");
    eq(sum.matched, 1, "eşleşen");
    eq(sum.unmatched, 1, "eşleşmeyen");
    eq(sum.pending, 1, "bekleyen");

    eq(resultTextSummary("a  b\n c"), "a b c", "metin özeti normalized");
    eq(resultTextSummary("x".repeat(200), 10), "x".repeat(10), "metin özeti sınırı");
  }

  // ── 9. Yapılandırma doğrulama ─────────────────────────────────────────────
  {
    eq(validateResultConfig({ baseUrl: "", token: "t", username: "", password: "", timeoutMs: 1000, defaultModality: "" })?.includes("FHIR_URL") === true, true, "boş baseUrl → hata");
    eq(validateResultConfig({ baseUrl: "ftp://x", token: "t", username: "", password: "", timeoutMs: 1000, defaultModality: "" }) !== null, true, "ftp URL → hata");
    eq(validateResultConfig({ baseUrl: "https://f.x/r4", token: "", username: "", password: "", timeoutMs: 1000, defaultModality: "" })?.includes("FHIR_TOKEN") === true, true, "kimlik yok → hata");
    eq(validateResultConfig({ baseUrl: "https://f.x/r4", token: "t", username: "", password: "", timeoutMs: 1000, defaultModality: "" }), null, "geçerli yapılandırma");
    ok(validateEnv(cfgFromEnv()) !== null, "cfgFromEnv boş env → yapılandırma hatası");
  }

  // ── 10. Köprü: bundle → sonuç + çekim (gerçek fetch mock) ─────────────────
  {
    const bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        { resource: {
          resourceType: "DiagnosticReport", id: "d1",
          identifier: [{ system: "acc", value: "ACC1" }],
          subject: { identifier: [{ value: "P1" }] },
          code: { coding: [{ code: "CT" }] },
          conclusion: "Normal CT",
          effectiveDateTime: "2026-01-15T10:00:00",
        } },
        { resource: { resourceType: "ServiceRequest", id: "s1" } },
        { resource: { resourceType: "DiagnosticReport", id: "d2", conclusion: "" } },
      ],
    };
    const out = bundleToResults(bundle);
    eq(out.results.length, 1, "bundle → 1 sonuç (ServiceRequest atlandı, conclusion eksik atlandı)");
    eq(out.skipped.length, 1, "1 atlandı (conclusion eksik)");
    if (out.results[0]) {
      eq(out.results[0].accessionNumber, "ACC1", "köprü accessionNumber");
      eq(out.results[0].modality, "CT", "köprü modalite");
      eq(out.results[0].text, "Normal CT", "köprü metin");
      eq(out.results[0].source, "fhir", "köprü source");
    }

    process.env.HIS_BASE_URL = "http://127.0.0.1:3998";
    process.env.HIS_API_KEY = "kr";
    const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined, headers: init?.headers as Record<string, string> | undefined });
      if (url.includes("type=DiagnosticReport")) {
        return new Response(JSON.stringify(bundle), { status: 200, headers: { "content-type": "application/fhir+json" } });
      }
      if (url.includes("/api/his/results")) {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, accepted: body.results?.length ?? 0, batchId: "res-test" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;

    const r = await pullOnce({ baseUrl: "https://f.example/r4", token: "tok", username: "", password: "", timeoutMs: 5000, defaultModality: "" }, () => {});
    globalThis.fetch = origFetch;
    ok(r.ok, `köprü çekimi başarılı (${r.error ?? ""})`);
    const pushes = calls.filter((c) => c.url.includes("/api/his/results"));
    eq(pushes.length, 1, "uç 1 kez çağrıldı");
    const push = pushes[0];
    eq(push?.headers?.["x-api-key"], "kr", "push x-api-key");
    const pushed = JSON.parse(push?.body ?? "null");
    eq(pushed?.source, "fhir", "push source");
    eq(Array.isArray(pushed?.results) && pushed.results.length === 1, true, "push results dizisi");

    // Kimlik hatası: 401 → çekim hatası.
    const orig2 = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const r2 = await pullOnce({ baseUrl: "https://f.example/r4", token: "bad", username: "", password: "", timeoutMs: 5000, defaultModality: "" }, () => {});
    globalThis.fetch = orig2;
    ok(!r2.ok && /kimlik/.test(r2.error ?? ""), `401 → kimlik hatası (${r2.error})`);
  }

  // ── 11. ACK sözleşmesi (MLLP köprüsü döner) ───────────────────────────────
  {
    const msg = parseHl7([
      "MSH|^~\\&|HBYS|HASTA|EMR|KURUM|20260115120000||ORU^R01|MSG200|P|2.5",
      "PID|||12345^^^KURUM^MRN|||KIM^A||19800101",
      "OBR||ACC9009||MR^MR^LN",
      "OBX|||ST||NORMAL||||||F|",
    ].join("\r"))!;
    const ack = buildAck(msg, "AA", "Sonuc alindi");
    ok(ack.startsWith("\x0b"), "ACK MLLP VT ile başlar");
    ok(ack.endsWith("\x1c\r"), "ACK MLLP kare ile biter");
    ok(ack.includes("MSA|AA|MSG200"), "ACK kontrol kimliği taşır");
  }

  console.log(`\n${passed} geçti, ${failed} başarısız`);
  if (failed > 0) process.exit(1);
}

void main().then(
  () => {
    console.log("RESULT-PULL TEST TAMAMLANDI");
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);

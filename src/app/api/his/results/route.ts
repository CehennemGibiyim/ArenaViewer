import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { applyResultMatches, enqueueResults, resultProgress } from "@/lib/server/resultRepo";
import { diagnosticReportToResult, resultFromHl7, type ResultRecordInput } from "@/lib/resultPull";

export const dynamic = "force-dynamic";

/**
 * HBYS/RIS sonuç çekimi alımı (d-followup).
 *
 * Köprü süreçlerinden sonuç gelir:
 *  - HL7 MLLP sunucusu: ORU^R01 ayrıştırır, `{ source: "hl7", results: [...] }`
 *    gövdesi ile POST eder (x-api-key = HIS_API_KEY).
 *  - FHIR çekim köprüsü: DiagnosticReport serilerini çeker,
 *    `{ source: "fhir", results: [...] }` ile POST eder.
 *
 * Gövde şekilleri:
 *  - `{ source, results: [ResultRecordInput] }`      → kuyruğa yaz (enqueue)
 *  - `{ source, bundle }` (FHIR Bundle)               → DiagnosticReport'ten çıkar + yaz
 *  - `{ raw }` (HL7 ORU metni)                         → ORU^R01 ayrıştır + yaz
 *  - `{ apply: true }`                                 → çekilen sonuca pas three: açık
 *    takip görevleri eşlenir (belirsizse eşleşme YAPILMAZ) ve kapatılır.
 *
 * GET `?batchId=...`: kuyruk özeti (ilerleme + sonuç metni özeti; şifreli metin
 * asla dönmez).
 */
export async function POST(req: NextRequest) {
  const key = process.env.HIS_API_KEY;
  if (!key) return NextResponse.json({ error: "HIS entegrasyonu yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  if (given.length !== exp.length || !timingSafeEqual(given, exp)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON gerekli" }, { status: 400 });

  // Çekme raporu: kuyruğa yazılmış sonuçlar eşlenir + görevler kapatılır.
  if (body.apply === true) {
    const batchId = String(body.batchId ?? "");
    if (!batchId) return NextResponse.json({ error: "batchId gerekli" }, { status: 400 });
    try {
      const out = await applyResultMatches(batchId);
      return NextResponse.json({ ok: true, matched: out.matched, unmatched: out.unmatched, summary: out.summary });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // Çekilen sonuçlar (köprüden gelir): source + results dizisi.
  const source = String(body.source ?? "hl7") === "fhir" ? "fhir" : "hl7";
  let inputs: ResultRecordInput[] = [];

  if (Array.isArray(body.results)) {
    // Köprü zaten çıkarmış; doğrudan kuyruğa.
    inputs = (body.results as ResultRecordInput[]).map((r) => ({ ...r, source }));
  } else if (typeof body.bundle === "object" && body.bundle !== null) {
    // FHIR Bundle: entry[].resource → DiagnosticReport → sonuç.
    const bundle = body.bundle as { entry?: { resource?: Record<string, unknown> }[] };
    for (const entry of bundle.entry ?? []) {
      const res = entry?.resource;
      if (!res || res.resourceType !== "DiagnosticReport") continue;
      const out = diagnosticReportToResult(res);
      if (!out) continue;
      inputs.push({
        source: "fhir",
        patientId: out.patientId,
        accessionNumber: out.accessionNumber,
        modality: out.modality,
        bodyPart: out.bodyPart,
        description: out.description,
        text: out.text,
        at: out.at,
        studyUid: out.studyUid,
        fhirSource: out.fhirSource,
      });
    }
  } else if (typeof body.raw === "string" && body.raw.trim()) {
    // Ham HL7 ORU metni (MLLP köprüsü çerçevesiz metni burada ayrıştırır).
    const { parseHl7 } = await import("@/lib/hl7");
    const msg = parseHl7(body.raw);
    if (!msg) return NextResponse.json({ error: "Geçersiz HL7 mesajı" }, { status: 400 });
    const out = resultFromHl7(msg);
    if (!out) return NextResponse.json({ error: "ORU^R01'den sonuç çıkarılamadı (accession/sonuç metni gerekli)" }, { status: 422 });
    inputs.push({
      source: "hl7",
      patientId: out.patientId,
      accessionNumber: out.accessionNumber,
      modality: out.modality,
      bodyPart: out.bodyPart,
      description: out.description,
      text: out.text,
      at: out.at,
    });
  } else {
    return NextResponse.json({ error: "results | bundle | raw alanlarından biri gerekli" }, { status: 400 });
  }

  const batchId = `res-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const res = await enqueueResults(inputs, batchId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  await audit(null, "his.result.enqueue", "his_results", "", {
    batch: batchId,
    source,
    accepted: res.accepted,
    skipped: res.skipped.length,
  });
  return NextResponse.json({ ok: true, accepted: res.accepted, skipped: res.skipped, batchId });
}

export async function GET(req: NextRequest) {
  const key = process.env.HIS_API_KEY;
  if (!key) return NextResponse.json({ error: "HIS entegrasyonu yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  if (given.length !== exp.length || !timingSafeEqual(given, exp)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const batchId = (req.nextUrl.searchParams.get("batchId") ?? "").trim();
  if (!batchId) return NextResponse.json({ error: "batchId gerekli" }, { status: 400 });
  try {
    return NextResponse.json(await resultProgress(batchId));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

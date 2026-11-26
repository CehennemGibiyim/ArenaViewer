/**
 * DICOMweb STOW-RS alımı (`POST /api/dicomweb/studies`) — modalite/ağ geçidi/Orthanc
 * örneklerini kabul eder. **DIMSE C-STORE değildir**: AE başlığı/C-ECHO yoktur;
 * DIMSE gereken kurumlar önüne Orthanc/dcm4chee gibi DICOMweb ağ geçidi koymalıdır.
 *
 * Kimlik: `x-api-key` = INGEST_API_KEY ortam değişkeni (makine→makine; kullanıcı oturumu yok).
 * Gövde: multipart/related; her parça application/dicom. Örnekler şifreli depoya yazılır,
 * study kaydı (studyUid ile) açılır/güncellenir, denetim kaydına düşülür.
 * Yanıt: application/dicom+json (00081199 başarı / 00081198 hata referansları);
 * en az bir başarı varsa 200, hiç başarı yoksa 422 döner.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { studies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/server/audit";
import { upsertStudy } from "@/lib/server/studyRepo";
import { storeDicomInstance } from "@/lib/server/storeInstance";
import { parseAllMultipart } from "@/lib/server/pacs";
import {
  validateIngestInstance,
  buildStowResponseBody,
  INGEST_MAX_INSTANCES,
  INGEST_MAX_INSTANCE_BYTES,
  INGEST_MAX_TOTAL_BYTES,
  type IngestResultEntry,
} from "@/lib/dicomIngest";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const key = process.env.INGEST_API_KEY;
  if (!key) return NextResponse.json({ error: "DICOMweb alımı yapılandırılmamış (INGEST_API_KEY)" }, { status: 503 });
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  if (given.length !== exp.length || !timingSafeEqual(given, exp)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!/multipart\/related/i.test(contentType)) {
    return NextResponse.json({ error: "multipart/related gövdesi gerekli" }, { status: 415 });
  }
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "Boş gövde" }, { status: 400 });
  if (buf.length > INGEST_MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: `Gövde sınırı aşıldı (${Math.round(buf.length / 1048576)} MB > ${INGEST_MAX_TOTAL_BYTES / 1048576} MB)` }, { status: 413 });
  }

  const parts = parseAllMultipart(buf, contentType);
  if (parts.length === 0) return NextResponse.json({ error: "Gövdede DICOM parçası bulunamadı" }, { status: 400 });
  if (parts.length > INGEST_MAX_INSTANCES) {
    return NextResponse.json({ error: `Tek istekte en çok ${INGEST_MAX_INSTANCES} örnek alınabilir` }, { status: 413 });
  }

  const results: IngestResultEntry[] = [];
  let storedBytes = 0;
  for (const part of parts) {
    if (part.length > INGEST_MAX_INSTANCE_BYTES) {
      results.push({ sopUid: "0.0", ok: false, error: `Örnek sınırı aşıldı (${Math.round(part.length / 1048576)} MB)` });
      continue;
    }
    const v = validateIngestInstance(part);
    if (!v.ok) {
      results.push({ sopUid: "0.0", ok: false, error: v.error });
      continue;
    }
    try {
      const { id: studyId } = await upsertStudy(
        {
          studyUid: v.info.studyUid,
          patientName: v.info.patientName,
          patientId: v.info.patientId,
          patientAge: v.info.patientAge,
          patientSex: v.info.patientSex,
          studyDate: v.info.studyDate,
          institution: v.info.institution,
          modality: v.info.modality,
          bodyPart: v.info.bodyPart,
          seriesDescription: v.info.seriesDescription || "DICOMweb alımı",
          accession: v.info.accession,
        },
        "dicomweb"
      );
      const out = await storeDicomInstance(studyId, `${v.info.sopUid}.dcm`, part);
      storedBytes += out.bytes;
      results.push({ sopUid: v.info.sopUid, ok: true });
    } catch (e) {
      results.push({ sopUid: v.info.sopUid, ok: false, error: e instanceof Error ? e.message : "depolama hatası" });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  await audit(null, "dicom.ingest", "study", "", {
    received: parts.length,
    stored: okCount,
    rejected: results.length - okCount,
    bytes: storedBytes,
  });

  const body = buildStowResponseBody(results);
  return NextResponse.json(body, {
    status: okCount > 0 ? 200 : 422,
    headers: { "Content-Type": "application/dicom+json", "Cache-Control": "no-store" },
  });
}

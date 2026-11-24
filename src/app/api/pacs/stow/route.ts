import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { loadPacsConfig } from "@/lib/server/pacsConfig";
import { stowInstance } from "@/lib/server/pacs";
import { mapReport } from "@/lib/server/studyRepo";
import { buildReportSr } from "@/lib/dicomSr";

export const dynamic = "force-dynamic";

/**
 * Raporu DICOM Basic Text SR olarak PACS'e STOW-RS ile gönderir (E-STOW).
 * Yalnızca onaylanmış rapor gönderilebilir; taslak reddedilir.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as { reportId?: number };
  const id = Number(b.reportId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz rapor kimliği" }, { status: 400 });

  const rr = (await db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id)).where(eq(reports.id, id)).limit(1))[0];
  if (!rr) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  const rep = mapReport(rr.r, rr.s);
  if (rep.status !== "onaylandi") return NextResponse.json({ error: "Yalnızca onaylanmış rapor PACS'e gönderilebilir" }, { status: 409 });

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  const sr = buildReportSr({
    patientName: rep.patientName, patientId: rep.patientId, patientSex: rep.patientSex, patientAge: rep.patientAge,
    studyUid: rep.studyUid, studyDate: rep.studyDate, institution: rep.institution, studyModality: rep.modality,
    clinicalInfo: rep.clinicalInfo, technique: rep.technique, findings: rep.findingsText, impression: rep.impression,
    recommendation: rep.recommendation, measurements: "", approvedBy: rep.approvedBy, doctorTitle: rep.doctorTitle,
    approvedAt: rep.approvedAt,
  });

  try {
    const out = await stowInstance(cfg, sr);
    await audit(a.user, "pacs.send_sr", "report", String(id), { pacs: cfg.name || cfg.kind, stored: out.stored, failed: out.failed.length });
    return NextResponse.json({ ...out, pacs: cfg.name || cfg.kind });
  } catch (e) {
    await audit(a.user, "pacs.send_sr_failed", "report", String(id), { pacs: cfg.name || cfg.kind });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

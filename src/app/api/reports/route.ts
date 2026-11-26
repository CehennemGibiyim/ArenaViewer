import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportVersions, reports, studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize, sha256 } from "@/lib/server/auth";
import { createFollowupFromReport } from "@/lib/server/closeLoop";
import { authRequired } from "@/lib/server/auth";
import { encryptText } from "@/lib/server/crypto";
import { missingReviewReasons, sanitizeReviewReasons } from "@/lib/findingReview";
import { mapReport, upsertStudy, type StudyMeta } from "@/lib/server/studyRepo";
import { reportHistoryQueryLimit, selectReportHistory } from "@/lib/reportHistory";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
const err = (m: string, s = 400) => NextResponse.json({ error: m }, { status: s });

export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const pid = sp.get("patientId");
  const uid = sp.get("studyUid");
  const filter = { patientId: pid, studyUid: uid };
  const query = db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id));
  const filteredQuery = uid ? query.where(eq(studies.studyUid, uid)) : query;
  const orderedQuery = filteredQuery.orderBy(desc(reports.id));
  const limit = reportHistoryQueryLimit(filter);
  const rows = limit === null ? await orderedQuery : await orderedQuery.limit(limit);
  const history = rows.map((x) => ({ ...mapReport(x.r, x.s), keyImageDataUrl: "" }));
  return NextResponse.json(selectReportHistory(history, filter));
}

interface SaveBody {
  reportId?: number;
  action?: "save" | "approve";
  study: StudyMeta;
  report: {
    mode: string; clinicalInfo: string; technique: string; findingsText: string; impression: string; recommendation: string;
    findingsJson: Finding[]; findingsApproval: Record<string, FindingApprovalStatus>;
    findingsReason?: Record<string, string>;
    triageLevel: string; triageScore: number; aiModel: string; engine: string; modelCard: string;
    keyImageDataUrl: string; institution?: string;
  };
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const { user } = a;
  const body = (await req.json().catch(() => null)) as SaveBody | null;
  if (!body?.study?.studyUid || !body.report) return err("Eksik veri");
  const r = body.report;
  const findings = Array.isArray(r.findingsJson) ? r.findingsJson : [];
  const approvals = r.findingsApproval ?? {};
  // Gerekçe yalnız reddedilen/düzenlenen bulgular için ve yalnız temizlenmiş hâlde saklanır.
  const reasons = sanitizeReviewReasons(r.findingsReason, approvals);
  const approve = body.action === "approve";

  const { id: studyId } = await upsertStudy(body.study, "yerel");

  let current: typeof reports.$inferSelect | undefined;
  if (body.reportId) {
    current = (await db.select().from(reports).where(eq(reports.id, body.reportId)).limit(1))[0];
    if (!current) return err("Rapor bulunamadı", 404);
    if (current.status === "onaylandi") return err("Onaylı rapor değiştirilemez. Düzeltme için addendum ekleyin.", 409);
  }

  let approvedAt: Date | null = null;
  if (approve) {
    // AUTH_MODE=hesap ise onay sahibi oturumdan gelir (gerçek hesap); demo modunda
    // tek operatör profili kullanılır. İki durumda da onay için tüm bulguların
    // gözden geçirilmesi aranır.
    if (!user.fullName.trim()) return err("Onay için Yönetim → Hekim profili bölümünde ad soyad tanımlı olmalı.");
    const pending = findings.filter((f) => (approvals[f.id] ?? "bekliyor") === "bekliyor").length;
    if (pending > 0) return err(`${pending} bulgu henüz gözden geçirilmedi`);
    const missing = missingReviewReasons(findings, approvals, reasons);
    if (missing.length > 0) return err(`Reddedilen/düzenlenen ${missing.length} bulgu için gerekçe yazılmalı`);
    approvedAt = new Date();
  }

  const version = (current?.version ?? 0) + 1;
  let contentHash = "";
  let signatureMeta = "";
  if (approve && approvedAt) {
    contentHash = sha256(
      JSON.stringify({
        studyUid: body.study.studyUid, technique: r.technique, findingsText: r.findingsText, impression: r.impression,
        recommendation: r.recommendation, findings: findings.map((f) => ({ id: f.id, l: f.label, k: f.keySliceNumber, s: f.severity })),
        approvals, version, approver: { fullName: user.fullName, regNo: user.regNo }, approvedAt: approvedAt.toISOString(),
      })
    );
    signatureMeta = JSON.stringify({
      algo: "SHA-256",
      method: authRequired() ? "Oturum açma ile doğrulanmış kullanıcı onayı" : "Yerel onay — demo modu (oturum tanımlı değil)",
      signer: { fullName: user.fullName, title: user.title, regNo: user.regNo }, signedAt: approvedAt.toISOString(),
      note: "Bu onay, imza sahibinin kimliğini doğrulamaz ve 5070 sayılı Kanun kapsamındaki nitelikli elektronik imza (NES) değildir. Hash yalnızca içerik değişikliğini saptar.",
    });
  }

  const values = {
    studyId, status: approve ? "onaylandi" : "taslak", version, mode: r.mode,
    clinicalInfo: encryptText(r.clinicalInfo ?? ""), technique: r.technique, findingsText: r.findingsText,
    impression: r.impression, recommendation: r.recommendation, findingsJson: findings, findingsApproval: approvals, findingsReason: reasons,
    triageLevel: r.triageLevel, triageScore: r.triageScore, aiModel: r.aiModel, engine: r.engine, modelCard: r.modelCard,
    approvedBy: approve ? user.fullName : "", doctorTitle: approve ? user.title : "", doctorRegNo: approve ? user.regNo : "",
    institution: r.institution ?? "", approvedAt, contentHash, signatureMeta,
    keyImageDataUrl: encryptText(r.keyImageDataUrl ?? ""), updatedAt: new Date(),
  };

  let reportId: number;
  if (current) {
    await db.update(reports).set(values).where(eq(reports.id, current.id));
    reportId = current.id;
  } else {
    reportId = (await db.insert(reports).values({ ...values, createdBy: user.id }).returning({ id: reports.id }))[0].id;
  }

  await db.insert(reportVersions).values({
    reportId, versionNo: version, action: approve ? "onay" : "kayıt", createdBy: user.id, createdByName: user.fullName,
    snapshot: JSON.stringify({
      status: values.status, technique: r.technique, findingsText: r.findingsText, impression: r.impression,
      recommendation: r.recommendation, findings: findings.map((f) => ({ id: f.id, label: f.label, slice: f.keySliceNumber, severity: f.severity })),
      approvals, reasons, engine: r.engine, keyImageSha: sha256(r.keyImageDataUrl ?? ""),
      // v2: tam bulgu dizisi — eski sürüme geri yükleme bulgu tablosunu da kapsasın diye.
      findingsJson: findings,
    }),
  });
  await db.update(studies).set({
    workStatus: approve ? "onayli" : "taslak", triageLevel: r.triageLevel, triageScore: r.triageScore, aiEngine: r.engine, updatedAt: new Date(),
  }).where(eq(studies.id, studyId));
  await audit(user, approve ? "report.approve" : "report.save", "report", reportId, { version, studyId, ...(approve ? { contentHash } : {}) });

  // D2: onaylı rapordaki takip önerisi çalışma listesine yapılan bir görev olarak düşer.
  let followupId: number | null = null;
  if (approve) {
    try {
      followupId = await createFollowupFromReport({
        studyUid: body.study.studyUid,
        reportId,
        modality: body.study.modality ?? "",
        bodyPart: body.study.bodyPart ?? "",
        recommendation: r.recommendation,
      });
      if (followupId) await audit(user, "notify.followup.fromReport", "notification", followupId, { reportId });
    } catch (e) {
      console.error("takip önerisi oluşturulamadı:", e);
    }
  }

  return NextResponse.json({
    ok: true, reportId, studyId, status: values.status, version, contentHash, followupId,
    approvedAt: approvedAt?.toISOString() ?? null, approvedBy: values.approvedBy, doctorTitle: values.doctorTitle, doctorRegNo: values.doctorRegNo,
  });
}

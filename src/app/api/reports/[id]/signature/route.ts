import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, reports, studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import {
  buildSignatureRecord, canonicalSignature, isQualifiedMethod,
  SIGNATURE_METHODS, type SignatureMethod,
} from "@/lib/esign";

export const dynamic = "force-dynamic";

const ACTION = "report.esignature";

async function loadReport(id: number) {
  return (await db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id)).where(eq(reports.id, id)).limit(1))[0] ?? null;
}

/**
 * İmza kayıtlarını listeler. Kayıt, denetim zincirinde `report.esignature`
 * eylemi olarak tutulur; ayrı tabloya gerek kalmaz ve zincir bozulmadan geçmiş
 * okunabilir.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Geçersiz rapor" }, { status: 400 });
  const rows = await db.select().from(auditLogs)
    .where(and(eq(auditLogs.action, ACTION), eq(auditLogs.entityType, "report"), eq(auditLogs.entityId, String(id))))
    .orderBy(asc(auditLogs.id));
  const records = rows
    .map((r) => {
      try { return JSON.parse(r.details) as Record<string, unknown>; } catch { return null; }
    })
    .filter(Boolean);
  return NextResponse.json({ qualifiedAvailable: false, records });
}

/** Yeni imza kaydı oluşturur. NES sağlayıcısı entegre olmadıkça kayıt nesne nitelikli sayılmaz. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  const rr = await loadReport(id);
  if (!rr) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { method?: unknown } | null;
  const method = SIGNATURE_METHODS.some((m) => m.id === body?.method) ? (body!.method as SignatureMethod) : "hesap-parola-mfa";
  const record = buildSignatureRecord({
    reportId: id,
    studyUid: rr.s.studyUid ?? "",
    contentHash: rr.r.contentHash || "",
    signerName: a.user.fullName,
    signerRegNo: a.user.regNo,
    institution: rr.r.institution || "",
    method,
    version: rr.r.version ?? 0,
  });
  // Hash olmayan (taslak) içeriğe imza kaydı düşürülemez.
  if (!record.contentHash) return NextResponse.json({ error: "İmzalanacak onaylı içerik yok (rapor henüz onaylanmadı)." }, { status: 409 });
  if (method === "nes-nitelikli") {
    return NextResponse.json({ error: "NES sağlayıcısı entegre edilmedi; nitelikli imza yöntemi kullanılamaz." }, { status: 409 });
  }

  await audit(a.user, ACTION, "report", id, { record: canonicalSignature(record), qualified: isQualifiedMethod(method) });
  return NextResponse.json({ record, qualified: isQualifiedMethod(method), note: "Kayıt denetim zincirine işlendi; NES nitelikli imza için sağlayıcı entegrasyonu gerekir." });
}

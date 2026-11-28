import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportVersions, reports } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize, sha256 } from "@/lib/server/auth";
import { parseReportSnapshot } from "@/lib/reportDiff";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Eski sürüme geri yükleme (r-version).
 *
 * Geçmişe dokunulmaz: hedef anlık görüntü (snapshot) okunur ve İÇERİK GÜNCEL
 * rapordaki gibi YENİ bir sürüm olarak yazılır (action "geri-yükleme").
 * Geri yükleme her zaman raporu TASLAK yapar — onaylı bir içerik sessizce
 * geri gelmez; yeniden gözden geçirilip onaylanmalıdır. Anlık onaylı rapora
 * geri yükleme 409 ile reddedilir (mevcut düzenleme kuralıyla aynı).
 *
 * Bulgu tablosu: anlık görüntüde tam `findingsJson` varsa (v2 kayıtlar) bulgu
 * tablosu ve onay/gerekçe durumu da geri yüklenir. Eski kayıtlarda yalnız
 * metin alanları geri yüklenir; bulgu tablosu ve onayları KORUNUR ve yanıtta
 * `findingsPreserved: true` ile bildirilir.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Geçersiz rapor" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { versionNo?: unknown } | null;
  const versionNo = Number(body?.versionNo);
  if (!Number.isFinite(versionNo) || versionNo < 1) return NextResponse.json({ error: "Geçersiz sürüm numarası" }, { status: 400 });

  const current = (await db.select().from(reports).where(eq(reports.id, id)).limit(1))[0];
  if (!current) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  if (current.status === "onaylandi") {
    return NextResponse.json({ error: "Onaylı rapor geri yüklenemez. Değişiklik için addendum ekleyin." }, { status: 409 });
  }

  const row = (await db.select().from(reportVersions)
    .where(and(eq(reportVersions.reportId, id), eq(reportVersions.versionNo, versionNo)))
    .limit(1))[0];
  if (!row) return NextResponse.json({ error: "Sürüm bulunamadı" }, { status: 404 });

  const snap = parseReportSnapshot(row.snapshot);
  if (!snap) return NextResponse.json({ error: "Bu sürümün anlık görüntüsü okunamadı; geri yükleme yapılamaz." }, { status: 409 });

  const hasFindings = Array.isArray(snap.findingsJson);
  const findingsJson = (hasFindings ? snap.findingsJson : current.findingsJson) as Finding[];
  const approvals = (snap.approvals && typeof snap.approvals === "object" && !Array.isArray(snap.approvals)
    ? snap.approvals
    : current.findingsApproval) as Record<string, FindingApprovalStatus>;
  const reasons = (snap.reasons && typeof snap.reasons === "object" && !Array.isArray(snap.reasons)
    ? snap.reasons
    : current.findingsReason) as Record<string, string>;

  const version = (current.version ?? 0) + 1;
  await db.update(reports).set({
    // Onay ve imza alanları sıfırlanır: geri yüklenen içerik yeniden onaylanmalı.
    status: "taslak", version,
    technique: String(snap.technique ?? ""),
    findingsText: String(snap.findingsText ?? ""),
    impression: String(snap.impression ?? ""),
    recommendation: String(snap.recommendation ?? ""),
    findingsJson, findingsApproval: approvals, findingsReason: reasons,
    engine: String(snap.engine ?? current.engine),
    contentHash: "", signatureMeta: "", approvedBy: "", doctorTitle: "", doctorRegNo: "", approvedAt: null,
    updatedAt: new Date(),
  }).where(eq(reports.id, id));

  await db.insert(reportVersions).values({
    reportId: id, versionNo: version, action: "geri-yükleme", createdBy: a.user.id, createdByName: a.user.fullName,
    snapshot: JSON.stringify({
      status: "taslak",
      technique: String(snap.technique ?? ""), findingsText: String(snap.findingsText ?? ""),
      impression: String(snap.impression ?? ""), recommendation: String(snap.recommendation ?? ""),
      findings: findingsJson.map((f) => ({ id: f.id, label: f.label, slice: f.keySliceNumber, severity: f.severity })),
      approvals, reasons, engine: String(snap.engine ?? current.engine),
      keyImageSha: sha256(""),
      findingsJson,
      // r-version: ölçüm / SR hash'leri snapshot'tan yeni sürüme taşınır (kayıp olmaz).
      measurementHash: snap.measurementHash,
      srHash: snap.srHash,
      restoredFrom: versionNo,
    }),
  });
  await audit(a.user, "report.restore", "report", id, { restoredFrom: versionNo, newVersion: version, findingsPreserved: !hasFindings });

  return NextResponse.json({
    ok: true, version, restoredFrom: versionNo,
    technique: String(snap.technique ?? ""), findingsText: String(snap.findingsText ?? ""),
    impression: String(snap.impression ?? ""), recommendation: String(snap.recommendation ?? ""),
    findingsJson, findingsApproval: approvals, findingsReason: reasons, engine: String(snap.engine ?? current.engine),
    measurementHash: snap.measurementHash ?? "",
    srHash: snap.srHash ?? "",
    findingsPreserved: !hasFindings,
  });
}

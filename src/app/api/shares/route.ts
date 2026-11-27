import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, shareLinks } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { SHARE_TTL_HOURS, isShareKind } from "@/lib/share";
import { createShare, listShares, putShareImages } from "@/lib/server/shareRepo";
import { MAX_SHARE_IMAGES, buildShareImagePackage, formatBytes } from "@/lib/shareImage";

export const dynamic = "force-dynamic";

/** Paylaşım bağlantısı listesi (yalnızca oluşturan kullanıcı; yönetici tümü). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rows = await listShares(a.user.role === "yonetici" ? "all" : a.user.id);
  return NextResponse.json({ shares: rows });
}

/** Yeni paylaşım bağlantısı: `report` (metin + anahtar kesit) ya da `image` (anonim JPEG kesitler). */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (!isShareKind(b.kind)) {
    return NextResponse.json({ error: "Paylaşım türü 'report' ya da 'image' olmalı" }, { status: 400 });
  }
  if (b.kind === "image") return createImageShare(req, a.user, b);

  const reportId = Number(b.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return NextResponse.json({ error: "Geçersiz rapor kimliği" }, { status: 400 });
  const ttlHours = Number(b.ttlHours ?? 24);
  if (!(SHARE_TTL_HOURS as readonly number[]).includes(ttlHours)) {
    return NextResponse.json({ error: `Süre şunlardan biri olmalı: ${SHARE_TTL_HOURS.join(", ")} saat` }, { status: 400 });
  }

  const r = (await db.select({ id: reports.id, status: reports.status }).from(reports).where(eq(reports.id, reportId)).limit(1))[0];
  if (!r) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  if (r.status !== "onaylandi") return NextResponse.json({ error: "Yalnızca onaylı rapor paylaşılabilir" }, { status: 409 });

  const link = await createShare({
    kind: "report",
    reportId,
    createdBy: a.user.id,
    createdByName: `${a.user.title ? a.user.title + " " : ""}${a.user.fullName}`,
    ttlHours,
  });
  await audit(a.user, "share.create", "report", reportId, { tokenPrefix: link.token.slice(0, 8), ttlHours, expiresAt: link.expiresAt });
  return NextResponse.json({
    ok: true,
    token: link.token,
    url: `/paylas/${link.token}`,
    expiresAt: link.expiresAt,
  }, { status: 201 });
}


/**
 * Görüntü paylaşımı: istemci seçilen kesitleri **JPEG** olarak gönderir.
 *
 * Sunucu tarafı zorlamaları (istemciye güvenilmez):
 *  - kesit sayısı, kare boyutu, JPEG imzası ve toplam bayt tavanı (`buildShareImagePackage`),
 *  - aynı kesit iki kez gönderilemez,
 *  - hasta kimliği alanı **kabul edilmez** (gövdede `patient*` anahtarı varsa 400),
 *  - paket nesne deposuna yazılamazsa bağlantı yine de sessizce açık bırakılmaz:
 *    satır silinir ve hata döner.
 */
async function createImageShare(
  req: NextRequest,
  user: { id: number; username: string; role: string; fullName: string; title?: string },
  b: Record<string, unknown>,
) {
  if (Object.keys(b).some((k) => /^patient/i.test(k))) {
    return NextResponse.json({ error: "Görüntü paylaşımında hasta kimliği alanı kabul edilmez" }, { status: 400 });
  }
  const ttlHours = Number(b.ttlHours ?? 24);
  if (!(SHARE_TTL_HOURS as readonly number[]).includes(ttlHours)) {
    return NextResponse.json({ error: `Süre şunlardan biri olmalı: ${SHARE_TTL_HOURS.join(", ")} saat` }, { status: 400 });
  }
  const frames = Array.isArray(b.frames) ? (b.frames as Record<string, unknown>[]) : [];
  if (frames.length > MAX_SHARE_IMAGES) {
    return NextResponse.json({ error: `Tek paylaşımda en fazla ${MAX_SHARE_IMAGES} kesit` }, { status: 400 });
  }
  const built = buildShareImagePackage({
    label: String(b.label ?? ""),
    modality: String(b.modality ?? ""),
    studyDate: String(b.studyDate ?? ""),
    frames: frames.map((f) => ({
      slice: Number(f.slice),
      width: Number(f.width),
      height: Number(f.height),
      b64: String(f.b64 ?? ""),
    })),
  });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  const link = await createShare({
    kind: "image",
    createdBy: user.id,
    createdByName: `${user.title ? user.title + " " : ""}${user.fullName}`,
    ttlHours,
  });
  try {
    await putShareImages(link.token, built.pkg);
  } catch {
    // Yarım kalan bağlantı açık bırakılmaz (görüntüsüz "çalışan" link sessiz hatadır).
    await db.delete(shareLinks).where(eq(shareLinks.token, link.token));
    return NextResponse.json({ error: "Görüntüler depolanamadı; paylaşım oluşturulmadı" }, { status: 500 });
  }

  const totalBytes = built.pkg.frames.reduce((n, f) => n + f.bytes, 0);
  await audit(user, "share.create", "share", link.token.slice(0, 8), {
    kind: "image", ttlHours, expiresAt: link.expiresAt, frames: built.pkg.frames.length, bytes: totalBytes,
  });
  return NextResponse.json({
    ok: true,
    token: link.token,
    url: `/paylas/${link.token}`,
    expiresAt: link.expiresAt,
    frames: built.pkg.frames.length,
    totalLabel: formatBytes(totalBytes),
  }, { status: 201 });
}

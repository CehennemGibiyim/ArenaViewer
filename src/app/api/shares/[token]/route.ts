import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { revokeShare } from "@/lib/server/shareRepo";

export const dynamic = "force-dynamic";

/** Bağlantıyı kapatır: oluşturan kullanıcı ya da yönetici. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const token = (await params).token;
  if (!/^[0-9a-f]{48}$/.test(token)) return NextResponse.json({ error: "Geçersiz bağlantı" }, { status: 400 });
  const row = await revokeShare(token, a.user.id);
  if (!row) return NextResponse.json({ error: "Bağlantı bulunamadı" }, { status: 404 });
  if (row.revokedAt && a.user.role !== "yonetici" && row.createdBy !== a.user.id) {
    return NextResponse.json({ error: "Bu bağlantıyı kapatma yetkiniz yok" }, { status: 403 });
  }
  await audit(a.user, "share.revoke", "share", token.slice(0, 8), { alreadyClosed: !!row.revokedAt });
  return NextResponse.json({ ok: true, revoked: true });
}

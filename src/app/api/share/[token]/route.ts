import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { openImageShare, openShare } from "@/lib/server/shareRepo";

export const dynamic = "force-dynamic";

/**
 * Herkese açık paylaşım ucu (kimlik doğrulamasız). Erişim denetim kaydına işlenir.
 * Süresi dolmuş/kapatılmış bağlantılar 410 döner.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  // Görüntü paylaşımları ayrı depo/erişim yolundan gelir (anonim JPEG paketi).
  const image = await openImageShare(token);
  if (image.ok) {
    await audit(null, "share.access", "share", token.slice(0, 8), { kind: "image", frames: image.payload.frames.length });
    return NextResponse.json({ ...image.payload, watermark: `${token.slice(0, 8).toUpperCase()} · ${String(image.payload.expiresAt).slice(0, 10)}` });
  }
  const r = await openShare(token);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  await audit(null, "share.access", "share", token.slice(0, 8), {});
  return NextResponse.json({ ...r.payload, watermark: `${token.slice(0, 8).toUpperCase()} · ${String(r.payload.expiresAt).slice(0, 10)}` });
}

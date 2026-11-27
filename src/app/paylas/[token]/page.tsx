import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SharedImageView from "@/components/SharedImageView";
import SharedReportView from "@/components/SharedReportView";
import { audit } from "@/lib/server/audit";
import { openImageShare, openShare } from "@/lib/server/shareRepo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ATIKVIEWER — Süreli Paylaşım" };

/** Herkese açık süreli paylaşım sayfası (filigranlı, salt okunur, denetimli). */
export default async function PaylasPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  // Görüntü paylaşımı ayrı görünüm (anonim JPEG kareler, indirme yok).
  const image = await openImageShare(token);
  if (image.ok) {
    // Sayfa açılışı denetime yazılır (kare çekimleri ayrıca `share.image_access` üretir).
    await audit(null, "share.access", "share", token.slice(0, 8), { kind: "image", frames: image.payload.frames.length });
    return <SharedImageView payload={image.payload} token={token} />;
  }
  const r = await openShare(token);
  if (!r.ok) notFound();
  return <SharedReportView payload={r.payload} token={token} />;
}

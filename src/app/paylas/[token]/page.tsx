import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SharedReportView from "@/components/SharedReportView";
import { openShare } from "@/lib/server/shareRepo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ATIKVIEWER — Süreli Paylaşım" };

/** Herkese açık süreli paylaşım sayfası (filigranlı, salt okunur, denetimli). */
export default async function PaylasPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const r = await openShare(token);
  if (!r.ok) notFound();
  return <SharedReportView payload={r.payload} token={token} />;
}

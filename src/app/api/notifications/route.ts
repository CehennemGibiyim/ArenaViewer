import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { closeLoopUpdate, setFollowupStatus } from "@/lib/server/closeLoop";

export const dynamic = "force-dynamic";

const map = (r: typeof notifications.$inferSelect) => ({
  id: r.id,
  createdAt: r.createdAt,
  kind: (r.kind ?? "finding") as "finding" | "followup",
  severity: r.severity,
  studyUid: r.studyUid,
  message: r.message,
  ackBy: r.ackBy,
  ackByName: r.ackByName,
  ackAt: r.ackAt,
  relayedTo: r.relayedTo,
  relayedAt: r.relayedAt,
  escalated: r.escalated,
  escalatedAt: r.escalatedAt,
  modality: r.modality,
  bodyRegion: r.bodyRegion,
  recommendedIntervalDays: r.recommendedIntervalDays,
  dueDate: r.dueDate,
  status: r.status as "acik" | "tamamlandi" | "iptal",
  completedAt: r.completedAt,
  reportId: r.reportId,
});

/** Bildirimler; `?kind=followup` yalnız takip görevlerini verir. */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Number(sp.get("limit") ?? "50") || 50, 200);
  const rows = await db.select().from(notifications).orderBy(desc(notifications.id)).limit(limit);
  const out = sp.get("kind") === "followup" ? rows.filter((r) => r.kind === "followup") : rows;
  return NextResponse.json(out.map(map));
}

/**
 * Bildirim üzerinde kapanış döngüsü / görev durumu işlemi:
 *  - `action=relay`   → iletildi kanıtı (relayedTo/relayedAt)
 *  - `action=escalate`→ eskalasyon kaydı
 *  - `action=status`  → takip görevi durumu
 *  - belirtmezse      → “alındı” (ack)
 */
export async function PATCH(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as {
    id?: number;
    action?: string;
    relayedTo?: string;
    escalate?: boolean;
    status?: string;
  };
  if (!b.id) return NextResponse.json({ error: "id gerekli" }, { status: 400 });
  const cur = (await db.select().from(notifications).where(eq(notifications.id, b.id)).limit(1))[0];
  if (!cur) return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });

  if (b.action === "relay" || b.action === "escalate") {
    await closeLoopUpdate(b.id, { relayedTo: b.relayedTo, escalate: b.action === "escalate" });
    await audit(a.user, "notify.relay", "notification", b.id, { action: b.action, relayedTo: b.relayedTo ?? "" });
    return NextResponse.json({ ok: true });
  }

  if (b.action === "status") {
    const st = b.status ?? "";
    if (!["acik", "tamamlandi", "iptal"].includes(st)) return NextResponse.json({ error: "Geçersiz durum" }, { status: 400 });
    await setFollowupStatus(b.id, st as "acik" | "tamamlandi" | "iptal");
    await audit(a.user, "notify.followup", "notification", b.id, { status: st });
    return NextResponse.json({ ok: true });
  }

  if (!cur.ackAt) {
    await db.update(notifications).set({ ackBy: a.user.id, ackByName: a.user.fullName, ackAt: new Date() }).where(eq(notifications.id, b.id));
    await audit(a.user, "notify.ack", "notification", b.id, { severity: cur.severity });
  }
  return NextResponse.json({ ok: true });
}

/** Elle/dış kaynaktan yeni takip önerisi görevi. */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as {
    studyUid?: string;
    message?: string;
    modality?: string;
    bodyRegion?: string;
    recommendedIntervalDays?: number | null;
    dueDate?: string;
    reportId?: number | null;
  };
  const msg = (b.message ?? "").trim();
  if (msg.length < 3 || msg.length > 2000) return NextResponse.json({ error: "Mesaj 3–2000 karakter olmalı" }, { status: 400 });
  const days = b.recommendedIntervalDays;
  const ins = await db
    .insert(notifications)
    .values({
      kind: "followup",
      severity: "bilgi",
      studyUid: (b.studyUid ?? "").slice(0, 64),
      message: msg,
      modality: (b.modality ?? "").slice(0, 16),
      bodyRegion: (b.bodyRegion ?? "").slice(0, 120),
      recommendedIntervalDays: days && Number.isFinite(days) ? Math.round(days) : null,
      dueDate: (b.dueDate ?? "").slice(0, 10),
      status: "acik",
      reportId: b.reportId ?? null,
    })
    .returning({ id: notifications.id });
  await audit(a.user, "notify.followup.create", "notification", ins[0].id, { dueDate: (b.dueDate ?? "").slice(0, 10) });
  return NextResponse.json({ ok: true, id: ins[0].id });
}

import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { closeLoopUpdate, setFollowupStatus, sweepCloseLoop } from "@/lib/server/closeLoop";
import { ESCALATION_ROLES, loopStatus } from "@/lib/closeLoopRules";
import { followupCsv, matchReturnedResult, summarizeFollowups, type FollowupTask } from "@/lib/followupQueue";
import { channelHealth, deliverAndRecord, recentDeliveries } from "@/lib/server/notifyDelivery";
import { applyReturnedResult, parseReturnedPayload } from "@/lib/followupReturn";

export const dynamic = "force-dynamic";

const SEVERITIES = ["kritik", "yuksek", "orta", "dusuk", "bilgi"];

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
  ...(() => {
    const st = loopStatus({ id: r.id, severity: r.severity, createdAt: r.createdAt, ackAt: r.ackAt, relayedAt: r.relayedAt, escalated: r.escalated, escalatedAt: r.escalatedAt });
    return { loopState: st.state, loopLabel: st.label, ageMinutes: st.ageMinutes, dueInMinutes: st.dueInMinutes };
  })(),
});

/** Bildirimler; `?kind=followup` yalnız takip görevlerini verir. */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  if (sp.get("followup") === "summary" || sp.get("followup") === "csv") {
    const rowsF = (await db.select().from(notifications).where(eq(notifications.kind, "followup")).orderBy(desc(notifications.id)).limit(500));
    const tasks: FollowupTask[] = rowsF.map((r) => ({
      id: r.id, kind: r.kind ?? "followup", status: (r.status ?? "acik") as FollowupTask["status"],
      dueDate: r.dueDate ?? "", severity: r.severity, message: r.message,
      modality: r.modality, bodyRegion: r.bodyRegion, studyUid: r.studyUid, reportId: r.reportId,
    }));
    const sum = summarizeFollowups(tasks);
    if (sp.get("followup") === "csv") {
      return new NextResponse(followupCsv(tasks), { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return NextResponse.json({
      open: sum.open, overdue: sum.overdue, dueToday: sum.dueToday, upcoming: sum.upcoming,
      alerting: sum.alerting.map((t) => ({ id: t.id, message: t.message.slice(0, 160), dueDate: t.dueDate, severity: t.severity })),
      ordered: sum.ordered.slice(0, 100).map((t) => ({ id: t.id, message: t.message.slice(0, 160), dueDate: t.dueDate, severity: t.severity, modality: t.modality, bodyRegion: t.bodyRegion, status: t.status })),
    });
  }
  if (sp.get("delivery") === "1") {
    // Kanal sağlığı + son teslimatlar (a-notify): yönetici hasta güvenliği denetimi.
    const channel = sp.get("channel");
    if (channel) {
      const rows = await recentDeliveries(Number(sp.get("limit") ?? "50") || 50, Number(channel) || undefined);
      return NextResponse.json({ rows });
    }
    return NextResponse.json({ channels: channelHealth(), recent: await recentDeliveries(20) });
  }
  if (sp.get("escalation") === "1") {
    const rowsAll = await db.select().from(notifications).orderBy(desc(notifications.id)).limit(500);
    const st = rowsAll
      .filter((r) => r.status === "acik")
      .map((r) => ({ row: r, st: loopStatus({ id: r.id, severity: r.severity, createdAt: r.createdAt, ackAt: r.ackAt, relayedAt: r.relayedAt, escalated: r.escalated, escalatedAt: r.escalatedAt }) }))
      .filter((x) => x.st.remind)
      .sort((a, b) => b.st.ageMinutes - a.st.ageMinutes);
    return NextResponse.json({
      roles: ESCALATION_ROLES,
      items: st.map((x) => ({ id: x.row.id, severity: x.row.severity, message: x.row.message.slice(0, 200), state: x.st.state, label: x.st.label, ageMinutes: x.st.ageMinutes, relayedTo: x.row.relayedTo })),
    });
  }
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

  // Toplu tarama: süresi dolan bildirimleri eskale et (id gerekmez).
  if (b.action === "sweep") {
    const role = (b as { escalationRole?: string }).escalationRole ?? "ikinci-hekim";
    const contact = (b as { escalationContact?: string }).escalationContact ?? "";
    const res = await sweepCloseLoop({ target: { role, contact }, actor: a.user });
    // Eskalasyon dış kanallara da iletilir (a-notify): hekim uygulamayı açmıyorsa
    // SMS/push/çağrı devreye girer; kanal başına kanıt kaydedilir ve tekrar
    // gönderim idempotency anahtarıyla engellenir.
    const escalations: { id: number; delivery: string; sent: string[] }[] = [];
    if (res.escalated > 0) {
      const rowsEsc = await db.select().from(notifications).where(eq(notifications.escalated, true)).orderBy(desc(notifications.id)).limit(50);
      for (const r of rowsEsc) {
        if (!r.escalatedAt || Date.now() - new Date(r.escalatedAt).getTime() > 10 * 60_000) continue;
        const d = await deliverAndRecord({
          event: "escalation",
          severity: "kritik",
          studyUid: r.studyUid,
          message: `ESKALASYON (${role}${contact ? ` / ${contact}` : ""}): ${r.message.split("\n---\n")[0].slice(0, 400)}`,
          notificationId: r.id,
          at: new Date().toISOString(),
        });
        escalations.push({ id: r.id, delivery: d.auditText, sent: d.sent });
      }
    }
    await audit(a.user, "notify.sweep", "notification", 0, {
      escalated: res.escalated, overdue: res.overdue,
      delivered: escalations.reduce((n, e) => n + e.sent.length, 0),
    });
    return NextResponse.json({ ...res, escalations });
  }

  // HBYS/RIS iadesi: sonucu açık göreve bağla ve kapat (eşleşme otomatik ya da elle).
  if (b.action === "outcome") {
    const ob = b as { id?: number; outcome?: string; reportId?: number; studyUid?: string; modality?: string; bodyRegion?: string; auto?: boolean; rawPayload?: string };
    const rowsO = await db.select().from(notifications).where(eq(notifications.kind, "followup")).orderBy(desc(notifications.id)).limit(500);
    const tasks: FollowupTask[] = rowsO.map((r) => ({
      id: r.id, status: (r.status ?? "acik") as FollowupTask["status"], dueDate: r.dueDate ?? "", severity: r.severity,
      message: r.message, modality: r.modality, bodyRegion: r.bodyRegion, studyUid: r.studyUid, reportId: r.reportId,
    }));
    // Ham iade (HL7 ORU^R01 / FHIR DiagnosticReport) verildiyse önce ayrıştırılır:
    // eşleştirme ve kapatma metni iadenin kendisinden türetilir (d-followup).
    let rawPayloadOutcome: { text: string; warnings: string[]; reason: string } | null = null;
    if (ob.rawPayload) {
      const parsed = parseReturnedPayload(ob.rawPayload);
      if (!parsed.ok || !parsed.result) {
        return NextResponse.json({ error: `İade ayrıştırılamadı: ${parsed.warnings[0] ?? "bilinmeyen biçim"}`, warnings: parsed.warnings }, { status: 400 });
      }
      rawPayloadOutcome = { text: parsed.result.text, warnings: parsed.warnings, reason: parsed.format };
      if (ob.auto) {
        const applied = applyReturnedResult(ob.rawPayload, tasks);
        if (!applied.closed || !applied.task) {
          // Belirsiz eşleşme otomatik kapatılmaz (hekim seçmeli).
          await audit(a.user, "notify.followup_return_unmatched", "notification", 0, { reason: applied.reason.slice(0, 120), candidates: applied.ambiguousCandidates });
          return NextResponse.json({ error: applied.message, reason: applied.reason, candidates: applied.ambiguousCandidates, warnings: applied.warnings }, { status: 409 });
        }
        const stampR = new Date();
        await db.update(notifications).set({
          status: "tamamlandi", completedAt: stampR,
          message: `${applied.task.message}\n---\nSonuç (${stampR.toISOString().slice(0, 16).replace("T", " ")}): ${applied.task.outcome ?? ""}`.slice(0, 8000),
        }).where(eq(notifications.id, applied.task.id));
        await audit(a.user, "notify.followup_outcome", "notification", applied.task.id, { match: applied.reason, format: parsed.format, chars: applied.task.outcome?.length ?? 0, service: "iade" });
        return NextResponse.json({ ok: true, id: applied.task.id, match: applied.reason, format: parsed.format, warnings: applied.warnings });
      }
    }
    const match = ob.auto
      ? matchReturnedResult({ reportId: ob.reportId ?? null, studyUid: ob.studyUid, modality: ob.modality, bodyRegion: ob.bodyRegion, text: rawPayloadOutcome?.text ?? ob.outcome ?? "" }, tasks)
      : { task: tasks.find((t) => t.id === ob.id) ?? null, reason: "Elle seçildi" };
    if (!match.task) return NextResponse.json({ error: match.reason }, { status: 409 });
    const text = (rawPayloadOutcome?.text ?? ob.outcome ?? "").trim();
    if (text.length < 1) return NextResponse.json({ error: "Sonuç metni gerekli" }, { status: 400 });
    const stamp = new Date();
    await db.update(notifications).set({
      status: "tamamlandi", completedAt: stamp,
      // Sonuç metni görev kaydına eklenir (ayrı sütun yok; tarihçe mesajda tutulur).
      message: `${match.task.message}\n---\nSonuç (${stamp.toISOString().slice(0, 16).replace("T", " ")}): ${text}`.slice(0, 8000),
    }).where(eq(notifications.id, match.task.id));
    await audit(a.user, "notify.followup_outcome", "notification", match.task.id, { match: match.reason, chars: text.length });
    return NextResponse.json({ ok: true, id: match.task.id, match: match.reason });
  }

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
    severity?: string;
  };
  const msg = (b.message ?? "").trim();
  if (msg.length < 3 || msg.length > 2000) return NextResponse.json({ error: "Mesaj 3–2000 karakter olmalı" }, { status: 400 });
  const days = b.recommendedIntervalDays;
  const sev: string = SEVERITIES.includes(b.severity ?? "") ? (b.severity as string) : "bilgi";
  const ins = await db
    .insert(notifications)
    .values({
      kind: "followup",
      // Bildirimin önem derecesi (D1 kapanış döngüsünde aynı değer taşınır).
      severity: sev,
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

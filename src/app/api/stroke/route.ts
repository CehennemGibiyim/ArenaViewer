import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { deliverAndRecord } from "@/lib/server/notifyDelivery";
import { ctpSvdSummary, parseCtpCurves } from "@/lib/ctp";
import {
  codeStrokeDecision,
  missedTargets,
  notificationBody,
  strokeIntervals,
  strokeTriage,
  timelineText,
  type StrokeTimeline,
} from "@/lib/strokePipeline";

export const dynamic = "force-dynamic";

interface Body {
  action?: "triage" | "code" | "timeline";
  studyUid?: string;
  onset?: string | null;
  now?: string;
  aspectsAbnormal?: string[];
  ctpText?: string;
  lvo?: boolean | null;
  timeline?: Partial<StrokeTimeline>;
  /** Kod inme çağrısında kanallar (a-notify) */
  channels?: string[];
}

/**
 * İnme hattı (a-stroke): triyaj özeti, zaman çizelgesi ve koddan kod çağrısı.
 *
 * - `triage`: pencere (0–4,5 / 4,5–24 / dışı) + ASPECTS + CTP → tek satır başlık
 *   ve uyarılar. Eksik veri "normal" sayılmaz.
 * - `timeline`: kapı-görüntü/iğne/kasık süreleri, hedef aşımları.
 * - `code`: mükerrer korumalı bildirim; aynı çalışma için açık çağrı varsa
 *   yenisini açmaz. Bildirim `notifications` tablosuna yazılır ve kanallara
 *   (varsa) teslim edilir; her adım denetim kaydına girer.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Body;
  const studyUid = (b.studyUid ?? "").slice(0, 80);

  if (b.action === "timeline") {
    const tl: StrokeTimeline = {
      arrival: b.timeline?.arrival ?? null,
      imaging: b.timeline?.imaging ?? null,
      interpretation: b.timeline?.interpretation ?? null,
      thrombolysis: b.timeline?.thrombolysis ?? null,
      thrombectomy: b.timeline?.thrombectomy ?? null,
    };
    const res = strokeIntervals(tl);
    const missed = missedTargets(res.intervals);
    if (missed.length) await audit(a.user, "stroke.target_missed", "study", studyUid, { keys: missed.map((m) => m.key) });
    return NextResponse.json({ ...res, missed: missed.map((m) => m.key), text: timelineText(res) });
  }

  const now = b.now ?? new Date().toISOString();
  const ctpCurves = b.ctpText ? parseCtpCurves(b.ctpText) : [];
  const ctp = ctpCurves.length >= 2 ? ctpSvdSummary(ctpCurves) : null;
  const triage = strokeTriage({
    onset: b.onset ?? null,
    now,
    aspectsAbnormal: b.aspectsAbnormal ?? [],
    ctp,
    lvo: b.lvo ?? null,
  });

  if (b.action === "code") {
    if (!studyUid) return NextResponse.json({ error: "Çalışma UID gerekli" }, { status: 400 });
    // Aynı çalışma için açık (yanıtlanmamış) inme çağrısı var mı?
    const open = await db
      .select({ id: notifications.id, createdAt: notifications.createdAt, ackAt: notifications.ackAt, message: notifications.message })
      .from(notifications)
      .where(eq(notifications.studyUid, studyUid))
      .orderBy(desc(notifications.id))
      .limit(20);
    const existingOpen = open.find((r) => r.message.startsWith("KOD İNME") && !r.ackAt);
    const decision = codeStrokeDecision(triage, {
      studyUid,
      existing: existingOpen ? { id: existingOpen.id, createdAt: existingOpen.createdAt.toISOString(), acked: !!existingOpen.ackAt } : null,
    });
    if (!decision.create) {
      await audit(a.user, "stroke.code_duplicate", "study", studyUid, { existingId: existingOpen?.id ?? 0 });
      return NextResponse.json({ ...decision, triage });
    }
    const inserted = await db
      .insert(notifications)
      .values({
        kind: "finding",
        severity: decision.severity,
        studyUid,
        message: decision.message.slice(0, 500),
        modality: "CT",
        bodyRegion: "BEYIN",
      })
      .returning({ id: notifications.id });
    const id = inserted[0]?.id ?? 0;
    // Kanal teslimatı (a-notify) isteğe bağlı: kanallar yapılandırılmadıysa
    // uygulama içi bildirim yeterlidir; teslimat hatası çağrıyı geri almaz.
    let delivery: { sent: string[]; failed: string[]; channels: string[]; displayText?: string } = { sent: [], failed: [], channels: [] };
    if ((b.channels ?? []).length) {
      try {
        const r = await deliverAndRecord({
          event: "critical_finding",
          severity: decision.severity,
          studyUid,
          message: notificationBody(triage, studyUid),
          notificationId: id,
          at: new Date().toISOString(),
        });
        delivery = { sent: r.sent, failed: r.failed, channels: r.channels.filter((c) => c.enabled).map((c) => c.kind), displayText: r.displayText };
      } catch (e) {
        delivery = { sent: [], failed: ["hata"], channels: [], displayText: e instanceof Error ? e.message : String(e) };
      }
    }
    await audit(a.user, "stroke.code", "study", studyUid, { notificationId: id, severity: decision.severity, window: triage.window, channels: delivery.channels });
    return NextResponse.json({ ...decision, triage, notificationId: id, delivery });
  }

  // Varsayılan: triyaj
  await audit(a.user, "stroke.triage", "study", studyUid, { window: triage.window, severity: triage.severity, aspects: triage.aspects?.score ?? null });
  return NextResponse.json({ triage, ctp: ctp ? { core: triage.coreRegions, penumbra: triage.penumbraRegions, mismatchRatio: triage.mismatchRatio } : null });
}

/** Son inme olayları (yönetim/panel listesi). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rows = await db
    .select({ id: notifications.id, createdAt: notifications.createdAt, severity: notifications.severity, studyUid: notifications.studyUid, message: notifications.message, ackAt: notifications.ackAt })
    .from(notifications)
    .orderBy(desc(notifications.id))
    .limit(50);
  const stroke = rows.filter((r) => r.message.startsWith("KOD İNME") || r.message.startsWith("İNME TRİYAJ"));
  return NextResponse.json({
    count: stroke.length,
    open: stroke.filter((r) => !r.ackAt).length,
    rows: stroke,
    note: "Yalnız son 50 bildirim taranır; süzgeç bildirim metnine dayanır.",
  });
}

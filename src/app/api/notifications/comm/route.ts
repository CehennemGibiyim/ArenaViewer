import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { commLog, notifications } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { commCsv, COMM_CHANNELS, loopEvidence, policyTable, validateComm, type CommEntry } from "@/lib/closeLoopEvidence";

export const dynamic = "force-dynamic";

/** Veritabanı satırı → kenar (API) biçimi; zaman ISO metnine çevrilir. */
const toEntry = (r: typeof commLog.$inferSelect): CommEntry => ({
  id: r.id,
  notificationId: r.notificationId,
  at: r.at.toISOString(),
  channel: r.channel as CommEntry["channel"],
  toWhom: r.toWhom,
  reached: r.reached,
  note: r.note,
  byName: r.byName,
});

/**
 * Dış iletişim defteri ve kanıt paketi (d-close-loop).
 *
 * GET  ?notificationId=12            → kanıt paketi (adımlar + eksikler)
 * GET  ?csv=1&notificationId=12      → dış iletişim CSV
 * GET                                → politika tablosu + kanal listesi
 * POST                               → iletişim kaydı ekler (doğrulama zorunlu)
 *
 * Kayıt **silinemez/düzeltilemez**: yanlış giriş için yeni satır eklenir
 * (denetim izi bozulmaz). Her ekleme `notify.comm_log` olarak denetime yazılır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const idRaw = sp.get("notificationId");
  if (!idRaw) {
    return NextResponse.json({ policies: policyTable(), channels: COMM_CHANNELS });
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "notificationId geçersiz" }, { status: 400 });

  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const n = rows[0];
  if (!n) return NextResponse.json({ error: "Bildirim bulunamadı" }, { status: 404 });

  const comms = (await db.select().from(commLog).where(eq(commLog.notificationId, id)).orderBy(commLog.id)).map(toEntry);

  if (sp.get("csv") === "1") {
    return new NextResponse(commCsv(comms), { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const evidence = loopEvidence(
    {
      id: n.id,
      severity: n.severity,
      createdAt: n.createdAt,
      ackAt: n.ackAt,
      relayedAt: n.relayedAt,
      escalated: n.escalated,
      escalatedAt: n.escalatedAt,
    },
    { comms, reminders: [], now: Date.now() },
  );
  return NextResponse.json({ evidence, comms });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as {
    notificationId?: number;
    channel?: string;
    toWhom?: string;
    reached?: boolean;
    note?: string;
    /** Birden çok bildirim için tek seferde kayıt */
    bulk?: { notificationId: number; channel: string; toWhom: string; reached: boolean; note?: string }[];
  };

  const items = b.bulk?.length
    ? b.bulk
    : [{ notificationId: b.notificationId ?? 0, channel: b.channel ?? "", toWhom: b.toWhom ?? "", reached: b.reached === true, note: b.note }];

  const results: { notificationId: number; ok: boolean; error?: string; id?: number }[] = [];
  for (const item of items) {
    const v = validateComm(item);
    if (!v.ok) {
      results.push({ notificationId: item.notificationId, ok: false, error: v.error });
      continue;
    }
    // Bildirim gerçekten var mı? (uydurma kimliğe kayıt yazılmaz)
    const found = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, item.notificationId)).limit(1);
    if (!found[0]) {
      results.push({ notificationId: item.notificationId, ok: false, error: "Bildirim bulunamadı" });
      continue;
    }
    const ins = await db
      .insert(commLog)
      .values({ ...v.entry, at: new Date(v.entry.at), byName: a.user.username.slice(0, 80) })
      .returning({ id: commLog.id });
    results.push({ notificationId: item.notificationId, ok: true, id: ins[0]?.id ?? 0 });
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount > 0) {
    await audit(a.user, "notify.comm_log", "notification", items.length === 1 ? items[0].notificationId : 0, {
      entries: okCount, failed: results.length - okCount, channels: [...new Set(items.map((i) => i.channel))].join(",").slice(0, 80),
    });
  }
  return NextResponse.json({ ok: okCount > 0, results }, { status: okCount > 0 ? 200 : 400 });
}

/** Belirli bildirimlerin dış iletişim özeti (liste ekranı için). */
export async function PATCH(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as { ids?: number[] };
  const ids = (b.ids ?? []).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  if (!ids.length) return NextResponse.json({ counts: {} });
  const rows = (await db.select().from(commLog).where(inArray(commLog.notificationId, ids))).map(toEntry);
  const counts: Record<number, { total: number; reached: number; channels: string[] }> = {};
  for (const r of rows) {
    const c = counts[r.notificationId] ?? { total: 0, reached: 0, channels: [] };
    c.total++;
    if (r.reached) c.reached++;
    if (!c.channels.includes(r.channel)) c.channels.push(r.channel);
    counts[r.notificationId] = c;
  }
  return NextResponse.json({ counts });
}

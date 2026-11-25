import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { audit, cefLine, verifyChain } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { deliverPending, deliveryStats } from "@/lib/server/auditDeliveryRepo";

export const dynamic = "force-dynamic";

/**
 * Denetim kayıtlarını dışa aktarma (G2): JSON / JSONL / CEF (syslog toplayıcı).
 * Yalnızca yönetici. Çıktı, `verifyChain()` ile zincir bütünlüğünü de raporlar.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;

  const sp = req.nextUrl.searchParams;
  if (sp.get("siem") === "stats") return NextResponse.json(await deliveryStats());
  const format = (sp.get("format") ?? "json").toLowerCase();
  const limit = Math.min(Number(sp.get("limit") ?? "1000") || 1000, 5000);

  const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit);
  const chain = await verifyChain();

  await audit(a.user, "audit.export", "audit", 0, { format, count: rows.length, chainOk: chain.ok });

  if (format === "cef") {
    const body = rows.map((r) => cefLine({ ts: r.ts, username: r.username, action: r.action, entityType: r.entityType, entityId: r.entityId, details: r.details })).join("\n") + "\n";
    return new NextResponse(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (format === "jsonl") {
    const body = rows.map((r) => JSON.stringify({ ts: r.ts.toISOString(), userId: r.userId, username: r.username, action: r.action, entityType: r.entityType, entityId: r.entityId, details: r.details, hash: r.hash, prevHash: r.prevHash })).join("\n") + "\n";
    return new NextResponse(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    chain: { ok: chain.ok, brokenAtId: chain.brokenAtId ?? null, reason: chain.reason ?? "" },
    count: rows.length,
    events: rows,
  });
}

/**
 * SIEM kuyruğunu elle boşaltır (zamanlayıcı cron'u yoksa yönetici tetikler).
 * `AUDIT_SIEM_URL` yoksa kuyruk birikmeye devam eder; kayıt kaybolmaz.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const run = await deliverPending();
  if (run.configured) await audit(a.user, "audit.siem_flush", "audit", 0, { tried: run.tried, sent: run.sent, failed: run.failed });
  return NextResponse.json(run);
}

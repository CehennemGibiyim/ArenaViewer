import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { audit, cefLine, verifyChain } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { deliverPending, deliveryStats } from "@/lib/server/auditDeliveryRepo";
import { authModeGate, buildManifest, signPackage, verifyPackage, verifyReport, type AuditEventLike, type AuditPackage } from "@/lib/auditExport";

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
  // Üretim kapısı: hesap modu zorunlu mu (denetim izi atfı için).
  if (sp.get("gate") === "authmode") {
    const gate = authModeGate(process.env as Record<string, string | undefined>);
    return NextResponse.json({ ...gate, nodeEnv: process.env.NODE_ENV ?? "", signed: !!process.env.AUDIT_EXPORT_SECRET });
  }

  // İmzalı, doğrulanabilir paket (w-audit): kurum dışı denetçiye verilecek kanıt.
  if (sp.get("format") === "package") {
    const limitP = Math.min(Number(sp.get("limit") ?? "1000") || 1000, 20000);
    const rowsP = await db.select().from(auditLogs).orderBy(asc(auditLogs.id)).limit(limitP);
    const events: AuditEventLike[] = rowsP.map((r) => ({
      id: r.id, ts: r.ts.toISOString(), userId: r.userId, username: r.username, action: r.action,
      entityType: r.entityType, entityId: r.entityId, details: r.details, prevHash: r.prevHash, hash: r.hash,
    }));
    const sha256 = (x: string) => createHash("sha256").update(x).digest("hex");
    const secret = process.env.AUDIT_EXPORT_SECRET ?? "";
    const prevAnchor = events[0]?.prevHash ?? "GENESIS";
    const manifest = buildManifest(events, { exportedBy: a.user.username, prevAnchor, signed: !!secret }, sha256);
    const signature = signPackage(manifest, events, secret);
    await audit(a.user, "audit.export_package", "audit", 0, { count: events.length, signed: !!secret, digest: manifest.digest.slice(0, 16) });
    return NextResponse.json({ manifest, events, signature } satisfies AuditPackage, {
      headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="denetim-paketi-${new Date().toISOString().slice(0, 10)}.json"` },
    });
  }
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
  // Paket doğrulama: dış denetçiden gelen paket sunucuda doğrulanır
  // (zincir sürekliliği + satır hash'leri + HMAC imza).
  const body = (await req.json().catch(() => null)) as { verify?: AuditPackage } | null;
  if (body?.verify) {
    const sha256 = (x: string) => createHash("sha256").update(x).digest("hex");
    const res = verifyPackage(body.verify, { secret: process.env.AUDIT_EXPORT_SECRET ?? "", sha256 });
    await audit(a.user, "audit.verify_package", "audit", 0, { ok: res.ok, count: res.count, reason: res.reason.slice(0, 120) });
    return NextResponse.json({ ...res, report: verifyReport(res) });
  }
  const run = await deliverPending();
  if (run.configured) await audit(a.user, "audit.siem_flush", "audit", 0, { tried: run.tried, sent: run.sent, failed: run.failed });
  return NextResponse.json(run);
}

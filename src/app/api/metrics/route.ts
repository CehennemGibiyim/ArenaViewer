import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { prometheusText, type MetricSeries } from "@/lib/server/metrics";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * Prometheus uyumlu toplu sayımlar.
 *
 * Kimlik doğrulaması yoktur (yalnız agrega sayımlar içerir). `METRICS_TOKEN`
 * tanımlıysa `Authorization: Bearer <token>` zorunludur — kurumsal dağıtımda
 * bu değişkeni tanımlayın ve metrik uç noktasını ağ güvenlik duvarıyla sınırlayın.
 */
export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let dbUp = 0;
  try {
    await db.execute(sql`select 1`);
    dbUp = 1;
  } catch {
    dbUp = 0;
  }

  const series: MetricSeries[] = [
    { name: "atik_db_up", help: "Veritabanı bağlantısı 1/0", type: "gauge", points: [{ labels: {}, value: dbUp }] },
    { name: "atik_build_info", help: "Derleme bilgisi (sürüm etiketli)", type: "gauge", points: [{ labels: { version: APP_VERSION }, value: 1 }] },
  ];

  try {
    const studies = await db.execute(sql`select work_status as label, count(*)::int as v from studies group by work_status`);
    series.push({
      name: "atik_studies_total",
      help: "Çalışma sayısı (iş durumuna göre)",
      type: "gauge",
      points: (studies.rows as Array<{ label: string | null; v: number }>).map((r) => ({ labels: { work_status: r.label ?? "bilinmiyor" }, value: Number(r.v) })),
    });
  } catch { /* tablolar henüz yok */ }

  try {
    const reports = await db.execute(sql`select status as label, count(*)::int as v from reports group by status`);
    series.push({
      name: "atik_reports_total",
      help: "Rapor sayısı (duruma göre)",
      type: "gauge",
      points: (reports.rows as Array<{ label: string | null; v: number }>).map((r) => ({ labels: { status: r.label ?? "bilinmiyor" }, value: Number(r.v) })),
    });
  } catch { /* yok */ }

  try {
    const notes = await db.execute(
      sql`select coalesce(kind,'finding') as kind, status as label, count(*)::int as v from notifications group by kind, status`,
    );
    series.push({
      name: "atik_notifications_total",
      help: "Bildirim/takip görevi sayısı",
      type: "gauge",
      points: (notes.rows as Array<{ kind: string; label: string | null; v: number }>).map((r) => ({
        labels: { kind: r.kind, status: r.label ?? "acik" },
        value: Number(r.v),
      })),
    });
  } catch { /* yok */ }

  try {
    const audit = await db.execute(sql`select count(*)::int as v from audit_logs`);
    const v = Number((audit.rows[0] as { v: number }).v);
    series.push({ name: "atik_audit_events_total", help: "Denetim kaydı sayısı", type: "counter", points: [{ labels: {}, value: v }] });
  } catch { /* yok */ }

  return new NextResponse(prometheusText(series), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}

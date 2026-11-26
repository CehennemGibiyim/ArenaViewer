/**
 * Erişim anomalisi raporu (yeni: KVKK erişim denetimi).
 *
 * GET /api/security/access-anomaly — yalnız yönetici.
 * Son 7 günün denetim kaydını + başarısız giriş denemelerini tarar;
 * tespit edilen desenleri döner. Yüksek önemdeki YENİ anomaliler için
 * bildirim kanallarına (tanımlıysa) gönderir ve denetim kaydına
 * `security.access_anomaly` yazar (idempotency, `accessAnomalyAlerted`).
 *
 * Bu uç pahalıdır (tarama yapar); ön panel açılışında değil, güvenlik
 * sekmesi görüntülendiğinde çağrılmalıdır.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { buildAccessAnomalyReport } from "@/lib/server/accessAnomaly";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  try {
    const report = await buildAccessAnomalyReport(a.user);
    return NextResponse.json(report);
  } catch (e) {
    console.error("Erişim anomalisi raporu üretilemedi:", e);
    return NextResponse.json({ error: "Erişim anomalisi raporu üretilemedi" }, { status: 500 });
  }
}

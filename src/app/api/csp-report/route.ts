import { NextRequest, NextResponse } from "next/server";
import { summarizeCspReport } from "@/lib/webSecurity";

export const dynamic = "force-dynamic";

/**
 * CSP ihlal raporu (g-webhard).
 *
 * Tarayıcı, politikayı ihlal eden bir kaynak yüklemeye çalıştığında buraya
 * POST atar (`Content-Type: application/csp-report` veya
 * `application/reports+json`). Kimlik doğrulaması YOKTUR — tarayıcılar rapor
 * uçlarına oturum çerezi eklemez. Bu yüzden:
 *   - gövde sınırlandırılır (16 KB),
 *   - gövdeden yalnız yönerge/engellenen URI/köken çıkarılır (tam URL = hasta
 *     bağlamı taşıyabilir, günlüğe yazılmaz),
 *   - yanıt her durumda 204'tür (raporlama döngüsü kırılmaz, bilgi sızdırmaz).
 */
export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > 0 && raw.length <= 16_384) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* bozuk gövde: sessizce yut */
    }
    const line = summarizeCspReport(parsed);
    if (line) console.warn(`[csp] ${line}`);
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

import { NextRequest, NextResponse } from "next/server";
import { CspReportFilter, clientKey, reportLines } from "@/lib/webSecurity";
import { audit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

/**
 * CSP ihlal raporu (g-webhard) → denetim zinciri → SIEM.
 *
 * Tarayıcı, politikayı ihlal eden bir kaynak yüklemeye çalıştığında buraya
 * POST atar (`Content-Type: application/csp-report` veya
 * `application/reports+json`). Kimlik doğrulaması YOKTUR — tarayıcılar rapor
 * uçlarına oturum çerezi eklemez. Bu yüzden:
 *   - gövde sınırlandırılır (16 KB),
 *   - gövdeden yalnız yönerge/engellenen URI/köken çıkarılır (tam URL = hasta
 *     bağlamı taşıyabilir; özet host'a indirilir ve kontrol karakterleri temizlenir),
 *   - rapor `audit(..., "csp.report")` ile denetim zincirine düşer; `audit` aynı
 *     işlemde `audit_delivery` kuyruğuna CEF satırı yazar → `AUDIT_SIEM_URL`
 *     tanımlıysa HMAC imzalı POST ile SIEM'e iletilir (yoksa kuyrukta bekler,
 *     Yönetim ekranında görünür),
 *   - gürültü filtresi (`CspReportFilter`, tek örnek): IP başına 30 rapor/dk ve
 *     aynı satır için 60 sn yinelenme bastırması; denetim yazılamazsa 204 ile
 *     sessiz düşer (sayfa yüklemesi CSP hatası yüzünden bozulmaz),
 *   - yanıt her durumda 204'tür (raporlama döngüsü kırılmaz, bilgi sızdırmaz).
 */
const g = globalThis as unknown as { __avCspFilter?: CspReportFilter };
const filter = (g.__avCspFilter ??= new CspReportFilter());

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > 0 && raw.length <= 16_384) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* bozuk gövde: sessizce yut */
    }
    // Üç gövde biçimi: klasik `{"csp-report":{…}}`, Reporting API dizisi
    // (`application/reports+json`) ve tekil `application/report`. Hepsi aynı
    // özete indirgenir; çoklu dizide en fazla 5 satır işlenir (gürültü sınırı).
    const ip = clientKey(req.headers);
    for (const { type, line } of reportLines(parsed, 5)) {
      if (filter.allow(ip, line)) {
        try {
          await audit(null, "csp.report", "security", "", { line, type });
        } catch (e) {
          // Denetim yazılamadı: sayfa kırılmasın; satırı yerelde bırak.
          console.warn(`[csp] denetim yazılamadı (${e instanceof Error ? e.message : String(e)}): ${line}`);
        }
      } else {
        console.warn(`[csp] bastırıldı: ${line}`);
      }
    }
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

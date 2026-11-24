/**
 * Liveness: süreç ayakta ve HTTP yanıt veriyor mu? Veritabanına BAĞMAZ; kapsül
 * (container) yalnız bu uç noktayı yeniden başlatır. Readiness ayrıdır.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, check: "live" });
}

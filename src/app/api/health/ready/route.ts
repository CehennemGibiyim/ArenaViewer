import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Readiness: bu örnek trafik almaya hazır mı? Veritabanı sorgusu başarısızsa
 * 503 döner; yük dengeleyici/kapsül isteği bu örneğe yönlendirmeyi bırakır.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, check: "ready" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, check: "ready", error: msg.slice(0, 200) }, { status: 503 });
  }
}

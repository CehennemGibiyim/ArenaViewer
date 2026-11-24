import type { NextRequest } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await db.execute(sql`select 1`);
    // Geriye dönük uyum: eski sağlık ucu da artık readiness anlamındadır.
    return Response.json({ ok: true, check: "ready" });
  } catch {
    return Response.json({ ok: false, check: "ready" }, { status: 503 });
  }
}

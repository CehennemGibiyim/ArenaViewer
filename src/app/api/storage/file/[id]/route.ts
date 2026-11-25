import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storedFiles } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { decryptBuffer } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  const f = await db.select().from(storedFiles).where(eq(storedFiles.id, id)).limit(1);
  if (!f[0]) return NextResponse.json({ error: "Dosya bulunamadı" }, { status: 404 });
  try {
    const raw = await fileStorage().get(f[0].path);
    if (!raw) return NextResponse.json({ error: "Dosya depoda bulunamadı" }, { status: 404 });
    const bytes = decryptBuffer(raw);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Dosya okunamadı" }, { status: 500 });
  }
}

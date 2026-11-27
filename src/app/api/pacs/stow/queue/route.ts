import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { discardStow, flushStowQueue, listStowQueue } from "@/lib/server/stowQueueRepo";

export const dynamic = "force-dynamic";

/**
 * SEG/RTSTRUCT STOW yeniden deneme kuyruğu yönetimi (A0.3).
 * GET: bekleyen nesneleri listeler (payload döndürülmez; yonetici tümü, diğerleri kendi).
 * POST {action:"flush"}    → kuyruğu PACS'a yazmayı dener (süresi gelenler).
 * POST {action:"discard", id} → tek nesneyi kuyruktan siler.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  try {
    const out = await listStowQueue(a.user);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: number };
  if (body.action === "flush") {
    const out = await flushStowQueue(a.user);
    return NextResponse.json(out, { status: out.configured ? 200 : 503 });
  }
  if (body.action === "discard") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz kuyruk kimliği" }, { status: 400 });
    const out = await discardStow(id, a.user);
    return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error ?? "Silinemedi" }, { status: 404 });
  }
  return NextResponse.json({ error: "Bilinmeyen eylem (flush|discard)" }, { status: 400 });
}

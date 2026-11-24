import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { processDictation } from "@/lib/dictate";

export const dynamic = "force-dynamic";

/**
 * Dikte metnini sunucuda normalize eder (Türkçe sayı sözcükleri, noktalama,
 * ölçü birimleri ve tıbbi sözlük). Tarayıcı dışı istemciler ve API
 * tabanlı akışlar için; çıktı yine de hekim metnidir.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Geçersiz gövde" }, { status: 400 }); }
  const text = typeof (body as { text?: unknown })?.text === "string"
    ? ((body as { text: string }).text ?? "").trim().slice(0, 20000)
    : "";
  if (!text) return NextResponse.json({ error: "Metin gerekli" }, { status: 400 });

  const out = processDictation(text);
  await audit({ id: a.user.id, username: a.user.username }, "report.dictation_normalize", "dictation", "", { karakter: text.length });
  return NextResponse.json(out);
}

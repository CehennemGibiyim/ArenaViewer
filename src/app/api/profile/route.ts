import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize, getUserById } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** Oturumdaki kullanıcının profil bilgileri (rapor imzası adı/atama). */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  return NextResponse.json({ user: a.user });
}

export async function PATCH(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { fullName?: string; title?: string; regNo?: string } = {};
  for (const k of ["fullName", "title", "regNo"] as const) if (typeof b[k] === "string") patch[k] = b[k] as string;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Değişiklik yok" }, { status: 400 });

  // Güncelleme yalnızca oturumdaki hesaba uygulanır; istek sahibi başkasını değiştiremez.
  const set: Record<string, string> = {};
  if (patch.fullName !== undefined) set.fullName = patch.fullName.trim().slice(0, 120) || a.user.fullName;
  if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 60);
  if (patch.regNo !== undefined) set.regNo = patch.regNo.trim().slice(0, 40);
  await db.update(users).set(set).where(eq(users.id, a.user.id));
  const user = await getUserById(a.user.id);
  await audit(a.user, "profile.update", "user", a.user.id, { fields: Object.keys(patch) });
  return NextResponse.json({ ok: true, user });
}

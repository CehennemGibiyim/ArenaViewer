import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs, type UserPrefs } from "@/lib/prefs";

export const dynamic = "force-dynamic";

/** Oturumdaki kullanıcının tercihleri; kayıt yoksa varsayılanlar döner. */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const row = (await db.select().from(userPreferences).where(eq(userPreferences.userId, a.user.id)).limit(1))[0];
  const prefs = row ? mergePrefs(DEFAULT_PREFS, row.prefs as object) : { ...DEFAULT_PREFS };
  return NextResponse.json({ prefs, defaults: DEFAULT_PREFS });
}

/** Tercih güncellemesi (beyaz liste ile doğrulanır). */
export async function PATCH(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const current = (await db.select().from(userPreferences).where(eq(userPreferences.userId, a.user.id)).limit(1))[0];
  const base: UserPrefs = current ? mergePrefs(DEFAULT_PREFS, current.prefs as object) : { ...DEFAULT_PREFS };
  const patch = sanitizePrefs(body);
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Geçerli tercih alanı yok" }, { status: 400 });

  const next = mergePrefs(base, patch);
  if (current) {
    await db.update(userPreferences).set({ prefs: next, updatedAt: new Date() }).where(eq(userPreferences.userId, a.user.id));
  } else {
    await db.insert(userPreferences).values({ userId: a.user.id, prefs: next, updatedAt: new Date() });
  }
  await audit(a.user, "profile.preferences", "user", a.user.id, { fields: Object.keys(patch) });
  return NextResponse.json({ ok: true, prefs: next });
}

/** Varsayılanlara dön (tercih satırı silinir). */
export async function DELETE(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  await db.delete(userPreferences).where(eq(userPreferences.userId, a.user.id));
  await audit(a.user, "profile.preferences.reset", "user", a.user.id, {});
  return NextResponse.json({ ok: true, prefs: { ...DEFAULT_PREFS } });
}

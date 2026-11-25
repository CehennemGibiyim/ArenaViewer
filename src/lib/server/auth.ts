import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Role, UserInfo } from "@/lib/types";
import { sessionRef } from "./session";
import { isSessionActive, touchSession } from "./sessions";

/**
 * KİMLİK DOĞRULAMA KATMANI.
 *
 * İki mod vardır:
 *  - `demo` (varsayılan): oturum çerezinde kullanıcı yoksa id=1 "operatör" profiline
 *    düşülür (ACCESS_TOKEN kapısı access.ts'te hâlâ geçerliyse kapıyı onun belirler).
 *  - `hesap` (AUTH_MODE=hesap): her istek geçerli bir oturum çerezine ve etkin hesaba
 *    sahip olmalıdır; oturum yoksa 401 döner.
 *
 * `authorize(req, roles)` gerçekten rol kontrolü yapar: verilen rollerden biri
 * kullanıcının rolüne uymalı; "yonetici" her role yetişir. Geçemeyen istek 403 döner.
 */
export const OPERATOR_ID = 1;

const FALLBACK: UserInfo = {
  id: OPERATOR_ID,
  username: "operator",
  fullName: "Radyolog",
  title: "Uzm. Dr.",
  regNo: "",
  role: "yonetici",
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** AUTH_MODE=hesap ise kimlik her zaman bir oturum gerektirir. */
export function authRequired(): boolean {
  return process.env.AUTH_MODE === "hesap";
}

let ensured = false;

/** Operatör profili satırını (id=1) garanti eder; atama gibi yabancı anahtarlar buna bağlıdır. */
async function ensureOperator(): Promise<void> {
  if (ensured) return;
  await db
    .insert(users)
    .values({
      id: OPERATOR_ID,
      username: FALLBACK.username,
      passwordHash: "-", // parolasız demo satırı
      fullName: FALLBACK.fullName,
      title: FALLBACK.title,
      regNo: FALLBACK.regNo,
      role: "yonetici",
    })
    .onConflictDoNothing();
  ensured = true;
}

function toUserInfo(r: {
  id: number;
  username: string;
  fullName: string;
  title: string;
  regNo: string;
  role: string;
}): UserInfo {
  return { id: r.id, username: r.username, fullName: r.fullName, title: r.title, regNo: r.regNo, role: r.role as Role };
}

/** Etkin kullanıcıyı id ile okur; yok/pasifse null. */
export async function getUserById(id: number | null): Promise<UserInfo | null> {
  if (!id) return null;
  try {
    const r = (
      await db
        .select({ id: users.id, username: users.username, fullName: users.fullName, title: users.title, regNo: users.regNo, role: users.role, active: users.active })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
    )[0];
    return r && r.active ? toUserInfo(r) : null;
  } catch {
    return null;
  }
}

/**
 * Geçerli kullanıcıyı döndürür.
 *  - oturum varsa ve hesabı etkinse → o kullanıcı;
 *  - oturum yoksa: `hesap` modunda null (kapı 401 verir), demo modunda operatör profili.
 */
export async function getCurrentUser(sessionUid?: number | null): Promise<UserInfo | null> {
  if (sessionUid != null) return getUserById(sessionUid);
  if (authRequired()) {
    // Hesap modunda oturumsuz istek kabul edilmez.
    return null;
  }
  try {
    await ensureOperator();
    return await getUserById(OPERATOR_ID);
  } catch {
    return FALLBACK;
  }
}

/**
 * İstekteki oturum çerezinden kullanıcıyı döndürür.
 *
 * Çerezde sunucu oturum kimliği varsa kaydın iptal edilmemiş ve süresinin
 * dolmamış olduğu da doğrulanır: "Oturumlar" ekranından iptal edilen bir çerez,
 * süresi dolmadan geçersizleşir (hesap modunda 401, demo modunda operatöre düşer).
 */
export async function currentUser(req: NextRequest): Promise<UserInfo | null> {
  const ref = sessionRef(req);
  if (!ref) return getCurrentUser(null);
  if (ref.sid) {
    const active = await isSessionActive(ref.sid);
    if (!active) return authRequired() ? null : getCurrentUser(null);
    void touchSession(ref.sid);
  }
  return getCurrentUser(ref.uid);
}

export async function updateOperator(p: { fullName?: string; title?: string; regNo?: string }): Promise<UserInfo> {
  await ensureOperator();
  const set: Record<string, string> = {};
  if (typeof p.fullName === "string") set.fullName = p.fullName.trim().slice(0, 120) || FALLBACK.fullName;
  if (typeof p.title === "string") set.title = p.title.trim().slice(0, 60);
  if (typeof p.regNo === "string") set.regNo = p.regNo.trim().slice(0, 40);
  if (Object.keys(set).length > 0) await db.update(users).set(set).where(eq(users.id, OPERATOR_ID));
  return (await getUserById(OPERATOR_ID)) ?? FALLBACK;
}

/**
 * Rol denetimi. `roles` boşsa yalnız oturum/sistem varlığı aranır (demo'da operatör).
 * "yonetici" her isteğe yetişir; diğer rollerden biri seçili olmalı.
 */
export async function authorize(
  req: NextRequest,
  roles?: Role[]
): Promise<{ user: UserInfo } | { error: NextResponse }> {
  const user = await currentUser(req);
  if (!user) return { error: NextResponse.json({ error: "Oturum gerekli" }, { status: 401 }) };
  if (roles && roles.length > 0) {
    if (user.role !== "yonetici" && !roles.includes(user.role)) {
      return { error: NextResponse.json({ error: "Bu işlem için yetkiniz yok" }, { status: 403 }) };
    }
  }
  return { user };
}

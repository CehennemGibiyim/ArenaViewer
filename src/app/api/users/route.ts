import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { checkPasswordStrength, findAccountByUsername, makePasswordHash } from "@/lib/server/accounts";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["yonetici", "radyolog", "teknisyen"];

/** Kimlik bilgilerini asla döndürmez. */
const safeUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  title: u.title,
  regNo: u.regNo,
  role: u.role,
  active: u.active,
  twoFactorEnabled: u.twoFactorEnabled,
  lastLoginAt: u.lastLoginAt,
});

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const rows = await db.select().from(users).orderBy(desc(users.id));
  return NextResponse.json({ users: rows.map(safeUser) });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as {
    username?: string;
    fullName?: string;
    title?: string;
    regNo?: string;
    role?: string;
    password?: string;
  } | null;
  const username = (b?.username ?? "").trim().toLocaleLowerCase("tr-TR");
  const fullName = (b?.fullName ?? "").trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return NextResponse.json({ error: "Kullanıcı adı 3–40 karakter ve yalnız küçük harf/rakam/._- içermeli." }, { status: 400 });
  if (fullName.length < 3) return NextResponse.json({ error: "Ad soyad gerekli (en az 3 karakter)." }, { status: 400 });
  const role = (ROLES.includes(b?.role as Role) ? b?.role : "radyolog") as Role;
  const strength = checkPasswordStrength(b?.password ?? "");
  if (!strength.ok) return NextResponse.json({ error: strength.reason }, { status: 400 });
  if (await findAccountByUsername(username)) return NextResponse.json({ error: "Bu kullanıcı adı zaten var." }, { status: 409 });

  const ins = await db
    .insert(users)
    .values({
      username,
      passwordHash: makePasswordHash(b?.password ?? ""),
      fullName: fullName.slice(0, 120),
      title: (b?.title ?? "").slice(0, 60),
      regNo: (b?.regNo ?? "").slice(0, 40),
      role,
      active: true,
    })
    .returning({ id: users.id });
  await audit(a.user, "user.create", "user", ins[0].id, { username, role });
  return NextResponse.json({ ok: true, id: ins[0].id });
}

export async function PATCH(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as {
    id?: number;
    role?: string;
    active?: boolean;
    fullName?: string;
    title?: string;
    regNo?: string;
    password?: string;
  } | null;
  if (!b?.id) return NextResponse.json({ error: "id gerekli" }, { status: 400 });
  const cur = (await db.select().from(users).where(eq(users.id, b.id)).limit(1))[0];
  if (!cur) return NextResponse.json({ error: "Kullanıcı bulunamadı" }, { status: 404 });

  const set: Record<string, unknown> = {};
  if (typeof b.fullName === "string" && b.fullName.trim()) set.fullName = b.fullName.trim().slice(0, 120);
  if (typeof b.title === "string") set.title = b.title.trim().slice(0, 60);
  if (typeof b.regNo === "string") set.regNo = b.regNo.trim().slice(0, 40);
  if (b.role && ROLES.includes(b.role as Role)) set.role = b.role;
  if (typeof b.active === "boolean") set.active = b.active;
  if (typeof b.password === "string" && b.password) {
    const strength = checkPasswordStrength(b.password);
    if (!strength.ok) return NextResponse.json({ error: strength.reason }, { status: 400 });
    set.passwordHash = makePasswordHash(b.password);
  }
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Değişiklik yok" }, { status: 400 });

  // Son yöneticiyi pasif yapma/kaldırma: hesap modunda kilitlenmeyi önler.
  if ((set.active === false || set.role !== undefined) && cur.role === "yonetici") {
    const others = await db.select({ id: users.id }).from(users).where(eq(users.active, true));
    const admins = await db.select({ id: users.id, role: users.role }).from(users);
    const activeAdmins = admins.filter((x) => x.role === "yonetici" && others.some((o) => o.id === x.id));
    if (activeAdmins.length <= 1 && activeAdmins.some((x) => x.id === cur.id)) {
      return NextResponse.json({ error: "Son etkin yöneticiyi pasif yapamaz ya da rolünü değiştiremezsiniz." }, { status: 409 });
    }
  }

  await db.update(users).set(set).where(eq(users.id, cur.id));
  await audit(a.user, "user.update", "user", cur.id, { fields: Object.keys(set) });
  return NextResponse.json({ ok: true });
}

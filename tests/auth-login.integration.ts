/** Yalnız ayrılmış test PostgreSQL'iyle çalışır. Gerçek ortamlarda çalıştırmayın. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generate, generateSecret, verify } from "otplib";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/lib/server/passwords";

async function main() {
  if (process.env.AUTH_INTEGRATION_TEST !== "1" || !process.env.DATABASE_URL) {
    throw new Error("Yalnız ayrılmış test veritabanı için AUTH_INTEGRATION_TEST=1 ve DATABASE_URL gerekli.");
  }
  process.env.AUTH_MODE = "hesap";
  process.env.SESSION_SECRET = "ci-only-signing-secret-not-for-production";
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.ACCESS_TOKEN;
  process.env.REQUIRE_TOTP_FOR_ROLES = "yonetici";
  const { db, pool } = await import("../src/db/index");
  const { users, sessions } = await import("../src/db/schema");
  const { POST } = await import("../src/app/api/auth/login/route");
  const { SESSION_COOKIE, verifySessionCookie, verifySessionRef } = await import("../src/lib/server/session");
  const username = `test-${randomUUID()}`;
  const secret = generateSecret();
  const password = "Test-password-2026";
  let id: number | undefined;
  const lastLogin = async () => (await db.select({ at: users.lastLoginAt }).from(users).where(eq(users.id, id!)))[0]?.at;
  const login = (pw: string, code = "") => POST(new NextRequest("http://localhost/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: pw, code }),
  }));
  try {
    id = (await db.insert(users).values({ username, passwordHash: hashPassword(password), fullName: "Test", role: "radyolog", twoFactorEnabled: true, twoFactorSecret: secret }).returning({ id: users.id }))[0].id;
    let invalid = "000000";
    while ((await verify({ token: invalid, secret, epochTolerance: 30 })).valid) invalid = String(Number(invalid) + 1).padStart(6, "0");
    assert.equal((await login("wrong", invalid)).status, 401);
    assert.equal(await lastLogin(), null, "yanlış parola son girişi değiştirmemeli");
    assert.equal((await login(password, invalid)).status, 401);
    assert.equal(await lastLogin(), null, "yanlış MFA son girişi değiştirmemeli");
    assert.equal((await login(password)).status, 401);
    assert.equal(await lastLogin(), null, "eksik MFA son girişi değiştirmemeli");
    process.env.SESSION_SECRET = "";
    assert.equal((await login(password, await generate({ secret }))).status, 503);
    assert.equal(await lastLogin(), null, "imzalanamayan oturum son girişi değiştirmemeli");
    process.env.SESSION_SECRET = "ci-only-signing-secret-not-for-production";
    const valid = await login(password, await generate({ secret }));
    assert.equal(valid.status, 200);
    assert.equal(verifySessionCookie(valid.cookies.get(SESSION_COOKIE)?.value), id);
    assert.ok(await lastLogin(), "doğrulanmış oturum son girişi kaydetmeli");
    const previous = (await lastLogin())!.getTime();
    assert.equal((await login(password, invalid)).status, 401);
    assert.equal((await lastLogin())!.getTime(), previous, "sonraki başarısız MFA önceki zamanı değiştirmemeli");
    await db.update(users).set({ twoFactorEnabled: false, role: "yonetici", lastLoginAt: null }).where(eq(users.id, id));
    assert.equal((await login(password)).status, 403);
    assert.equal(await lastLogin(), null, "zorunlu MFA kurulmadığında son giriş değişmemeli");
    console.log("PASS PostgreSQL giriş akışı: parola, MFA, imzasız oturum ve başarılı oturum zamanı");

    // ── Sunucu oturum kaydı: listeleme + iptal (w-auth) ─────────────────────
    const cookieValue = valid.cookies.get(SESSION_COOKIE)?.value ?? "";
    const ref = verifySessionRef(cookieValue);
    assert.ok(ref && /^[a-f0-9]{32}$/.test(ref.sid), "oturum çerezinde sunucu oturum kimliği taşınmalı");
    const sRow = (await db.select().from(sessions).where(eq(sessions.id, ref!.sid)))[0];
    assert.ok(sRow, "girişte sessions satırı yazılmalı");
    assert.equal(sRow.userId, id);
    const route = await import("../src/app/api/sessions/route");
    const reqWith = (url: string, method = "GET") => new NextRequest(url, { method, headers: { cookie: `atik_user=${cookieValue}` } });
    const listRes = await route.GET(reqWith("http://localhost/api/sessions"));
    assert.equal(listRes.status, 200);
    const listed = (await listRes.json()) as { sessions: { id: string; current: boolean; userId: number }[]; currentId: string };
    const mine = listed.sessions.find((x) => x.id === ref!.sid);
    assert.ok(mine, "kendi oturumu listede görünmeli");
    assert.equal(mine!.current, true, "istek sahibi oturum 'current' işaretlenmeli");
    assert.equal(listed.currentId, ref!.sid);
    // Başkasının oturumunu sonlandırma yetkisi olmayan (radyolog) kullanıcı 403 almalı.
    await db.update(users).set({ role: "radyolog" }).where(eq(users.id, id!));
    // Başka bir kullanıcının oturumu: radyolog onu sonlandıramamalı (403).
    const otherId = (await db.insert(users).values({ username: `other-${randomUUID()}`, passwordHash: hashPassword("Other-pass-2026"), fullName: "Diğer", role: "radyolog" }).returning({ id: users.id }))[0].id;
    const foreign = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await db.insert(sessions).values({ id: foreign, userId: otherId, expiresAt: new Date(Date.now() + 3_600_000) });
    assert.equal((await route.DELETE(reqWith(`http://localhost/api/sessions?id=${foreign}`, "DELETE"))).status, 403, "başka kullanıcının oturumu sonlandırılamamalı");
    const stillThere = (await db.select({ r: sessions.revokedAt }).from(sessions).where(eq(sessions.id, foreign)))[0];
    assert.equal(stillThere.r, null, "yetkisiz iptal kaydı değiştirmemeli");
    await db.delete(sessions).where(eq(sessions.userId, otherId));
    await db.delete(users).where(eq(users.id, otherId));
    const delRes = await route.DELETE(reqWith(`http://localhost/api/sessions?id=${ref!.sid}`, "DELETE"));
    assert.equal(delRes.status, 200);
    const profile = await import("../src/app/api/profile/route");
    assert.equal((await profile.GET(reqWith("http://localhost/api/profile"))).status, 401, "iptal edilen oturum çerezi hesap modunda kimliksiz sayılmalı");
    assert.equal((await route.GET(reqWith("http://localhost/api/sessions"))).status, 401, "iptal sonrası liste de 401 dönmeli");
    console.log("PASS oturum iptali: liste kendi oturumunu işaretliyor, yetkisiz iptal 403, iptal sonrası çerez 401.");

    // ── Hesap kilitleme: eşik, kilitte doğru parola reddi, elle açma ────────
    process.env.AUTH_LOCK_MAX_FAILURES = "3";
    process.env.AUTH_LOCK_MINUTES = "10";
    await db.update(users).set({ role: "radyolog", twoFactorEnabled: false, twoFactorSecret: "", failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, id!));
    assert.equal((await login("yanlis-1")).status, 401);
    assert.equal((await login("yanlis-2")).status, 401);
    const third = await login("yanlis-3");
    assert.equal(third.status, 423, "eşik aşılınca giriş 423 ve kilit bilgisi dönmeli");
    const lockedBody = (await third.json()) as { locked?: boolean; retryAfterMinutes?: number };
    assert.equal(lockedBody.locked, true);
    assert.ok((lockedBody.retryAfterMinutes ?? 0) >= 1, "kalan kilit süresi bildirilmeli");
    assert.equal((await login(password)).status, 423, "kilitliyken doğru parola da kabul edilmemeli");
    const { unlockAccount } = await import("../src/lib/server/accounts");
    await unlockAccount(id!);
    const afterUnlock = (await db.select({ n: users.failedLoginCount, l: users.lockedUntil }).from(users).where(eq(users.id, id!)))[0];
    assert.equal(afterUnlock.n, 0, "kilit açılınca sayaç sıfırlanmalı");
    assert.equal(afterUnlock.l, null);
    const okAfter = await login(password);
    assert.equal(okAfter.status, 200, "kilit açıldıktan sonra giriş başarılı olmalı");
    // Süresi geçmiş kilit girişi engellememeli.
    await db.update(users).set({ failedLoginCount: 5, lockedUntil: new Date(Date.now() - 60_000) }).where(eq(users.id, id!));
    assert.equal((await login(password)).status, 200, "süresi geçmiş kilit girişi engellememeli");
    const reset = (await db.select({ n: users.failedLoginCount }).from(users).where(eq(users.id, id!)))[0];
    assert.equal(reset.n, 0, "başarılı giriş sayacı sıfırlamalı");
    delete process.env.AUTH_LOCK_MAX_FAILURES;
    delete process.env.AUTH_LOCK_MINUTES;
    console.log("PASS hesap kilitleme: 3 hatalı denemede kilit, kilitliyken doğru parola reddi, elle açma ve sayaç sıfırlama.");
  } finally {
    if (id) {
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

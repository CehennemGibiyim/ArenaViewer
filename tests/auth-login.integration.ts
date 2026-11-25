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
  const { users } = await import("../src/db/schema");
  const { POST } = await import("../src/app/api/auth/login/route");
  const { SESSION_COOKIE, verifySessionCookie } = await import("../src/lib/server/session");
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

    // ── Sunucu taraflı oturum kaydı + iptal + kilitleme ─────────────────────
    await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, id));
    const { userSessions } = await import("../src/db/schema");
    const { checkSession, revokeSession, listSessions, loginLocked, recordAttempt } = await import("../src/lib/server/sessionStore");
    const { sessionFromRequest } = await import("../src/lib/server/session");
    const login2 = await login(password, await generate({ secret }));
    assert.equal(login2.status, 200);
    const cookie = login2.cookies.get(SESSION_COOKIE)!.value;
    const ctx = sessionFromRequest(new NextRequest("http://localhost/api/x", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }));
    assert.ok(ctx?.sid, "çerez oturum kimliği (sid) taşımalı");
    const rows = await db.select().from(userSessions).where(eq(userSessions.userId, id));
    assert.equal(rows.length, 1, "giriş başına bir oturum kaydı");
    assert.equal("sid" in rows[0], false, "veritabanında çerez kimliği düz metin tutulmamalı");
    assert.equal((await checkSession(ctx!.sid, id)).ok, true, "kayıtlı oturum geçerli");
    assert.equal(await revokeSession(ctx!.sid, id), true, "oturum iptal edilebilmeli");
    assert.deepEqual(await checkSession(ctx!.sid, id), { ok: false, reason: "iptal" }, "iptal edilen oturum çerezle reddedilmeli");
    assert.equal((await login2.status), 200);
    const own = await listSessions({ userId: id, includeExpired: true });
    assert.ok(own.length >= 1);
    assert.equal(own[0].revokedAt !== null || own[0].expiresAt.getTime() > Date.now(), true);
    // Kilitleme: 5 hatalı denemeden sonra kilit; başarılı kayıt kilidi kaldırır.
    const uname = `lock-${randomUUID()}`;
    for (let i = 0; i < 5; i++) await recordAttempt(uname, "127.0.0.1", false, "test");
    const locked = await loginLocked(uname);
    assert.equal(locked.locked, true, "5 hatalı denemeden sonra hesap kilitlenmeli");
    assert.ok(locked.retryAfterSec > 0);
    await recordAttempt(uname, "127.0.0.1", true, "");
    assert.equal((await loginLocked(uname)).locked, false, "başarılı giriş kilidi kaldırmalı");
    console.log("PASS PostgreSQL oturum kaydı: sid hash'li saklanıyor, iptal çerezle reddediliyor, kilit çalışıyor.");
  } finally {
    if (id) await db.delete(users).where(eq(users.id, id));
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

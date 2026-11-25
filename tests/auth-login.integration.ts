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
  } finally {
    if (id) await db.delete(users).where(eq(users.id, id));
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

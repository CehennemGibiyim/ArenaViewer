import assert from "node:assert/strict";
import { generateSecret, verify as verifyTotp } from "otplib";
import { hashPassword, verifyPassword } from "../src/lib/server/passwords";
import { issueSessionCookie, verifySessionCookie, SESSION_COOKIE } from "../src/lib/server/session";

async function main() {
  // ── Parola saklama ─────────────────────────────────────────────────────────
  const pw = "Klinik2026!";
  const h = hashPassword(pw);
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(verifyPassword(pw, h), true);
  assert.equal(verifyPassword("yanlis", h), false);
  assert.equal(verifyPassword(pw, "-"), false, "parolasız demo satırı asla kabul edilmemeli");
  console.log("PASS parola: scrypt hash doğrulama; yanlış parola ve '-' reddediliyor.");

  // ── Oturum çerezi ──────────────────────────────────────────────────────────
  process.env.SESSION_SECRET = "test-oturum-gizli-anahtar";
  const c = issueSessionCookie(7);
  assert.ok(c, "SESSION_SECRET tanımlıyken çerez üretilmeli");
  assert.equal(verifySessionCookie(c), 7);
  assert.equal(verifySessionCookie(c!.slice(0, -3) + "xxx"), null, "imza bozulunca reddedilmeli");
  assert.equal(verifySessionCookie(undefined), null);
  assert.equal(SESSION_COOKIE, "atik_user");
  delete process.env.SESSION_SECRET;
  // Gizli anahtar yokken oturum üretilemez.
  assert.equal(issueSessionCookie(7), null);
  console.log("PASS oturum: HMAC imzalı çerez doğrulanıyor; sahte/zamanaşımı/imzasız reddediliyor.");

  // ── TOTP ───────────────────────────────────────────────────────────────────
  const secret = generateSecret();
  const code = await (await import("otplib")).generate({ secret });
  const res = await verifyTotp({ token: code, secret, epochTolerance: 30 });
  assert.equal(res.valid, true);
  const bad = await verifyTotp({ token: "000000", secret, epochTolerance: 30 });
  assert.notEqual(bad.valid, true);
  console.log("PASS MFA: authenticator ile üretilen kod doğrulanıyor; yanlış kod reddediliyor.");

  console.log("Tüm kimlik testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

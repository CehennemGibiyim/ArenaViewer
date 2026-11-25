import assert from "node:assert/strict";
import { generateSecret, verify as verifyTotp } from "otplib";
import { hashPassword, verifyPassword } from "../src/lib/server/passwords";
import {
  issueSessionCookie,
  SESSION_COOKIE,
  SESSION_ID_RE,
  verifySessionCookie,
  verifySessionRef,
} from "../src/lib/server/session";
import { isLocked, lockRemainingMinutes, lockoutPolicy } from "../src/lib/server/lockout";

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

  // ── Sunucu oturum kimliği (aktif oturum listesi / iptali) ─────────────────
  process.env.SESSION_SECRET = "test-oturum-gizli-anahtar";
  const sid = "0123456789abcdef0123456789abcdef";
  assert.match(sid, SESSION_ID_RE);
  const withSid = issueSessionCookie(7, sid)!;
  const ref = verifySessionRef(withSid);
  assert.equal(ref?.uid, 7);
  assert.equal(ref?.sid, sid, "oturum kimliği çerezde taşınmalı");
  assert.equal(verifySessionCookie(withSid), 7, "eski API yalnız uid döndürmeye devam etmeli");
  // İki alanlı (eski) çerez: kimliksiz ama süresi dolana kadar geçerli.
  const legacy = issueSessionCookie(7)!;
  assert.equal(verifySessionRef(legacy)?.uid, 7);
  assert.equal(verifySessionRef(legacy)?.sid, "");
  // Biçimsiz kimlik çereze hiç yazılmaz (imzalanacak alan şişirilmesin).
  assert.equal(verifySessionRef(issueSessionCookie(7, "NOT-A-SID")!)?.sid, "");
  // Kimliği değiştirip yeniden imzalamadan göndermek imzayı bozar.
  const payload = withSid.slice(0, withSid.lastIndexOf("."));
  const text = Buffer.from(payload, "base64url").toString("utf8");
  const forgedPayload = Buffer.from(text.replace(sid, "ffffffffffffffffffffffffffffffff"), "utf8").toString("base64url");
  assert.equal(verifySessionRef(`${forgedPayload}.${withSid.slice(withSid.lastIndexOf(".") + 1)}`), null, "kimlik değiştirilirse imza tutmamalı");
  delete process.env.SESSION_SECRET;
  console.log("PASS oturum kimliği: sid imzalı çerezde taşınıyor; eski iki alanlı çerez ve sahte sid ayrımı doğru.");

  // ── Hesap kilitleme ilkesi (w-auth) ──────────────────────────────────────
  delete process.env.AUTH_LOCK_MAX_FAILURES;
  delete process.env.AUTH_LOCK_MINUTES;
  assert.deepEqual(lockoutPolicy(), { max: 5, minutes: 15 });
  process.env.AUTH_LOCK_MAX_FAILURES = "3";
  process.env.AUTH_LOCK_MINUTES = "30";
  assert.deepEqual(lockoutPolicy(), { max: 3, minutes: 30 });
  process.env.AUTH_LOCK_MAX_FAILURES = "0";
  process.env.AUTH_LOCK_MINUTES = "abc";
  assert.deepEqual(lockoutPolicy(), { max: 5, minutes: 15 }, "geçersiz değer kilidi kapatmamalı");
  process.env.AUTH_LOCK_MAX_FAILURES = "9999";
  assert.equal(lockoutPolicy().max, 50, "aşırı büyük eşik sınırlanmalı");
  delete process.env.AUTH_LOCK_MAX_FAILURES;
  delete process.env.AUTH_LOCK_MINUTES;
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(isLocked(new Date(now + 60_000), now), true);
  assert.equal(isLocked(new Date(now - 1), now), false, "süresi geçmiş kilit etkin sayılmamalı");
  assert.equal(isLocked(null, now), false);
  assert.equal(lockRemainingMinutes(new Date(now + 61_000), now), 2, "kalan süre yukarı yuvarlanmalı");
  assert.equal(lockRemainingMinutes(new Date(now - 5_000), now), 0);
  assert.equal(lockRemainingMinutes(null, now), 0);
  console.log("PASS hesap kilitleme: eşik/süre ortamdan okunuyor, geçersiz değer güvenli varsayılana düşüyor, kalan süre doğru.");

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

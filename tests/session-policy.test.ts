import assert from "node:assert/strict";
import {
  DEFAULT_LOCK,
  describeClient,
  lockMessage,
  lockPolicyFromEnv,
  lockState,
  sessionState,
  sessionTtlMs,
  sessionUsable,
  toSessionView,
  type SessionRecordView,
} from "../src/lib/sessionPolicy";

const now = Date.parse("2026-11-25T10:00:00Z");
const at = (min: number) => new Date(now - min * 60_000);
const inMin = (min: number) => new Date(now + min * 60_000);

// ── Oturum durumu ───────────────────────────────────────────────────────────
assert.equal(sessionState({ expiresAt: inMin(5), revokedAt: null }, now), "aktif");
assert.equal(sessionState({ expiresAt: inMin(5), revokedAt: at(1) }, now), "iptal-edilmis");
assert.equal(sessionState({ expiresAt: at(1), revokedAt: null }, now), "suresi-dolmus");
assert.equal(sessionUsable({ expiresAt: inMin(1), revokedAt: null }, now), true);
assert.equal(sessionUsable({ expiresAt: inMin(1), revokedAt: at(1) }, now), false, "iptal edilen oturum, süre dolmamış olsa da kullanılamaz");
assert.equal(sessionUsable({ expiresAt: at(1), revokedAt: null }, now), false);
console.log("PASS oturum durumu: aktif / süresi dolmuş / iptal edilmiş ayrımı doğru.");

// ── TTL ─────────────────────────────────────────────────────────────────────
assert.equal(sessionTtlMs({}), 8 * 3600 * 1000, "varsayılan 8 saat");
assert.equal(sessionTtlMs({ SESSION_MAX_AGE_SECONDS: "3600" }), 3600 * 1000);
assert.equal(sessionTtlMs({ SESSION_MAX_AGE_SECONDS: "10" }), 8 * 3600 * 1000, "çok kısa değer kabul edilmez");
assert.equal(sessionTtlMs({ SESSION_MAX_AGE_SECONDS: "999999999" }), 8 * 3600 * 1000, "çok uzun değer kabul edilmez");
assert.equal(sessionTtlMs({ SESSION_MAX_AGE_SECONDS: "abc" }), 8 * 3600 * 1000);
console.log("PASS oturum süresi: ortam değişkeni sınırlarla doğrulanıyor.");

// ── İstemci tanımı ──────────────────────────────────────────────────────────
assert.match(describeClient({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0 Safari/537.36" }), /Chrome\/131.*Windows/);
assert.match(describeClient({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/17.0 Safari/605.1" }), /Safari/);
assert.equal(describeClient({}), "bilinmeyen istemci");
assert.ok(describeClient({ userAgent: "x".repeat(500) }).length <= 120, "uzun UA kısaltılmalı");
console.log("PASS istemci tanımı: tarayıcı + işletim sistemi, sınırlı uzunlukta.");

// ── Oturum görünümü ─────────────────────────────────────────────────────────
const row: SessionRecordView = {
  id: "abc",
  userId: 3,
  username: "ayse",
  fullName: "Ayşe Kaya",
  role: "radyolog",
  createdAt: at(10),
  lastSeenAt: at(2),
  expiresAt: inMin(60),
  revokedAt: null,
  ip: "10.0.0.5",
  userAgent: "Chrome/131 · Windows",
};
const v = toSessionView(row, "abc", now);
assert.equal(v.current, true);
assert.equal(v.state, "aktif");
assert.equal(v.createdAt, (row.createdAt as Date).toISOString());
assert.equal(toSessionView(row, "baska", now).current, false);
assert.equal(JSON.stringify(v).includes("revokedAt"), true);
console.log("PASS oturum görünümü: 'bu cihaz' işareti ve ISO zamanlar.");

// ── Hesap kilidi ────────────────────────────────────────────────────────────
const fail = (min: number) => ({ at: at(min), ok: false });
const okAt = (min: number) => ({ at: at(min), ok: true });

// 4 hata → kilit yok, 1 deneme kaldı
let s = lockState([fail(5), fail(4), fail(3), fail(2)], now);
assert.equal(s.locked, false);
assert.equal(s.failures, 4);
assert.equal(s.remaining, 1);
// 5 hata → kilitli, son hatadan 15 dk sonrasına kadar
s = lockState([fail(6), fail(5), fail(4), fail(3), fail(2)], now);
assert.equal(s.locked, true);
assert.equal(s.remaining, 0);
assert.ok(s.retryAfterSec > 0 && s.retryAfterSec <= 15 * 60);
// Pencere dışındaki hatalar sayılmaz
s = lockState([fail(40), fail(30), fail(20), fail(5), fail(4)], now);
assert.equal(s.locked, false, "15 dk penceresi dışındaki hatalar sayılmamalı");
assert.equal(s.failures, 2);
// Başarılı giriş pencereyi temizler
s = lockState([fail(6), fail(5), fail(4), fail(3), fail(2), okAt(1)], now);
assert.equal(s.locked, false, "başarılı girişten sonra kilit kalkmalı");
assert.equal(s.failures, 0);
// Kilit, son hatadan itibaren lockMs sürer: son hata 1 dk önce → ~14 dk kaldı
s = lockState([fail(5), fail(4), fail(3), fail(2), fail(1)], now);
assert.equal(s.locked, true);
assert.ok(s.retryAfterSec > 13 * 60 && s.retryAfterSec <= 14 * 60, "kalan süre son hatadan hesaplanmalı");
// Tüm hatalar pencerenin dışında → kilit yok (sayaç sıfırlanmış sayılır)
s = lockState([fail(20), fail(19), fail(18), fail(17), fail(16)], now);
assert.equal(s.locked, false, "penceresi geçmiş hatalar kilidi sürdürmemeli");
console.log("PASS hesap kilidi: 5 hata → kilit, pencere dışı sayılmaz, başarılı giriş temizler.");

// Politika: ortam değişkenleri ve sınırlar
assert.deepEqual(lockState([], now, DEFAULT_LOCK), { locked: false, retryAfterSec: 0, failures: 0, remaining: 5 });
assert.equal(lockPolicyFromEnv({}).maxFailures, 5);
assert.equal(lockPolicyFromEnv({ LOGIN_LOCK_MAX_FAILURES: "3" }).maxFailures, 3);
assert.equal(lockPolicyFromEnv({ LOGIN_LOCK_MAX_FAILURES: "1" }).maxFailures, 5, "1 kabul edilmez (min 2)");
assert.equal(lockPolicyFromEnv({ LOGIN_LOCK_MINUTES: "30" }).lockMs, 30 * 60_000);
assert.match(lockMessage(600), /10 dakika/);
assert.match(lockMessage(5), /1 dakika/, "en az 1 dakika denir");
console.log("PASS kilit politikası: ortam değişkenleri, sınırlar ve kullanıcı mesajı.");

// Eşit zamanlı hatalar çökertmez (Math.max boş dizi)
assert.equal(lockState([], now).locked, false);
assert.equal(lockState([{ at: "bozuk", ok: false }], now).failures, 0, "geçersiz zaman sayılmaz");
console.log("Tüm oturum politikası testleri geçti.");

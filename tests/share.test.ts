/** Süreli paylaşım bağlantısı (F5) mantık testleri. */
import { formatExpiry, isUsable, shareState, summarizeShares, ttlToExpiresAt, watermarkText, type ShareRow } from "../src/lib/share";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const NOW = new Date("2026-01-15T12:00:00Z");
const HOUR = 3_600_000;

ok(ttlToExpiresAt(24, NOW).getTime() === NOW.getTime() + 24 * HOUR, "Süre → sona erme");

const row = (over: Partial<ShareRow>): ShareRow => ({
  id: 1, token: "a".repeat(48), kind: "report", reportId: 7, studyId: null, createdBy: 1,
  createdByName: "Dr A", expiresAt: new Date(NOW.getTime() + 2 * HOUR), revokedAt: null,
  accessCount: 0, lastAccessAt: null, createdAt: NOW, ...over,
});
const active = row({});
ok(isUsable(active, NOW) && shareState(active, NOW) === "aktif", "Aktif bağlantı");
ok(!isUsable(row({ expiresAt: new Date(NOW.getTime() - 1) }), NOW) && shareState(row({ expiresAt: new Date(NOW.getTime() - 1) }), NOW) === "suresi doldu", "Süresi dolmuş");
ok(!isUsable(row({ revokedAt: new Date(NOW.getTime() - 100) }), NOW) && shareState(row({ revokedAt: new Date(NOW.getTime() - 100) }), NOW) === "kapatildi", "Kapatılmış");
ok(isUsable(active, new Date(NOW.getTime() + 48 * HOUR)) === false, "Sonradan süresi dolar");

ok(formatExpiry(active, NOW).includes("saat"), `Biçim ${formatExpiry(active, NOW)}`);
ok(formatExpiry(row({ expiresAt: new Date(NOW.getTime() - 5) }), NOW) === "süresi doldu", "Bitti etiketi");

const rows = [active, row({ id: 2, expiresAt: new Date(NOW.getTime() - 1) }), row({ id: 3, revokedAt: new Date(NOW) })];
const s = summarizeShares(rows, NOW);
ok(s.total === 3 && s.active === 1 && s.expired === 1 && s.revoked === 1, `Özet ${JSON.stringify(s)}`);

ok(watermarkText("abcdef0123456789").startsWith("ATIKVIEWER · SÜRELİ PAYLAŞIM · ABCDEF01"), "Filigran metni token önekli");

if (failed) { console.error(`${failed} paylaşım testi başarısız`); process.exit(1); }
console.log("Tüm paylaşım testleri geçti.");

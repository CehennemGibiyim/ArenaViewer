/**
 * g-audit-export — şifreli arşiv + saklama politikası (saf katman).
 * DB/ağ yok: seçim, manifesto, imza ve zincir doğrulaması sınanır.
 */
import { createHash } from "node:crypto";
import {
  MAX_ARCHIVE_BATCH, retentionConfig, cutoffIso, isExpired, selectForArchive,
  manifestName, toJsonl, sha256Hex, signManifest, verifyManifest, verifyArchive,
  describeRetention, type ArchiveRow,
} from "../src/lib/auditArchivePlan";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const day = 86_400_000;
const now = new Date("2026-11-27T12:00:00.000Z");
const hash = (n: number) => createHash("sha256").update(`h${n}`).digest("hex");

/** sıralı, zincirli kayıt üretir: r1..rN, ts gün gün eskiyen. */
function rows(n: number, opts: { startDaysAgo?: number; stepDays?: number } = {}): ArchiveRow[] {
  const start = opts.startDaysAgo ?? 400;
  const step = opts.stepDays ?? 1;
  const out: ArchiveRow[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: i, ts: new Date(now.getTime() - (start - (i - 1) * step) * day).toISOString(),
      username: "dr@x", action: "report.approve", entityType: "report", entityId: String(i),
      details: "{}", hash: hash(i), prevHash: i === 1 ? "0".repeat(64) : hash(i - 1),
    });
  }
  return out;
}

// ── 1. Yapılandırma: sessiz "0 gün" tehlikesi yok ──
const off = retentionConfig({});
ok(off.days === 0 && off.batch === 1000 && off.dir === "audit-archive", "varsayılan: politika KAPALI, 1000'lik parti");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "" }).days === 0, "boş değer → kapalı");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "0" }).days === 0, "0 → kapalı (hepsini silmez)");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "-5" }).days === 0, "negatif → kapalı");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "abc" }).days === 0, "sayı olmayan → kapalı");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "2190" }).days === 2190, "6 yıl (ülke mevzuatı) kabul");
ok(retentionConfig({ AUDIT_RETENTION_DAYS: "30.9" }).days === 30, "kesirli gün aşağı yuvarlanır");
ok(retentionConfig({ AUDIT_ARCHIVE_BATCH: "999999" }).batch === MAX_ARCHIVE_BATCH, "parti üst sınırı kelepçelenir");
ok(retentionConfig({ AUDIT_ARCHIVE_BATCH: "0" }).batch === 1000, "geçersiz parti → varsayılan");
ok(retentionConfig({ AUDIT_ARCHIVE_DIR: "  " }).dir === "audit-archive", "boş dizin → varsayılan");

// ── 2. Eşik (cutoff) ──
ok(cutoffIso(off, now) === null, "kapalı politikada eşik yok");
const cfg = retentionConfig({ AUDIT_RETENTION_DAYS: "365" });
ok(cutoffIso(cfg, now) === "2025-11-27T12:00:00.000Z", "365 gün eşiği tam hesaplanır");
ok(isExpired({ ts: "2025-11-27T11:59:59.000Z" }, cutoffIso(cfg, now)), "eşikten önce → süresi geçmiş");
ok(!isExpired({ ts: "2025-11-27T12:00:00.000Z" }, cutoffIso(cfg, now)), "eşik anı → canlı kalır (sınır dahil değil)");
ok(!isExpired({ ts: "2020-01-01T00:00:00.000Z" }, null), "politika kapalıyken hiçbiri süresi geçmiş değil");
ok(!isExpired({ ts: "bozuk" }, cutoffIso(cfg, now)), "ayrıştırılamayan tarih SİLİNMEZ (güvenli taraf)");

// ── 3. Seçim: yalnız bitişik ön ek, zincir yeşilse ──
const r = rows(10, { startDaysAgo: 400 });
const sel = selectForArchive(r, cutoffIso(cfg, now), 100, { ok: true });
ok(sel.length === 10 && sel.every((x) => x.id <= 10), "tümü pencere dışıysa hepsi seçilir");
ok(selectForArchive(r, cutoffIso(cfg, now), 4, { ok: true }).length === 4, "parti sınırı uygulanır");
ok(selectForArchive(r, cutoffIso(cfg, now), 4, { ok: true }).at(-1)!.id === 4, "parti EN ESKİ kayıtlardan başlar");
ok(selectForArchive(r, cutoffIso(cfg, now), 100, { ok: false, brokenAtId: 7 }).length === 0, "zincir bozuksa HİÇBİR ŞEY taşınmaz (delil korunur)");
ok(selectForArchive(r, null, 100, { ok: true }).length === 0, "politika kapalıyken seçim yok");
ok(selectForArchive([], cutoffIso(cfg, now), 100, { ok: true }).length === 0, "boş tablo");
// Güncel bir kayıt araya girerse orada durulur (canlı tabloda kopuk zincir bırakılmaz)
const mixed = [...rows(3, { startDaysAgo: 400 }), { ...rows(1, { startDaysAgo: 1 })[0], id: 4, hash: hash(4), prevHash: hash(3) }];
const mixedSel = selectForArchive(mixed, cutoffIso(cfg, now), 100, { ok: true });
ok(mixedSel.length === 3 && !mixedSel.some((x) => x.id === 4), "pencere içi kayıtta durur (bitişik blok)");
// Sırasız giriş de doğru sıralanır
const shuffled = [r[2], r[0], r[1]];
ok(selectForArchive(shuffled, cutoffIso(cfg, now), 2, { ok: true }).map((x) => x.id).join(",") === "1,2", "giriş sırası ne olursa olsun id'ye göre sıralar");

// ── 4. JSONL + hash ──
const jl = toJsonl(r.slice(0, 2));
ok(jl.split("\n").filter(Boolean).length === 2 && jl.endsWith("\n"), "JSONL: satır başına kayıt + son satır sonu");
const first = JSON.parse(jl.split("\n")[0]);
ok(Object.keys(first).join(",") === "id,ts,username,action,entityType,entityId,details,hash,prevHash", "alan sırası deterministik (imza tekrarlanabilir)");
ok(/^\d{4}-\d{2}-\d{2}T/.test(first.ts), "tarih ISO biçiminde");
ok(toJsonl([]) === "", "boş arşiv boş dosya");
ok(sha256Hex("abc") === createHash("sha256").update("abc").digest("hex"), "sha256 yardımcısı doğru");
ok(manifestName(now, 42) === "audit-2026-11-27T12-00-00-000Z-42.jsonl.enc", "dosya adı zaman + son id (dosya adı güvenli)");
ok(!/[:/]/.test(manifestName(now, null)), "dosya adında yol/ayırıcı karakter yok");

// ── 5. Manifesto imzası ──
const key = "arsiv-anahtari-123";
const m = {
  version: 1 as const, createdAt: now.toISOString(), cutoff: cutoffIso(cfg, now)!, count: 2,
  firstId: 1, lastId: 2, prevHash: r[0].prevHash, lastHash: r[1].hash,
  cipherSha256: sha256Hex("sifreli-icerik"), dir: "audit-archive", name: manifestName(now, 2),
};
const sig = signManifest(m, key);
ok(/^[0-9a-f]{64}$/.test(sig), "imza 64 hex (HMAC-SHA256)");
ok(verifyManifest(m, sig, key).ok, "geçerli imza doğrulanır");
ok(!verifyManifest({ ...m, count: 3 }, sig, key).ok, "gövde değişirse imza tutmaz");
ok(!verifyManifest(m, sig, "baska-anahtar").ok, "yanlış anahtar reddedilir");
ok(verifyManifest(m, sig, null).reason.includes("AUDIT_ARCHIVE_KEY"), "anahtar yoksa 'doğrulanamaz' (geçerli sayılmaz)");
ok(/uzunlu/.test(verifyManifest(m, "abcd", key).reason), "kısa imza uzunluk hatası verir");
ok(!verifyManifest(m, "zzzz", key).ok, "hex olmayan imza reddedilir");
ok(signManifest({ ...m, name: "x" }, key) !== sig, "dosya adı değişince imza değişir");

// ── 6. Arşiv zinciri doğrulaması ──
ok(verifyArchive([], "abc").ok, "boş arşiv geçerli");
ok(verifyArchive(r.slice(0, 3), r[0].prevHash).ok, "çapaya bağlı 3 kayıt geçerli");
ok(verifyArchive(r.slice(0, 3), null).ok, "çapa verilmezse yalnız iç zincir bakılır");
ok(!verifyArchive(r.slice(0, 3), "f".repeat(64)).ok, "çapa uyuşmazsa reddedilir");
const broken = r.slice(0, 3).map((x, i) => (i === 2 ? { ...x, prevHash: hash(99) } : x));
ok(!verifyArchive(broken, null).reason.includes("kopuk") === false, "kopuk zincir tespit edilir");
const wrongOrder = [r[1], r[0]];
ok(!verifyArchive(wrongOrder, null).ok, "ters sıra reddedilir");

// ── 7. Panel/log metni ──
ok(/kapalı/.test(describeRetention(off)) && /AUDIT_RETENTION_DAYS/.test(describeRetention(off)), "kapalı politika çözüm önerir");
ok(/365 gün/.test(describeRetention(cfg)) && /şifreli/.test(describeRetention(cfg)), "açık politika süreyi ve arşivi söyler");


// ── 8. Uç ↔ panel ↔ doküman sözleşmesi (kaynak taraması) ──
import { readFileSync } from "node:fs";
import path from "node:path";
const root2 = path.resolve(__dirname, "..");
const read2 = (p: string) => readFileSync(path.join(root2, p), "utf8");
const routeSrc = read2("src/app/api/audit/archive/route.ts");
const verifySrc = read2("src/app/api/audit/archive/verify/route.ts");
ok(/authorize\(req, \["yonetici"\]\)/.test(routeSrc), "arşiv uçları yönetici yetkisi ister");
ok(/authorize\(req, \["yonetici"\]\)/.test(verifySrc), "doğrulama ucu da yönetici yetkisi ister");
// Duyarlı işlem kullanıcı parametresiyle seçilmez (CodeQL: user-controlled sensitive action).
ok(!/searchParams/.test(verifySrc) && /verifyArchiveDir/.test(verifySrc), "doğrulama yolu sabit (parametresiz)");
ok(!/verify=1/.test(routeSrc) && !/verifyArchiveDir/.test(routeSrc), "durum ucu doğrulamayı tetiklemez (ayrı uç)");
ok(/audit\.archive/.test(routeSrc), "koşu denetim izine yazılır");
ok(/runArchive/.test(routeSrc) && /archiveStatus/.test(routeSrc), "uçlar yürütücüyü kullanır (mantık ikizlenmez)");
const runner = read2("src/lib/server/auditArchive.ts");
ok(/encryptBuffer/.test(runner) && /sha256Hex\(cipher\)/.test(runner), "arşiv şifrelenir, içerik hash'i manifestoda");
ok(/purge: "istendi-ama-engellendi"/.test(runner), "silme iddiası yok (DB DELETE'e kapalı)");
ok(/decryptBuffer/.test(runner), "doğrulama şifreyi çözer");
const plan2 = read2("src/lib/auditArchivePlan.ts");
ok(/timingSafeEqual/.test(plan2), "imza sabit zamanlı karşılaştırılır");
ok(!/AUDIT_ARCHIVE_KEY:\s*"[^"]*"/.test(read2("src/lib/server/auditArchive.ts")), "imza anahtarı koda gömülmez");
const panel2 = read2("src/components/AdminPanel.tsx");
ok(/\/api\/audit\/archive/.test(panel2) && /Arşiv koşusunu çalıştır/.test(panel2), "panel arşiv koşusunu tetikler");
ok(/\/api\/audit\/archive\/verify/.test(panel2), "panel doğrulama ucunu çağırır");
ok(/Arşivi doğrula/.test(panel2), "panel arşivi doğrular");
const health2 = read2("src/app/api/admin/health/route.ts");
ok(/retentionConfig/.test(health2) && /audit-retention/.test(health2), "sağlık ucu politika tanımsızlığını bildirir");
const doc = read2("docs/YEDEK_VE_DR.md");
for (const marker of ["AUDIT_RETENTION_DAYS", "AUDIT_ARCHIVE_DIR", "manifest", "partisyon"]) {
  ok(doc.includes(marker), `belge "${marker}" konusunu kapsıyor`);
}
const pkg = JSON.parse(read2("package.json")) as { scripts: Record<string, string> };
ok(!!pkg.scripts["test:audit-archive"] && !!pkg.scripts["test:audit-archive-e2e"], "test komutları kayıtlı");
ok(pkg.scripts.test.includes("test:audit-archive-e2e"), "tam test paketine dahil");

console.log(`\naudit-archive (sözleşme dahil): ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
process.exit(fail === 0 ? 0 : 1);

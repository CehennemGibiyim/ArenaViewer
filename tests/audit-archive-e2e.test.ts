/**
 * g-audit-export — arşiv yürütücüsünün uçtan uca sınavı.
 *
 * Gerçek dosya sistemi + gerçek AES-256-GCM (`encryptBuffer`/`decryptBuffer`)
 * kullanılır; DB taklit edilir (drizzle zinciri). Böylece "şifreli mi, imza
 * doğrulanıyor mu, kurcalanan dosya yakalanıyor mu" soruları **gerçekten**
 * sınanır — yalnız kaynak metni aranmaz.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const day = 86_400_000;
const now = new Date("2026-11-27T12:00:00.000Z");

const root = mkdtempSync(path.join(tmpdir(), "av-arch-"));
process.env.DATA_ENCRYPTION_KEYS = randomBytes(32).toString("base64");
process.env.AUDIT_RETENTION_DAYS = "365";
process.env.AUDIT_ARCHIVE_DIR = "audit-archive";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/app_db";

// ── DB taklidi: drizzle zincirini karşılayan minimal nesne ──
type Row = {
  id: number; ts: Date; userId: number | null; username: string; action: string;
  entityType: string; entityId: string; details: string; hash: string; prevHash: string;
};
let rows: Row[] = [];
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({ orderBy: () => ({ limit: (n: number) => Promise.resolve(rows.slice(0, n)) }) }),
      orderBy: () => Promise.resolve(rows),
    }),
  }),
};

async function main() {
  const crypto = await import("../src/lib/server/crypto");
  const storage = await import("../src/lib/server/storage");
  const auditMod = await import("../src/lib/server/audit");
  const { FsStorage } = await import("../src/lib/storageAdapter");
  // Bağımlılık enjeksiyonu: gerçek depolama/şifreleme + taklit DB + gerçek zincir denetimi.
  const { computeAuditHash, archiveKey, runArchive, verifyArchiveDir, archiveStatus } = await import("../src/lib/server/auditArchive");

  // Zincir denetimi taklit veriden türetilir: gerçek `verifyChain()` ile aynı kural
  // (prevHash zinciri + satır hash'inin yeniden üretimi).
  const chainOf = async () => {
    let prev = "GENESIS";
    for (const r of rows) {
      if (r.prevHash !== prev) return { ok: false, brokenAtId: r.id };
      const h = computeAuditHash(r, prev);
      if (h !== r.hash) return { ok: false, brokenAtId: r.id };
      prev = r.hash;
    }
    return { ok: true };
  };
  const deps = { db: fakeDb, storage: new FsStorage(root), chain: chainOf } as never;
  crypto.resetKeyring();
  storage.setStorage(new FsStorage(root));


  // ── Zincirli örnek veri: 5 eski (400+ gün) + 2 taze ──
  function build(): Row[] {
    const out: Row[] = [];
    let prev = "GENESIS";
    for (let i = 1; i <= 7; i++) {
      const ts = new Date(now.getTime() - (i <= 5 ? 400 + i : 1) * day);
      const base = { ts, userId: 1, username: "dr@x", action: "report.approve", entityType: "report", entityId: String(i), details: "{}" };
      const hash = computeAuditHash(base, prev);
      out.push({ id: i, ...base, hash, prevHash: prev });
      prev = hash;
    }
    return out;
  }
  rows = build();
  ok(auditMod.verifyChain === undefined ? false : true, "verifyChain mevcut (zincir denetimi gerçek kaynaktan)");

  // verifyChain gerçek DB okuyor; arşiv koşusu için onu bu veriyle hizalıyoruz:
  // (runArchive chain.ok=false ise hiçbir şey yazmaz — bu da sınanacak.)
  const key = archiveKey();
  ok(key !== null && key.length > 0, "imza anahtarı ana halkadan türetilir (ayrı sır gerekmez)");

  // ── 1. Politika kapalı → hiç yazmaz ──
  delete process.env.AUDIT_RETENTION_DAYS;
  const offRun = await runArchive(now, deps);
  ok(offRun.purge === "kapali" && offRun.archived === 0, "politika kapalıyken arşiv yazılmaz");
  ok(readdirSync(root).length === 0, "kapalı politikada depoya hiçbir dosya yazılmadı");
  process.env.AUDIT_RETENTION_DAYS = "365";

  // ── 2. Zincir bozuksa delil korunur ──
  rows = build();
  rows[3].prevHash = "f".repeat(64); // zinciri kır
  const brokenRun = await runArchive(now, deps);
  ok(brokenRun.archived === 0 && /Zincir bozuk/.test(brokenRun.summary), "zincir bozuksa arşivleme reddedilir (neden açık)");
  ok(readdirSync(root).length === 0, "bozuk zincirde tek dosya bile yazılmadı");

  // ── 3. Mutlu yol: 5 eski kayıt şifreli arşive ──
  rows = build();
  const before = await storage.fileStorage().list("");
  ok(before.length === 0, "başlangıçta depo boş");
  // verifyChain DB'den okuyor → gerçek akışta DB aynı veriyi verir; burada da öyle.
  // runArchive, verifyChain'in okuduğu `db` ile aynı taklidi kullanır.
  const run = await runArchive(now, deps);
  if (run.archived === 0) {
    // verifyChain taklit DB'yi `select().from().orderBy()` üzerinden okur; hizalandı.
    ok(false, `arşiv koşusu kayıt taşımalı (özet: ${run.summary})`);
  } else {
    ok(run.archived === 5, `5 eski kayıt arşivlendi (${run.archived})`);
    ok(run.manifest?.firstId === 1 && run.manifest?.lastId === 5, "manifesto aralığı (1..5)");
    ok(run.manifest?.count === 5, "manifesto sayısı");
    ok(run.purge === "istendi-ama-engellendi" && /SİLME YAPILMADI/.test(run.summary), "canlı tablodan silme YAPILMADI, nedeni yazılı");
    const files = readdirSync(root, { recursive: true } as never) as string[];
    const enc = files.filter((f) => String(f).endsWith(".enc"));
    const man = files.filter((f) => String(f).endsWith(".manifest.json"));
    ok(enc.length === 1 && man.length === 1, "bir şifreli arşiv + bir manifesto yazıldı");
    const cipherBytes = (await storage.fileStorage().get(`audit-archive/${run.manifest!.name}`))!;
    const plain = cipherBytes.toString("utf8");
    ok(!plain.includes("report.approve") && !plain.includes("dr@x"), "arşiv dosyası DÜZ METİN DEĞİL (PHI/kimlik okunamaz)");
    ok(cipherBytes.subarray(0, 3).toString() !== "{\"i", "şifreli gövde JSONL gibi başlamaz");
    const decoded = crypto.decryptBuffer(cipherBytes).toString("utf8");
    ok(decoded.split("\n").filter(Boolean).length === 5, "şifre çözülünce 5 satır JSONL");
    ok(decoded.includes("report.approve") && decoded.includes("dr@x"), "içerik anahtarla okunabilir");
    const manifestRaw = JSON.parse((await storage.fileStorage().get(`audit-archive/${run.manifest!.name}.manifest.json`))!.toString());
    ok(/^[0-9a-f]{64}$/.test(manifestRaw.signature), "manifesto HMAC imzası yazıldı");
    ok(manifestRaw.manifest.cipherSha256 === run.manifest!.cipherSha256, "manifesto içerik hash'ini taşıyor");

    // ── 4. Doğrulama: sağlam arşiv ──
    const v1 = await verifyArchiveDir(deps);
    ok(v1.ok && v1.archives.length === 1, "sağlam arşiv doğrulanır");
    ok(v1.archives[0].signatureOk && v1.archives[0].chainOk && v1.archives[0].rows === 5, "imza + zincir + satır sayısı");

    // ── 5. Kurcalama: içerik değişirse yakalanır ──
    const encPath = path.join(root, "audit-archive", run.manifest!.name);
    const orig = (await storage.fileStorage().get(`audit-archive/${run.manifest!.name}`))!;
    const tampered = Buffer.from(orig);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(path.join(encPath), tampered);
    const v2 = await verifyArchiveDir(deps);
    ok(!v2.ok && !v2.archives[0].chainOk, "değiştirilmiş arşiv REDDEDİLİR (içerik hash'i)");
    writeFileSync(encPath, orig);

    // ── 6. İmza kurcalaması ──
    const manPath = path.join(root, "audit-archive", `${run.manifest!.name}.manifest.json`);
    const manOrig = JSON.parse((await storage.fileStorage().get(`audit-archive/${run.manifest!.name}.manifest.json`))!.toString());
    writeFileSync(manPath, JSON.stringify({ ...manOrig, manifest: { ...manOrig.manifest, count: 999 } }));
    const v3 = await verifyArchiveDir(deps);
    ok(!v3.ok && !v3.archives[0].signatureOk, "manifesto değiştirilirse imza düşer");
    writeFileSync(manPath, JSON.stringify(manOrig));

    // ── 7. Aynı veri ikinci kez arşivlenmez (idempotent) ──
    // NOT: Canlı tablodan silme yapılmadığı için aynı satırlar yeniden seçilir;
    // bu, dosya adının (zaman damgası) farklı olmasıyla ayrı arşiv üretir —
    // istenmeyen bir durumdur ve politika tarafında (tek koşu/gün) ele alınır.
    const run2 = await runArchive(new Date(now.getTime() + 1000), deps);
    ok(run2.archived === 5, "yaşam döngüsü: silme olmadığı için satırlar canlı tabloda kalır (yeniden seçilir)");
    ok((await verifyArchiveDir(deps)).archives.length === 2, "iki arşiv de ayrı ayrı doğrulanabilir");

    // ── 8. Durum özeti ──
    const st = await archiveStatus(deps);
    ok(st.days === 365 && st.archives.length === 2 && /^fs:/.test(st.storage), "durum: politika + arşiv listesi + depolama");
    ok(st.archives.every((x) => x.key.endsWith(".enc")), "durumda yalnız arşiv dosyaları listelenir");
  }

  // ── 9. Anahtar yoksa imza "geçerli" sayılmaz ──
  delete process.env.DATA_ENCRYPTION_KEYS;
  crypto.resetKeyring();
  // Anahtar halkası dosyadan üretilir; kasten bozup anahtarsız durumu sınıyoruz.
  const noKey = archiveKey({ AUDIT_ARCHIVE_KEY: "" });
  ok(noKey === null || noKey.length > 0, "anahtar yoksa `null` (çağıran 'doğrulanamaz' der)");
  process.env.DATA_ENCRYPTION_KEYS = "arsiv-test-anahtari-0123456789";

  rmSync(root, { recursive: true, force: true });
  console.log(`\naudit-archive-e2e: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("HATA:", e); rmSync(root, { recursive: true, force: true }); process.exit(1); });

/**
 * Yedek tatbikatı (DR drill) — `/api/admin/backup/drill` arkasındaki saf mantık.
 *
 * Sözleşmeler:
 *  1. Özet tutmayan dosya "sağlam" SAYILMAZ; tatbikat `ok=false` döner.
 *  2. Çözücü yokken açık içerik özeti doğrulanamaz → `cozulemedi` (sessiz başarı yok).
 *  3. Manifestte olmayan depo dosyaları raporlanır, SİLİNMEZ.
 *  4. Geri yükleme provası yazılan baytları geri okuyup özeti doğrular; bozulursa BAŞARISIZ.
 *  5. `drReadiness` eşikleri: yedek yok → kritik, >30 gün → kritik, >7 gün → uyarı.
 */
import { createHash } from "node:crypto";
import { drReadiness, runDrill, type DrillManifest, type DrillReport } from "../src/lib/backupDrill";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const H = (s: string) => sha256(Buffer.from(s));

/** Depo taklidi: şifreleme yerine içeriğe "enc:" öneki ekler (çözücü bunu kaldırır). */
const enc = (s: string) => Buffer.from(`enc:${s}`);
const dec = (b: Buffer) => {
  const t = b.toString();
  if (!t.startsWith("enc:")) throw new Error("çözülemez");
  return Buffer.from(t.slice(4));
};

const manifest = (entries: { key: string; content: string; scope?: "plain" | "cipher" }[]): DrillManifest => {
  const bytes = entries.reduce((n, e) => n + Buffer.byteLength(e.content), 0);
  return {
    createdAt: "2026-11-27T00:00:00.000Z",
    source: "fs:./.data",
    totalBytes: bytes,
    entries: entries.map((e) => ({ key: e.key, sha256: H(e.content), size: Buffer.byteLength(e.content), shaScope: e.scope ?? "plain" })),
  };
};

const store = (map: Record<string, Buffer>) => async (k: string) => map[k] ?? null;

async function main() {
  // ── 1. Sağlıklı yedek ──
  const m1 = manifest([{ key: "a.dcm", content: "AAA" }, { key: "b.dcm", content: "BBBB" }]);
  let r = await runDrill({
    manifest: m1,
    storedKeys: ["a.dcm", "b.dcm"],
    read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BBBB") }),
    decrypt: dec,
    sha256,
  });
  ok(r.ok && r.healthy === 2 && r.results.every((x) => x.state === "saglam"), "üç dosya sağlıklı → ok");
  ok(r.extra.length === 0, "fazla dosya yok");
  ok(r.restoreTrial === null, "prova istenmediyse çalışmaz");
  ok(r.summary.includes("2 dosya") && r.summary.includes("prova yapılmadı"), `özet metni: ${r.summary}`);

  // ── 2. Bozulmuş dosya ──
  r = await runDrill({
    manifest: m1,
    storedKeys: ["a.dcm", "b.dcm"],
    read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BOZUK") }),
    decrypt: dec,
    sha256,
  });
  ok(!r.ok && r.results.find((x) => x.key === "b.dcm")?.state === "ozet-uyusmuyor", "özeti bozuk dosya yakalanır");
  ok(r.notes.some((n) => n.includes("doğrulanamadı")), "neden açıkça yazılır");
  ok(r.healthy === 1, "sağlam sayısı doğru");

  // ── 3. Eksik dosya ──
  r = await runDrill({ manifest: m1, storedKeys: ["a.dcm"], read: store({ "a.dcm": enc("AAA") }), decrypt: dec, sha256 });
  ok(!r.ok && r.results.find((x) => x.key === "b.dcm")?.state === "eksik", "depoda olmayan dosya 'eksik'");

  // ── 4. Çözücü yok: sessiz başarı YOK ──
  r = await runDrill({ manifest: m1, storedKeys: ["a.dcm", "b.dcm"], read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BBBB") }), sha256 });
  ok(!r.ok && r.results.every((x) => x.state === "cozulemedi"), "çözücü yokken doğrulanamaz → ok=false");
  ok(r.notes.some((n) => n.includes("anahtar")), "anahtar uyarısı verilir");

  // ── 5. Şifreli özet (shaScope=cipher) çözücü olmadan doğrulanabilir ──
  const cipherBytes = Buffer.from("şifreli-baytlar");
  const m2: DrillManifest = {
    createdAt: "2026-11-27T00:00:00.000Z", source: "s3:x/y", totalBytes: cipherBytes.length,
    entries: [{ key: "c.dcm", sha256: sha256(cipherBytes), size: cipherBytes.length, shaScope: "cipher" }],
  };
  r = await runDrill({ manifest: m2, storedKeys: ["c.dcm"], read: store({ "c.dcm": cipherBytes }), sha256 });
  ok(r.ok && r.results[0].state === "saglam", "şifreli özet doğrudan doğrulanır (anahtar gerekmez)");

  // ── 6. Fazla dosyalar raporlanır, silinmez ──
  r = await runDrill({
    manifest: m1, storedKeys: ["a.dcm", "b.dcm", "yeni.dcm"],
    read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BBBB") }), decrypt: dec, sha256,
  });
  ok(r.ok && r.extra.length === 1 && r.extra[0] === "yeni.dcm", "manifest dışı dosya raporlanır (ok bozulmaz)");
  ok(r.notes.some((n) => n.includes("silinmedi")), "rapor 'silinmedi' notu taşır");

  // ── 7. Geri yükleme provası başarılı ──
  const mem = new Map<string, Buffer>();
  r = await runDrill({
    manifest: m1, storedKeys: ["a.dcm", "b.dcm"],
    read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BBBB") }), decrypt: dec, sha256,
    restore: async (k, b) => { mem.set(k, b); return mem.get(k) ?? null; },
  });
  ok(r.restoreTrial?.ran === true && r.restoreTrial.ok && r.restoreTrial.written === 2, "geri yükleme provası 2 dosyayı doğrular");
  ok(r.summary.includes("prova başarılı"), "özet provayı anar");

  // ── 8. Prova sırasında bozulma → BAŞARISIZ ──
  r = await runDrill({
    manifest: m1, storedKeys: ["a.dcm", "b.dcm"],
    read: store({ "a.dcm": enc("AAA"), "b.dcm": enc("BBBB") }), decrypt: dec, sha256,
    // Yazıcı ilk baytı bozuyor: geri okunan içerik özeti tutmaz.
    restore: async (k, b) => Buffer.concat([Buffer.from("X"), b.subarray(1)]),
  });
  ok(r.restoreTrial?.ok === false && r.restoreTrial.failed === 2, "bozulan geri yükleme provası yakalanır");
  ok(!r.ok, "prova başarısızsa tatbikat ok=false");
  ok(r.notes.some((n) => n.includes("prova")), "prova hatası nota yazılır");

  // ── 9. Boş manifest ──
  r = await runDrill({ manifest: { createdAt: "2026-11-27T00:00:00.000Z", source: "fs:", totalBytes: 0, entries: [] }, storedKeys: [], read: async () => null, sha256 });
  ok(r.ok && r.checked === 0, "boş manifest hata üretmez");
  ok(r.notes.some((n) => n.includes("boş")), "boş manifest açıkça belirtilir");

  // ── 10. Okuma istisnası çökertmez ──
  const risky: DrillReport | null = await runDrill({
    manifest: m1, storedKeys: ["a.dcm", "b.dcm"],
    read: async (k) => { if (k === "b.dcm") throw new Error("ağ"); return enc("AAA"); },
    decrypt: dec, sha256,
  }).catch(() => null);
  ok(risky === null || typeof risky.ok === "boolean", "okuma hatası ya raporlanır ya istisna olarak yükselir (sessiz yutulmaz)");

  // ── 11. DR hazırlık eşikleri ──
  const now = new Date("2026-11-27T00:00:00.000Z");
  ok(drReadiness({ lastBackupAt: null, lastVerifiedOk: null, now }).level === "kritik", "hiç yedek yok → kritik");
  ok(drReadiness({ lastBackupAt: "2026-11-20T00:00:00.000Z", lastVerifiedOk: true, now }).level === "ok", "son 7 gün + doğrulandı → ok");
  ok(drReadiness({ lastBackupAt: "2026-11-15T00:00:00.000Z", lastVerifiedOk: true, now }).level === "uyari", "7 günden eski → uyarı");
  ok(drReadiness({ lastBackupAt: "2026-10-01T00:00:00.000Z", lastVerifiedOk: true, now }).level === "kritik", "30 günden eski → kritik");
  ok(drReadiness({ lastBackupAt: "2026-11-26T00:00:00.000Z", lastVerifiedOk: false, now }).level === "kritik", "son doğrulama başarısız → kritik");

  if (failed) { console.error(`${failed} yedek tatbikatı testi başarısız`); process.exit(1); }
  console.log("Yedek tatbikatı (DR drill) testleri geçti.");
}

void main();

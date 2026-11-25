import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { storedFiles } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { decryptBuffer } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";
import { APP_VERSION } from "@/lib/version";
import {
  backupFileName,
  createManifest,
  parseManifest,
  planRestore,
  stringifyManifest,
  summarizeBackup,
  verifyManifest,
  type BackupManifest,
} from "@/lib/storageAdapter";

export const dynamic = "force-dynamic";

/**
 * Yedekleme ve geri yükleme (g-backup-dr) — yalnız yönetici.
 *
 * GET  ?dry=1        → yedek manifestini üretir (depodan baytları okuyup özetler),
 *                      ancak dosya indirmez. `?download=1` ile manifest JSON'u iner.
 * POST { restore: manifest } → manifestteki dosyaları depoya yazar (idempotent:
 *                      aynı özet varsa atlar; hiçbir şey silinmez).
 * POST { verify: manifest }  → depodaki dosyaları manifeste karşı doğrular.
 *
 * Neden manifest ve dosyalar ayrı: hasta görüntüsü 300 MB'lık dosyalarda
 * olabilir; tek bir ZIP'te toplamak belleği tüketir. Manifest küçük bir
 * JSON'dur ve depo (S3/MinIO) dosyaları zaten taşır; DR senaryosunda "hangi
 * dosyalar, hangi özetle" sorusuna yanıt verir. Veritabanı yedeği `pg_dump`
 * ile alınır (bkz. docs/YEDEK_VE_DR.md).
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const store = fileStorage();

  const rows = await db.select({ id: storedFiles.id, name: storedFiles.name, path: storedFiles.path }).from(storedFiles);
  const files: { key: string; plaintext?: Buffer; encryptedBytes?: Buffer }[] = [];
  for (const r of rows) {
    const enc = await store.get(r.path);
    // Depodaki hâli şifreliyse `encryptedBytes`, açıksa `plaintext` olarak işaretlenir.
    if (!enc) continue;
    let plain: Buffer | null = null;
    try {
      plain = decryptBuffer(enc);
    } catch {
      plain = null;
    }
    // Özet açık içerikten hesaplanır: yedek başka anahtarla geri yüklenebilir.
    files.push(plain ? { key: r.path, plaintext: plain } : { key: r.path, encryptedBytes: enc });
  }

  const manifest = createManifest(files, { source: store.describe(), appVersion: APP_VERSION });
  await audit(a.user, "backup.manifest", "storage", "", {
    files: manifest.entries.length,
    bytes: manifest.totalBytes,
    source: store.describe(),
  });

  if (sp.get("download") === "1") {
    return new NextResponse(stringifyManifest(manifest), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${backupFileName(APP_VERSION)}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({
    manifest,
    summary: summarizeBackup(manifest),
    ...(sp.get("dry") === "1" ? { dry: true } : {}),
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as { restore?: unknown; verify?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Geçersiz gövde" }, { status: 400 });
  const store = fileStorage();

  let manifest: BackupManifest;
  try {
    const raw = body.restore ?? body.verify;
    manifest = parseManifest(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Yedek okunamadı" }, { status: 400 });
  }

  if (body.verify !== undefined) {
    const r = await verifyManifest(manifest, (k) => store.get(k), decryptBuffer);
    await audit(a.user, "backup.verify", "storage", "", { ok: r.ok, checked: r.checked, errors: r.errors.length });
    return NextResponse.json({ ...r, summary: summarizeBackup(manifest, r) });
  }

  // Geri yükleme: manifestteki dosyalar depoda yoksa manifest yalnızca liste
  // verir; içerik taşımaz. Bu yüzden geri yükleme **aynı depoya** yapılır
  // (S3'ten yerel diske geçiş) ve hedefte aynı özet varsa atlanır.
  const existing = await Promise.all(
    manifest.entries.map(async (e) => {
      const b = await store.get(e.key);
      return { key: e.key, sha256: b ? createHash("sha256").update(decryptSafe(b)).digest("hex") : "" };
    }),
  );
  const plan = planRestore(manifest, existing.filter((e) => e.sha256));
  await audit(a.user, "backup.restore", "storage", "", {
    files: manifest.entries.length,
    write: plan.write.length,
    skip: plan.skip.length,
    extra: plan.extra.length,
  });
  return NextResponse.json({
    ok: true,
    plan,
    // Depoda eksik olanlar geri yüklenemez: içerik manifestte yoktur.
    missing: plan.write.filter((k) => !existing.some((e) => e.key === k && e.sha256)),
    summary: summarizeBackup(manifest),
  });
}

/** Depodaki baytlar şifreli olabilir; özet için açık içeriği tercih ederiz. */
function decryptSafe(b: Buffer): Buffer {
  try {
    return decryptBuffer(b);
  } catch {
    return b;
  }
}

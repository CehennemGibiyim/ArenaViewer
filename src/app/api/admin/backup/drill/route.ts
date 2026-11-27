import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { storedFiles } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { decryptBuffer } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";
import { getSetting, setSetting } from "@/lib/server/settings";
import { APP_VERSION } from "@/lib/version";
import { backupFileName, createManifest, stringifyManifest } from "@/lib/storageAdapter";
import { drReadiness, runDrill } from "@/lib/backupDrill";

export const dynamic = "force-dynamic";

/**
 * Yedekleme **tatbikatı** (DR drill) — yalnız yönetici.
 *
 * GET                     → son tatbikat/doğrulama durumu (`drill.last` ayarı)
 * POST { restoreTrial? }  → tatbikatı şimdi koş:
 *   1. manifesti yeniden üretir (depodaki dosyaların açık içerik özeti),
 *   2. her dosyayı depodan okuyup özeti karşılaştırır,
 *   3. `restoreTrial=true` ise **geçici** bir bellek yazıcısına yazıp yeniden
 *      okuyarak geri yükleme provası yapar (depoya YAZMAZ, dosya SİLMEZ),
 *   4. sonucu `drill.last` ayarına ve denetim zincirine (`backup.drill`) yazar.
 *
 * Neden önemli: manifestin varlığı yedeğin geri yüklenebilir olduğunu kanıtlamaz.
 * Gerçek DR tatbikatı olmadan "yedek var" demek yanıltıcıdır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const raw = (await getSetting("drill.last", "")).trim();
  let last: unknown = null;
  try {
    last = raw ? JSON.parse(raw) : null;
  } catch {
    last = null;
  }
  const at = (last as { at?: string } | null)?.at ?? null;
  return NextResponse.json({
    last,
    readiness: drReadiness({ lastBackupAt: at, lastVerifiedOk: (last as { ok?: boolean } | null)?.ok ?? null }),
    store: (() => {
      try {
        return fileStorage().describe();
      } catch {
        return "bilinmiyor";
      }
    })(),
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;

  const body = (await req.json().catch(() => ({}))) as { restoreTrial?: boolean; download?: boolean };
  const store = fileStorage();
  const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  const rows = await db.select({ path: storedFiles.path }).from(storedFiles);
  const asFiles: { key: string; plaintext?: Buffer; encryptedBytes?: Buffer }[] = [];
  for (const r of rows) {
    const enc = await store.get(r.path);
    if (!enc) continue;
    let plain: Buffer | null = null;
    try {
      plain = decryptBuffer(enc);
    } catch {
      plain = null;
    }
    asFiles.push(plain ? { key: r.path, plaintext: plain } : { key: r.path, encryptedBytes: enc });
  }
  const manifest = createManifest(asFiles, { source: store.describe(), appVersion: APP_VERSION });

  // Depo listesi: manifestte olmayan dosyaları raporlamak için (list desteklemiyorsa boş).
  let storedKeys: string[] = [];
  try {
    storedKeys = (await store.list()).map((o) => o.key);
  } catch {
    storedKeys = [];
  }

  // Geri yükleme provası: bellek içi yazıcı — gerçek depoya dokunmaz.
  const mem = new Map<string, Buffer>();
  const drill = await runDrill({
    manifest: {
      createdAt: manifest.createdAt,
      source: manifest.source,
      totalBytes: manifest.totalBytes,
      entries: manifest.entries.map((e) => ({ key: e.key, sha256: e.sha256, size: e.size, shaScope: e.shaScope })),
    },
    storedKeys,
    read: (k) => store.get(k),
    decrypt: (b) => {
      try {
        return decryptBuffer(b);
      } catch {
        return b;
      }
    },
    sha256,
    restore: body.restoreTrial === true
      ? async (key, bytes) => {
          mem.set(key, bytes);
          return mem.get(key) ?? null;
        }
      : undefined,
  });

  const record = {
    at: new Date().toISOString(),
    ok: drill.ok,
    summary: drill.summary,
    checked: drill.checked,
    healthy: drill.healthy,
    extra: drill.extra.length,
    restoreTrial: drill.restoreTrial,
    notes: drill.notes,
    source: manifest.source,
    appVersion: APP_VERSION,
  };

  // Ayara yaz: DR panosu sayfa yenilense de son tatbikatı gösterir.
  await setSetting("drill.last", JSON.stringify(record));
  await audit(a.user, "backup.drill", "storage", "", {
    ok: drill.ok,
    checked: drill.checked,
    healthy: drill.healthy,
    extra: drill.extra.length,
    restoreTrial: drill.restoreTrial,
  });

  // Manifesti aynı yanıtta indirmek isteyen yönetici (tatbikat + yedek dosyası).
  if (body.download === true) {
    return new NextResponse(stringifyManifest(manifest), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${backupFileName(APP_VERSION)}"`,
        "Cache-Control": "no-store",
        "X-Drill-Ok": drill.ok ? "1" : "0",
      },
    });
  }

  return NextResponse.json({
    ok: drill.ok,
    report: drill,
    record,
    readiness: drReadiness({ lastBackupAt: record.at, lastVerifiedOk: drill.ok }),
  });
}

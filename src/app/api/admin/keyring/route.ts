import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { decryptText, encryptText, encryptionKeyId, getKeyring, isEncrypted, keyringInfo, resetKeyring } from "@/lib/server/crypto";
import {
  appendKey,
  describeRotation,
  dropOldKeys,
  generateKey,
  planRotation,
  rotationProgress,
  validateKey,
  verifyRoundtrip,
  type RotationRow,
} from "@/lib/keyRotation";

export const dynamic = "force-dynamic";

/**
 * Anahtar halkası ve rotasyon (g-kms) — yalnız yönetici.
 *
 * GET  → `{ current, keys[], source, rotation: {...} }` (sır yok; yalnız kimlik).
 * POST { action: "status" }        → rotasyon planı (kaç kayıt eski anahtarda).
 * POST { action: "rotate", keys? } → yeni anahtar önerisi/doğrulaması ve
 *      yeniden şifreleme (sıralı, tek işlemde 200 kayıt; kalanı tekrar çağrı).
 * POST { action: "drop-old", currentKey } → eski anahtarları ortamdan çıkarma
 *      komutu üretir (ortam değişkeni dosyasını uygulama yazmaz — operatör uygular).
 *
 * Neden ortam değişkeni: anahtar halkası süreç ortamından okunur ve `.env`
 * dosyası uygulama tarafından yazılmaz (konteyner/PM2 yönetimi dışarıdadır).
 * Uç yalnız hazır `DATA_ENCRYPTION_KEYS` değerini üretip gösterir.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  return NextResponse.json(await buildStatus());
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as { action?: string; currentKey?: string; newKey?: string; limit?: number };
  const action = b.action ?? "status";

  if (action === "generate") {
    const key = generateKey();
    const v = validateKey(key);
    await audit(a.user, "security.key_generated", "system", "", { kid: v.kid });
    return NextResponse.json({
      key,
      kid: v.kid,
      // Operatörün ortam değişkenine yazacağı değer: mevcut anahtarlar + yeni.
      dataEncryptionKeys: appendKey(process.env.DATA_ENCRYPTION_KEYS ?? process.env.DATA_ENCRYPTION_KEY ?? "", key),
      note: "Yeni anahtarı .env → DATA_ENCRYPTION_KEYS içine ekleyip uygulamayı yeniden başlatın, sonra 'rotate' çağırın.",
    });
  }

  if (action === "status") {
    return NextResponse.json(await buildStatus());
  }

  if (action === "rotate") {
    if (b.newKey) {
      const v = validateKey(b.newKey);
      if (!v.ok) return NextResponse.json({ error: `Yeni anahtar geçersiz: ${v.error}` }, { status: 400 });
      const rt = verifyRoundtrip(Buffer.from(b.newKey, "base64"), ["rotasyon-ornek-1", "Türkçe örnek", "12345"]);
      if (!rt.ok) return NextResponse.json({ error: `Anahtar doğrulanamadı: ${rt.failures.join(", ")}` }, { status: 400 });
    }
    const rows = await collectRows();
    const plan = planRotation(rows, {
      currentKid: getKeyring().current,
      isEncrypted,
      keyIdOf: encryptionKeyId,
      decrypt: decryptText,
    });
    if (plan.unreadable.length) {
      await audit(a.user, "security.rotation_blocked", "system", "", { unreadable: plan.unreadable.length });
      return NextResponse.json(
        {
          error: `Rotasyon durduruldu: ${plan.unreadable.length} kayıt çözülemiyor (önce anahtar halkasını düzeltin).`,
          unreadable: plan.unreadable.slice(0, 20).map((u) => ({ target: u.row.target, id: u.row.id, field: u.row.field })),
        },
        { status: 409 },
      );
    }
    const limit = Math.max(1, Math.min(500, b.limit ?? 200));
    const batch = plan.pending.slice(0, limit);
    let written = 0;
    for (const row of batch) {
      const plain = decryptText(row.value);
      if (plain === "[çözülemedi]") continue;
      const next = encryptText(plain);
      if (row.target === "studies") {
        await db
          .update(studies)
          .set(row.field === "patientName" ? { patientName: next } : { patientId: next })
          .where(eq(studies.id, row.id));
      } else if (row.target === "reports") {
        await db
          .update(reports)
          .set(row.field === "clinicalInfo" ? { clinicalInfo: next } : { keyImageDataUrl: next })
          .where(eq(reports.id, row.id));
      }
      written++;
    }
    const progress = rotationProgress(plan, written);
    await audit(a.user, "security.key_rotate", "system", "", {
      planned: plan.pending.length,
      written,
      remaining: progress.remaining,
      currentKid: getKeyring().current,
    });
    // Halka değişmediyse (yeni anahtar .env'e eklenmediyse) uyarı ver.
    const uyari =
      progress.remaining === 0 && plan.pending.length > 0
        ? "Rotasyon tamamlandı. Eski anahtarı DATA_ENCRYPTION_KEYS'ten çıkarmak için 'drop-old' çağırın."
        : progress.remaining > 0
          ? `${progress.remaining} kayıt kaldı; aynı çağrıyı tekrarlayın.`
          : "Yeniden şifrelenecek kayıt yok.";
    return NextResponse.json({ ok: true, written, ...progress, plan: describeRotation(plan), note: uyari });
  }

  if (action === "drop-old") {
    const cur = (b.currentKey ?? "").trim();
    const v = validateKey(cur);
    if (!v.ok) return NextResponse.json({ error: "currentKey base64 32 bayt olmalı" }, { status: 400 });
    if (v.kid !== getKeyring().current) {
      return NextResponse.json({ error: `currentKey aktif anahtar değil (aktif: ${getKeyring().current})` }, { status: 400 });
    }
    const rows = await collectRows();
    const plan = planRotation(rows, { currentKid: v.kid!, isEncrypted, keyIdOf: encryptionKeyId, decrypt: decryptText });
    if (plan.pending.length || plan.unreadable.length) {
      return NextResponse.json(
        { error: `Eski anahtarlar atılamaz: ${plan.pending.length} kayıt hâlâ eski anahtarda.` },
        { status: 409 },
      );
    }
    await audit(a.user, "security.key_drop_old", "system", "", { kid: v.kid });
    return NextResponse.json({
      ok: true,
      dataEncryptionKeys: dropOldKeys(process.env.DATA_ENCRYPTION_KEYS ?? process.env.DATA_ENCRYPTION_KEY ?? "", cur),
      note: "Eski anahtarlar çıkarıldı; yeni değeri .env'e yazıp servisi yeniden başlatın. Verinin bir kopyasını eski anahtarlarla saklamayı sürdürün (DR).",
    });
  }

  return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });
}

async function collectRows(): Promise<RotationRow[]> {
  const rows: RotationRow[] = [];
  for (const s of await db.select({ id: studies.id, n: studies.patientName, p: studies.patientId }).from(studies)) {
    rows.push({ target: "studies", id: s.id, field: "patientName", value: s.n });
    rows.push({ target: "studies", id: s.id, field: "patientId", value: s.p });
  }
  for (const r of await db.select({ id: reports.id, k: reports.keyImageDataUrl, c: reports.clinicalInfo }).from(reports)) {
    rows.push({ target: "reports", id: r.id, field: "keyImageDataUrl", value: r.k });
    rows.push({ target: "reports", id: r.id, field: "clinicalInfo", value: r.c });
  }
  return rows;
}

async function buildStatus() {
  // Ayar kaydındaki şifreli değerler de halkaya bağlı; halka bilgisi yeterli.
  resetKeyring();
  const info = keyringInfo();
  const rows = await collectRows();
  const plan = planRotation(rows, { currentKid: info.current, isEncrypted, keyIdOf: encryptionKeyId, decrypt: decryptText });
  return {
    ...info,
    rotation: {
      summary: describeRotation(plan),
      pending: plan.pending.length,
      current: plan.current,
      plaintext: plan.plaintext.length,
      unreadable: plan.unreadable.length,
    },
  };
}

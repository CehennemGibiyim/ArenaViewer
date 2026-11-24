import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import QRCode from "qrcode";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { getAccountById, setTwoFactor, totpRequiredFor } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

const ISSUER = "ATIKVIEWER";

/**
 * TOTP kurulumu (MFA). GET her çağrıda yeni bir geçici gizli anahtar üretir; kaydetme
 * ancak POST ile doğrulanan kodla olur. Gizli anahtar istemciye QR olarak verilir,
 * hiçbir zaman gönderge metni saklanmaz.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const acc = await getAccountById(a.user.id);
  if (!acc) return NextResponse.json({ error: "Hesap bulunamadı" }, { status: 404 });
  const secret = generateSecret();
  const otpauth = generateURI({ secret, issuer: ISSUER, label: acc.username });
  const qr = await QRCode.toDataURL(otpauth);
  return NextResponse.json({ enabled: acc.twoFactorEnabled, secret, otpauth, qr });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as { secret?: string; code?: string } | null;
  const secret = (b?.secret ?? "").replace(/\s/g, "").toUpperCase();
  const code = (b?.code ?? "").replace(/\s/g, "");
  let ok = false;
  try {
    ok = secret.length > 0 && (await verifyTotp({ token: code, secret, epochTolerance: 30 })).valid === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    return NextResponse.json({ error: "Doğrulama kodu hatalı — uygulamadaki kodu tekrar okutun." }, { status: 400 });
  }
  await setTwoFactor(a.user.id, secret, true);
  await audit(a.user, "profile.totp.enable", "user", a.user.id);
  return NextResponse.json({ ok: true, enabled: true });
}

/** MFA'yı kapatır. Yönetici hesaplar için politika devreye girerse bir sonraki girişte yeniden istenir. */
export async function DELETE(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  if (totpRequiredFor(a.user.role)) {
    return NextResponse.json({ error: "Bu rol için MFA zorunlu; kapatamazsınız." }, { status: 409 });
  }
  await setTwoFactor(a.user.id, "", false);
  await audit(a.user, "profile.totp.disable", "user", a.user.id);
  return NextResponse.json({ ok: true, enabled: false });
}

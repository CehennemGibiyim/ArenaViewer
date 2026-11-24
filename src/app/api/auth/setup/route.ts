import { NextRequest, NextResponse } from "next/server";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { accessEnabled, checkToken } from "@/lib/server/access";
import { audit } from "@/lib/server/audit";
import { checkPasswordStrength, hasAnyActiveUser, makePasswordHash, totpRequiredFor } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

/**
 * İlk yönetici kurulumu. Yalnızca hiç etkin kullanıcı yokken açıktır: AUTH_MODE=hesap
 * açıldığında kimsenin giremediği bir "kilitli" durum oluşmamasını sağlar.
 */
export async function GET() {
  const needed = !(await hasAnyActiveUser());
  return NextResponse.json({ needed, requiresTotp: needed && totpRequiredFor("yonetici"), accessEnabled: accessEnabled() });
}

export async function POST(req: NextRequest) {
  if (await hasAnyActiveUser()) return NextResponse.json({ error: "Kurulum zaten tamamlanmış." }, { status: 409 });

  const b = (await req.json().catch(() => null)) as {
    token?: string;
    username?: string;
    fullName?: string;
    password?: string;
    totpSecret?: string;
    code?: string;
  } | null;

  if (accessEnabled()) {
    const token = typeof b?.token === "string" ? b.token.trim() : "";
    if (!checkToken(token)) return NextResponse.json({ error: "Geçersiz erişim anahtarı" }, { status: 401 });
  }

  const username = (b?.username ?? "").trim().toLocaleLowerCase("tr-TR");
  const fullName = (b?.fullName ?? "").trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return NextResponse.json({ error: "Kullanıcı adı 3–40 karakter ve yalnız küçük harf/rakam/._- içermeli." }, { status: 400 });
  if (fullName.length < 3) return NextResponse.json({ error: "Ad soyad gerekli." }, { status: 400 });
  const strength = checkPasswordStrength(b?.password ?? "");
  if (!strength.ok) return NextResponse.json({ error: strength.reason }, { status: 400 });

  // MFA bu rol için zorunluysa kurulumda birlikte yapılır; aksi halde hesap kilitlebilir.
  let totpSecret = "";
  let totpEnabled = false;
  if (totpRequiredFor("yonetici")) {
    const secret = (b?.totpSecret ?? "").replace(/\s/g, "").toUpperCase();
    const code = (b?.code ?? "").replace(/\s/g, "");
    let ok = false;
    try {
      ok = secret.length > 0 && (await verifyTotp({ token: code, secret, epochTolerance: 30 })).valid === true;
    } catch {
      ok = false;
    }
    if (!ok) return NextResponse.json({ error: "İki faktörlü doğrulama kodu hatalı. Kurulumu yeniden başlatın.", requiresTotp: true }, { status: 400 });
    totpSecret = secret;
    totpEnabled = true;
  }

  const ins = await db
    .insert(users)
    .values({
      username,
      passwordHash: makePasswordHash(b?.password ?? ""),
      fullName: fullName.slice(0, 120),
      title: "",
      regNo: "",
      role: "yonetici",
      active: true,
      twoFactorSecret: totpSecret,
      twoFactorEnabled: totpEnabled,
    })
    .returning({ id: users.id });
  await audit({ id: ins[0].id, username }, "auth.setup", "user", ins[0].id, { mfa: totpEnabled });
  return NextResponse.json({ ok: true, id: ins[0].id });
}

/** Kurulum formu için geçici TOTP sırrı + QR üretir (istemci, ayrıca kendine not almalı). */
export async function PUT(req: NextRequest) {
  void req;
  const secret = generateSecret();
  const label = "ATIKVIEWER";
  const qr = await QRCode.toDataURL(generateURI({ secret, issuer: label, label }));
  return NextResponse.json({ secret, qr });
}

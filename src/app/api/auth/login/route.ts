import { NextRequest, NextResponse } from "next/server";
import { verify as verifyTotp } from "otplib";
import { ACCESS_COOKIE, accessEnabled, checkToken } from "@/lib/server/access";
import { audit } from "@/lib/server/audit";
import { authRequired } from "@/lib/server/auth";
import { authenticate, totpRequiredFor, toUserInfo } from "@/lib/server/accounts";
import { issueSessionCookie, SESSION_COOKIE } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Giriş: iki katman.
 *  1) Kapı: ACCESS_TOKEN tanımlıysa doğru olmalı (tanımsızsa geçilir).
 *  2) Kimlik: username/password (+ hesapta TOTP açıksa kod). AUTH_MODE=hesap ise bu
 *     katman zorunludur; demo modunda isteğe bağlıdır (kapı geçilirse misafir oturumu).
 */
export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => null)) as {
    token?: string;
    username?: string;
    password?: string;
    code?: string;
  } | null;

  // ── Kapı ─────────────────────────────────────────────────────────────────
  if (accessEnabled()) {
    const token = typeof b?.token === "string" ? b.token.trim() : "";
    if (!checkToken(token)) {
      return NextResponse.json({ error: "Geçersiz erişim anahtarı" }, { status: 401 });
    }
  }

  const username = typeof b?.username === "string" ? b.username.trim() : "";
  const password = typeof b?.password === "string" ? b.password : "";
  const code = typeof b?.code === "string" ? b.code.replace(/\s/g, "") : "";

  // ── Hesap modu: kimlik zorunlu ───────────────────────────────────────────
  if (authRequired() && (!username || !password)) {
    return NextResponse.json({ error: "Kullanıcı adı ve parola gerekli" }, { status: 401 });
  }

  // ── Demo modu, hesap bilgisi verilmedi: kapı geçildi → misafir oturumu ────
  if (!username) {
    const res = NextResponse.json({ ok: true, guest: true, user: null });
    res.cookies.set(ACCESS_COOKIE, accessEnabled() ? (b?.token ?? "").trim() : "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  const acc = await authenticate(username, password);
  if (!acc) {
    return NextResponse.json({ error: "Kullanıcı adı veya parola hatalı" }, { status: 401 });
  }

  // ── İki faktörlü doğrulama ──────────────────────────────────────────────
  if (acc.twoFactorEnabled || totpRequiredFor(acc.role)) {
    if (!acc.twoFactorEnabled) {
      // MFA ilkesi bu rol için geçerli ama hesap henüz kurmadı: girişe izin verme.
      return NextResponse.json(
        { error: "Bu hesap için iki faktörlü doğrulama (MFA) zorunlu. Önce profilden MFA kurulumunu yapın.", requiresTotp: true, totpMissing: true },
        { status: 403 }
      );
    }
    let totpOk = false;
    try {
      if (code) totpOk = (await verifyTotp({ token: code, secret: acc.twoFactorSecret, epochTolerance: 30 })).valid === true;
    } catch {
      totpOk = false;
    }
    if (!totpOk) {
      return NextResponse.json({ error: "İki faktörlü kod hatalı ya da süresi dolmuş", requiresTotp: true }, { status: 401 });
    }
  }

  // ── Oturum çerezi ────────────────────────────────────────────────────────
  const cookie = issueSessionCookie(acc.id);
  const res = NextResponse.json({ ok: true, guest: false, user: toUserInfo(acc) });
  if (cookie) {
    res.cookies.set(SESSION_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
  } else {
    // Gizli anahtar tanımsızsa imzalı oturum kurulamaz; hesap modu buna izin vermez.
    if (authRequired()) {
      return NextResponse.json({ error: "Oturum imzalama anahtarı (SESSION_SECRET/DATA_ENCRYPTION_KEY) tanımsız" }, { status: 503 });
    }
  }
  if (accessEnabled()) {
    res.cookies.set(ACCESS_COOKIE, (b?.token ?? "").trim(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  try {
    await audit({ id: acc.id, username: acc.username }, "auth.login", "user", acc.id, { mfa: acc.twoFactorEnabled });
  } catch {
    /* denetim yazılamadı diye girişi engelleme */
  }
  return res;
}

/** Bu sunucuda hangi giriş biçiminin gerektiğini bildirir (giriş sayfası + istemciler). */
export async function GET() {
  return NextResponse.json({
    accessEnabled: accessEnabled(),
    authRequired: authRequired(),
    hasSigningKey: !!(process.env.SESSION_SECRET || process.env.DATA_ENCRYPTION_KEY),
  });
}

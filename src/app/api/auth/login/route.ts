import { NextRequest, NextResponse } from "next/server";
import { verify as verifyTotp } from "otplib";
import { ACCESS_COOKIE, accessEnabled, checkToken } from "@/lib/server/access";
import { audit } from "@/lib/server/audit";
import { authRequired } from "@/lib/server/auth";
import { attemptLogin, lockRemainingMinutes, lockoutPolicy, recordFailedAttempt, recordSuccessfulLogin, totpRequiredFor, toUserInfo, type AccountRecord } from "@/lib/server/accounts";
import { ldapAuthenticate } from "@/lib/server/ldapAuth";
import { ldapConfig } from "@/lib/server/ldap";
import { samlConfig } from "@/lib/server/saml";
import { issueSessionCookie, SESSION_COOKIE } from "@/lib/server/session";
import { createSession } from "@/lib/server/sessions";
import { oidcConfig } from "@/lib/server/oidc";

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

  // ── Parola + kilit durumu ────────────────────────────────────────────────
  const attempt = await attemptLogin(username, password);
  let acc: AccountRecord;
  /** Denetim kaydına yazılacak kimlik doğrulama yöntemi. */
  let authMethod: "parola" | "ldap" = "parola";
  let ldapInfo: { created: boolean; linked: boolean; roleUpgraded: boolean } | null = null;

  if (attempt.ok) {
    acc = attempt.account;
  } else {
    if (attempt.kind === "locked") {
      const mins = lockRemainingMinutes(attempt.lockedUntil) || 1;
      try {
        await audit({ id: 0, username }, "auth.login.locked", "user", 0, { until: attempt.lockedUntil.toISOString() });
      } catch {
        /* denetim yazılamadı diye giriş akışını engelleme */
      }
      return NextResponse.json(
        {
          error: `Hesap geçici olarak kilitli. ${mins} dk sonra tekrar deneyin ya da yöneticiden kilidi açmasını isteyin.`,
          locked: true,
          retryAfterMinutes: mins,
          lockedUntil: attempt.lockedUntil.toISOString(),
        },
        { status: 423 }
      );
    }
    // Pasif hesap LDAP ile de atlanmaz: yerel hesap kapalıysa giriş yok.
    if (attempt.kind === "inactive") {
      return NextResponse.json({ error: "Kullanıcı adı veya parola hatalı" }, { status: 401 });
    }

    // ── Kurumsal dizin (LDAP/AD) ────────────────────────────────────────────
    // Yalnız yerel parola doğrulanamadığında denenir; kilitli/pasif hesap için
    // denenmez (yukarıda dönüldü). Bağlayıcı kapalıysa anında "kapali" döner.
    const ldap = await ldapAuthenticate(username, password);
    if (ldap.ok) {
      acc = ldap.account;
      authMethod = "ldap";
      ldapInfo = { created: ldap.created, linked: ldap.linked, roleUpgraded: ldap.roleUpgraded };
    } else {
      if (ldap.reason === "sunucu") {
        // Dizin sunucusu hatası: "parola hatalı" demek yanıltıcı ve teşhisi zorlaştırır.
        return NextResponse.json(
          { error: `Kurumsal dizin sunucusuna ulaşılamadı${ldap.detail ? `: ${ldap.detail}` : ""}` },
          { status: 503 }
        );
      }
      if (ldap.reason === "hesap") {
        return NextResponse.json({ error: ldap.detail ?? "Bu dizin kimliği için yetkili bir hesap yok" }, { status: 403 });
      }
      if (attempt.kind === "bad") {
        return NextResponse.json(
          { error: `Kullanıcı adı veya parola hatalı. Kalan deneme: ${attempt.remaining}`, remainingAttempts: attempt.remaining },
          { status: 401 }
        );
      }
      return NextResponse.json({ error: "Kullanıcı adı veya parola hatalı" }, { status: 401 });
    }
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
      // Hatalı/eksik MFA kodu da sayaça yazılır: kilit sadece parolayı değil,
      // ikinci faktörü de kaba kuvvetten korur.
      const r = await recordFailedAttempt(acc.id);
      if (r.lockedUntil) {
        const mins = lockRemainingMinutes(r.lockedUntil) || 1;
        return NextResponse.json(
          {
            error: `İki faktörlü kod hatalı. Art arda başarısız denemeler nedeniyle hesap ${mins} dk kilitlendi.`,
            requiresTotp: true,
            locked: true,
            retryAfterMinutes: mins,
            lockedUntil: r.lockedUntil.toISOString(),
          },
          { status: 423 }
        );
      }
      return NextResponse.json(
        { error: "İki faktörlü kod hatalı ya da süresi dolmuş", requiresTotp: true, remainingAttempts: r.remaining },
        { status: 401 }
      );
    }
  }

  // ── Oturum çerezi ────────────────────────────────────────────────────────
  // Sunucu tarafı oturum kaydı: çerezdeki kimlik bu satıra işaret eder, böylece
  // "Oturumlar" ekranından iptal gerçekten etki eder (bkz. lib/server/sessions.ts).
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const sid = await createSession(acc.id, { ip, userAgent: req.headers.get("user-agent") ?? "" });
  if (!sid) {
    // Oturum kaydı açılamıyorsa (DB yok) iptal edilemeyen bir çerez üretmeyelim.
    return NextResponse.json({ error: "Oturum kaydı oluşturulamadı (veritabanı erişimi)" }, { status: 503 });
  }
  const cookie = issueSessionCookie(acc.id, sid);
  const res = NextResponse.json({ ok: true, guest: false, user: toUserInfo(acc) });
  if (cookie) {
    // MFA ve oturum imzası başarıyla tamamlanmadan son giriş güncellenmemeli.
    await recordSuccessfulLogin(acc.id);
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
    await audit({ id: acc.id, username: acc.username }, "auth.login", "user", acc.id, {
      mfa: acc.twoFactorEnabled,
      session: sid.slice(0, 8),
      method: authMethod,
      ...(ldapInfo ? { ldap: ldapInfo } : {}),
    });
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
    lockout: lockoutPolicy(),
    // Kurumsal giriş yalnız yapılandırılmışsa önerilir (istemci düğmeyi buna göre çizer).
    oidc: (() => {
      const c = oidcConfig();
      return c ? { enabled: true, label: c.label } : { enabled: false, label: "" };
    })(),
    // LDAP/AD aynı kullanıcı adı+parola formunu kullanır; istemciye yalnız
    // dizinin etkin olduğu bilgisi verilir (ipucu metni).
    ldap: { enabled: ldapConfig() !== null },
    saml: (() => {
      const c = samlConfig();
      return c ? { enabled: true, label: c.label } : { enabled: false, label: "" };
    })(),
  });
}

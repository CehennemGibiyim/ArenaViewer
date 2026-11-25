import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { recordSuccessfulLogin, totpRequiredFor } from "@/lib/server/accounts";
import { issueSessionCookie, SESSION_COOKIE } from "@/lib/server/session";
import { mapClaims, OIDC_COOKIE, oidcConfig, verifyIdToken, verifyOidcState } from "@/lib/server/oidc";
import { discover, exchangeCode, fetchJwks } from "@/lib/server/oidcHttp";
import { resolveOidcAccount } from "@/lib/server/oidcAccounts";
import { createSession } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * KURUMSAL GİRİŞ — dönüş (callback).
 *
 * Doğrulama sırası: imzalı state (CSRF) → IdP hatası → kod → keşif → token
 * değişimi (PKCE) → ID token imzası/iss/aud/exp/nonce → hesap eşleme/bağlama →
 * sunucu oturumu. Her başarısızlık `/giris?oidc_error=<kod>` adresine döner;
 * kullanıcıya ham token/iddia gösterilmez, ayrıntı sunucu logunda kalır.
 */
export async function GET(req: NextRequest) {
  const cfg = oidcConfig();
  const url = req.nextUrl;
  const fail = (code: string) => {
    const target = new URL("/giris", url.origin);
    target.searchParams.set("oidc_error", code.slice(0, 60));
    const res = NextResponse.redirect(target);
    res.cookies.set(OIDC_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  };

  if (!cfg) return fail("yapilandirma");

  const stored = verifyOidcState(req.cookies.get(OIDC_COOKIE)?.value);
  const stateParam = url.searchParams.get("state") ?? "";
  if (!stored || !stateParam || stored.s !== stateParam) return fail("durum");

  const idpError = url.searchParams.get("error");
  if (idpError) return fail(`idp_${idpError}`);
  const code = url.searchParams.get("code") ?? "";
  if (!code) return fail("kod");

  const disc = await discover(cfg.issuer);
  if (!disc) return fail("kesif");
  const redirectUri = cfg.redirectUri || new URL("/api/auth/oidc/callback", url.origin).toString();

  const token = await exchangeCode(cfg, disc.token_endpoint, { code, redirectUri, verifier: stored.v });
  if (!token || !token.id_token) return fail("jeton");

  const jwks = await fetchJwks(disc.jwks_uri);
  if (!jwks) return fail("jwks");
  const idt = verifyIdToken(token.id_token, { issuer: cfg.issuer, clientId: cfg.clientId, nonce: stored.n, jwks });
  if (!idt.ok) return fail("jeton_dogrulama");

  const ident = mapClaims(idt.claims, cfg);
  let resolved;
  try {
    resolved = await resolveOidcAccount(cfg.issuer, ident, { autoProvision: cfg.autoProvision, linkByEmail: cfg.linkByEmail });
  } catch {
    return fail("hesap");
  }
  const acc = resolved.account;

  // IdP kimliği doğruladı; uygulama TOTP'si isteniyorsa bu akışta sorulamaz —
  // kullanıcı parola + kod ile girmeli (sessizce MFA atlanmaz).
  if (!cfg.skipTotp && (acc.twoFactorEnabled || totpRequiredFor(acc.role))) return fail("mfa_gerekli");

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const sid = await createSession(acc.id, { ip, userAgent: req.headers.get("user-agent") ?? "" });
  if (!sid) return fail("oturum");
  const cookie = issueSessionCookie(acc.id, sid);
  if (!cookie) return fail("oturum");

  await recordSuccessfulLogin(acc.id);
  try {
    await audit({ id: acc.id, username: acc.username }, "auth.login.oidc", "user", acc.id, {
      issuer: cfg.issuer,
      subject: ident.subject.slice(0, 24),
      created: resolved.created,
      linked: resolved.linked,
      roleUpgraded: resolved.roleUpgraded,
      session: sid.slice(0, 8),
    });
  } catch {
    /* denetim yazılamadı diye girişi engelleme */
  }

  const target = new URL(stored.x || "/", url.origin);
  const res = NextResponse.redirect(target);
  res.cookies.set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  res.cookies.set(OIDC_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

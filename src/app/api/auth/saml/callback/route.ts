import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { recordSuccessfulLogin, totpRequiredFor } from "@/lib/server/accounts";
import { issueSessionCookie, SESSION_COOKIE } from "@/lib/server/session";
import { SAML_COOKIE, samlConfig, verifySamlResponse, verifySamlState } from "@/lib/server/saml";
import { consumeAssertion, pruneReplay, resolveSamlAccount } from "@/lib/server/samlAccounts";
import { createSession } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * SAML dönüşü (HTTP-POST binding).
 *
 * Doğrulama: imzalı durum çerezi → RelayState → XML/imza (IdP sertifikası) →
 * koşullar (süre, audience, recipient, InResponseTo) → tek kullanım (replay) →
 * hesap eşleme → MFA politikası → sunucu oturumu → denetim.
 *
 * Her başarısızlıkta `/giris?saml_error=<kod>` adresine dönülür; kullanıcıya ham
 * assertion/imza gösterilmez.
 */
export async function POST(req: NextRequest) {
  const cfg = samlConfig();
  const origin = req.nextUrl.origin;
  const fail = (code: string) => {
    const target = new URL("/giris", origin);
    target.searchParams.set("saml_error", code.slice(0, 60));
    const res = NextResponse.redirect(target, 303);
    res.cookies.set(SAML_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  };

  if (!cfg) return fail("yapilandirma");

  const form = await req.formData().catch(() => null);
  if (!form) return fail("bicim");
  const samlResponse = String(form.get("SAMLResponse") ?? "");
  const relayState = String(form.get("RelayState") ?? "");
  if (!samlResponse) return fail("bicim");

  const stored = verifySamlState(req.cookies.get(SAML_COOKIE)?.value);
  if (!stored) return fail("durum");

  const check = verifySamlResponse({
    samlResponse,
    cfg,
    requestId: stored.i,
    acsUrl: stored.a,
    relayState,
    expectedRelayState: stored.r,
  });
  if (!check.ok) {
    try {
      await audit({ id: 0, username: "saml" }, "auth.login.saml_rejected", "user", 0, { reason: check.reason });
    } catch {
      /* denetim yazılamadı diye akışı engelleme */
    }
    return fail(check.reason);
  }

  // Tek kullanım: aynı Assertion ikinci kez kabul edilmez (replay).
  if (!(await consumeAssertion(check.assertionId, check.notOnOrAfter))) return fail("yeniden");
  void pruneReplay();

  let resolved;
  try {
    resolved = await resolveSamlAccount(check.identity, { autoProvision: cfg.autoProvision, linkByEmail: cfg.linkByEmail });
  } catch {
    return fail("hesap");
  }
  const acc = resolved.account;

  // IdP kimliği doğruladı; uygulama TOTP'si bu akışta sorulamaz — sessizce atlanmaz.
  if (!cfg.skipTotp && (acc.twoFactorEnabled || totpRequiredFor(acc.role))) return fail("mfa_gerekli");

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const sid = await createSession(acc.id, { ip, userAgent: req.headers.get("user-agent") ?? "" });
  if (!sid) return fail("oturum");
  const cookie = issueSessionCookie(acc.id, sid);
  if (!cookie) return fail("oturum");

  await recordSuccessfulLogin(acc.id);
  try {
    await audit({ id: acc.id, username: acc.username }, "auth.login.saml", "user", acc.id, {
      issuer: cfg.idpEntityId,
      nameId: check.identity.nameId.slice(0, 40),
      sessionIndex: check.identity.sessionIndex.slice(0, 40),
      created: resolved.created,
      linked: resolved.linked,
      roleUpgraded: resolved.roleUpgraded,
      session: sid.slice(0, 8),
    });
  } catch {
    /* denetim yazılamadı diye girişi engelleme */
  }

  const hedef = new URL(stored.x || "/", origin);
  const res = NextResponse.redirect(hedef, 303);
  res.cookies.set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  res.cookies.set(SAML_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

/** Kullanıcı IdP'den GET ile dönerse (bazı IdP'ler böyle yapar) nazik yönlendirme. */
export async function GET(req: NextRequest) {
  const target = new URL("/giris", req.nextUrl.origin);
  target.searchParams.set("saml_error", "bicim");
  return NextResponse.redirect(target, 303);
}

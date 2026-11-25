import { NextRequest, NextResponse } from "next/server";
import { authnRequestRedirect, newSamlId, SAML_COOKIE, samlConfig, signSamlState } from "@/lib/server/saml";

export const dynamic = "force-dynamic";

/**
 * SAML SP-initiated giriş: AuthnRequest üretilir, imzalı durum çerezi yazılır ve
 * tarayıcı IdP'ye yönlendirilir (HTTP-Redirect binding, DEFLATE + base64).
 *
 * Durum çerezi 10 dakika yaşar; `InResponseTo` ve `RelayState` buradaki değerlerle
 * eşleşmezse dönüş reddedilir (CSRF ve yanıt karıştırma koruması).
 */
export async function GET(req: NextRequest) {
  const cfg = samlConfig();
  const origin = req.nextUrl.origin;
  const target = new URL("/giris", origin);
  if (!cfg) {
    target.searchParams.set("saml_error", "yapilandirma");
    return NextResponse.redirect(target, 303);
  }

  const acsUrl = cfg.acsUrl || new URL("/api/auth/saml/callback", origin).toString();
  const next = req.nextUrl.searchParams.get("next") ?? "/";
  const relay = newSamlId();
  const id = newSamlId();
  const { url } = authnRequestRedirect(cfg, { id, acsUrl, relayState: relay });
  const state = signSamlState({ i: id, r: relay, a: acsUrl, x: next });

  const res = NextResponse.redirect(url, 303);
  if (state) {
    res.cookies.set(SAML_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax", // IdP'den POST ile dönüşte çerezin gitmesi gerekir
      secure: origin.startsWith("https://"),
      path: "/",
      maxAge: 10 * 60,
    });
  }
  return res;
}

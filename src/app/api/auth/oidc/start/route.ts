import { NextRequest, NextResponse } from "next/server";
import { accessEnabled } from "@/lib/server/access";
import { authorizeUrl, OIDC_COOKIE, OIDC_STATE_TTL_MS, oidcConfig, pkcePair, randomToken, signOidcState } from "@/lib/server/oidc";
import { discover } from "@/lib/server/oidcHttp";

export const dynamic = "force-dynamic";

/**
 * KURUMSAL GİRİŞ — başlatma (authorization code + PKCE).
 *
 * Durum (state), nonce ve PKCE verifier imzalı bir çerezde 10 dakika tutulur;
 * hiçbiri URL'de taşınmaz (verifier tarayıcı geçmişine/loglara düşmesin).
 * Kimlik sağlayıcı adresi keşif belgesinden alınır, keşif yoksa
 * `{issuer}/authorize` varsayılır.
 */
export async function GET(req: NextRequest) {
  const cfg = oidcConfig();
  if (!cfg) return NextResponse.json({ error: "OIDC yapılandırılmadı (OIDC_ISSUER / OIDC_CLIENT_ID)" }, { status: 503 });
  if (accessEnabled()) {
    // İki kapı aynı anda çalışmaz: OIDC ile giren kullanıcı ACCESS_TOKEN'ı bilemez.
    return NextResponse.json({ error: "ACCESS_TOKEN kapısı ile kurumsal giriş birlikte kullanılamaz; ACCESS_TOKEN'ı kaldırın." }, { status: 409 });
  }
  if (!(process.env.SESSION_SECRET ?? process.env.DATA_ENCRYPTION_KEY)) {
    return NextResponse.json({ error: "Oturum imzalama anahtarı tanımsız (SESSION_SECRET)" }, { status: 503 });
  }

  const origin = req.nextUrl.origin;
  const rawNext = req.nextUrl.searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  const state = randomToken(24);
  const nonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  const redirectUri = cfg.redirectUri || new URL("/api/auth/oidc/callback", origin).toString();
  const signed = signOidcState({ s: state, n: nonce, v: verifier, x: next });
  if (!signed) return NextResponse.json({ error: "Giriş durumu imzalanamadı" }, { status: 503 });

  const disc = await discover(cfg.issuer);
  const target = authorizeUrl(cfg, { state, nonce, challenge, redirectUri }, disc?.authorization_endpoint);
  const res = NextResponse.redirect(target);
  res.cookies.set(OIDC_COOKIE, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
  });
  return res;
}

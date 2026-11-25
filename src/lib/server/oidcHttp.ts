import type { OidcConfig } from "./oidc";

/**
 * OIDC'nin ağ tarafı: keşif belgesi, JWKS ve token uçları.
 *
 * Keşif ve JWKS 10 dakika bellekte önbelleklenir; IdP geçici olarak yavaşsa
 * giriş akışı kilitlenmesin diye her istek 5 sn'de iptal edilir. Uç adresleri
 * keşif belgesinden gelir — yapılandırılan `OIDC_ISSUER` güven köküdür, bu
 * yüzden yalnız http(s) mutlak adresler kabul edilir.
 */
export interface Discovery {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: Discovery }>();

function absoluteHttp(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `{issuer}/.well-known/openid-configuration`; hata/eksik alan → null. */
export async function discover(issuer: string, timeoutMs = 5000): Promise<Discovery | null> {
  const key = issuer.replace(/\/+$/, "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const r = await fetch(`${key}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<Discovery> & { issuer?: string };
    const auth = absoluteHttp(j.authorization_endpoint);
    const token = absoluteHttp(j.token_endpoint);
    const jwks = absoluteHttp(j.jwks_uri);
    if (!auth || !token || !jwks) return null;
    const data: Discovery = { issuer: j.issuer, authorization_endpoint: auth, token_endpoint: token, jwks_uri: jwks, userinfo_endpoint: absoluteHttp(j.userinfo_endpoint) ?? undefined };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

/** Keşifteki JWKS; hata → null. */
export async function fetchJwks(uri: string, timeoutMs = 5000): Promise<{ keys?: unknown[] } | null> {
  const key = `jwks:${uri}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as unknown as { keys?: unknown[] };
  try {
    const r = await fetch(uri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { keys?: unknown[] };
    if (!j || !Array.isArray(j.keys)) return null;
    cache.set(key, { at: Date.now(), data: j as unknown as Discovery });
    return j;
  } catch {
    return null;
  }
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** authorization_code → token (PKCE verifier ile; client_secret varsa basic auth). */
export async function exchangeCode(
  cfg: OidcConfig,
  tokenEndpoint: string,
  p: { code: string; redirectUri: string; verifier: string },
  timeoutMs = 8000
): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: cfg.clientId,
    code_verifier: p.verifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  try {
    const r = await fetch(tokenEndpoint, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    const j = (await r.json().catch(() => null)) as TokenResponse | null;
    if (!j) return { error: `token_error_${r.status}` };
    if (!r.ok) return { error: j.error ?? `token_error_${r.status}`, error_description: j.error_description };
    return j;
  } catch {
    return null;
  }
}

/** Testler ve yapılandırma değişikliği için önbelleği temizler. */
export function clearOidcCache(): void {
  cache.clear();
}

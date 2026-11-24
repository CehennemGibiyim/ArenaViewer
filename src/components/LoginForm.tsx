"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export interface LoginMode {
  accessEnabled: boolean;
  authRequired: boolean;
}

/**
 * Giriş formu.
 *
 * - authRequired (AUTH_MODE=hesap): kullanıcı adı + parola zorunlu; hesapta MFA açıksa
 *   ikinci adımda kod istenir. ACCESS_TOKEN tanımlıysa kapı anahtarı da istenir.
 * - Demo modunda: yalnız ACCESS_TOKEN alanı (tanımlıysa); hiçbiri yoksa “Devam”.
 */
export default function LoginForm({ mode }: { mode: LoginMode }) {
  const router = useRouter();
  const sp = useSearchParams();
  const nextRaw = sp.get("next") ?? "/";
  const next = nextRaw.startsWith("/") ? nextRaw : "/";

  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpMissing, setTotpMissing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          username: username || undefined,
          password: password || undefined,
          code: needsTotp ? code : undefined,
        }),
      });
      const d = (await r.json().catch(() => null)) as {
        error?: string;
        requiresTotp?: boolean;
        totpMissing?: boolean;
      } | null;
      if (!r.ok) {
        if (d?.requiresTotp) {
          setNeedsTotp(true);
          setTotpMissing(!!d.totpMissing);
        }
        setError(d?.error ?? `Giriş reddedildi (${r.status})`);
        return;
      }
      router.replace(next);
    } catch {
      setError("Sunucuya ulaşılamadı.");
    } finally {
      setBusy(false);
    }
  }

  const accountRequired = mode.authRequired;
  const tokenRequired = mode.accessEnabled;

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      {accountRequired && (
        <>
          <label htmlFor="username" className="block text-xs font-bold uppercase tracking-widest text-slate-400">
            Kullanıcı adı
          </label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
            placeholder="kullanici adi"
          />
          <label htmlFor="password" className="block text-xs font-bold uppercase tracking-widest text-slate-400">
            Parola
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
            placeholder="••••••••"
          />
          {needsTotp && !totpMissing && (
            <>
              <label htmlFor="code" className="block text-xs font-bold uppercase tracking-widest text-emerald-400">
                İki faktörlü kod
              </label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-emerald-500/50 bg-[#080c12] px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-slate-100 outline-none focus:border-emerald-400"
                placeholder="000000"
              />
            </>
          )}
        </>
      )}

      {tokenRequired && (
        <>
          <label htmlFor="token" className="block text-xs font-bold uppercase tracking-widest text-slate-400">
            Erişim anahtarı
          </label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
            placeholder="ACCESS_TOKEN"
          />
        </>
      )}

      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <button
        type="submit"
        disabled={
          busy ||
          (accountRequired && (!username.trim() || !password)) ||
          (!accountRequired && tokenRequired && !token.trim())
        }
        className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-black text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Doğrulanıyor…" : "Giriş"}
      </button>
      <p className="text-center text-[11px] leading-relaxed text-slate-500">
        Bu uygulama araştırma/demo amaçlıdır; klinik karar için kullanılamaz.
        <br />
        Erişim anahtarı ortam değişkeni <code className="text-slate-400">ACCESS_TOKEN</code> içindedir.
      </p>
    </form>
  );
}

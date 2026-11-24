"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Erişim anahtarı (ACCESS_TOKEN) tanımlıysa korunan sayfalara giden kullanıcıyı
 * bu sayfa karşılar. Anahtar doğruysa oturum çerezisi yazılır ve hedef sayfaya
 * dönülür. ACCESS_TOKEN tanımsızsa bu sayfa hiçe sayılır (kapı açık demo).
 */
function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const nextRaw = sp.get("next") ?? "/";
  const next = nextRaw.startsWith("/") ? nextRaw : "/";
  const [token, setToken] = useState("");
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
        body: JSON.stringify({ token }),
      });
      const d = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) {
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

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <label htmlFor="token" className="block text-xs font-bold uppercase tracking-widest text-slate-400">
        Erişim anahtarı
      </label>
      <input
        id="token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoFocus
        className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
        placeholder="ACCESS_TOKEN"
      />
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <button
        type="submit"
        disabled={busy || !token.trim()}
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

export default function GirisPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#070a0f] px-4 text-slate-200">
      <div className="w-full max-w-sm rounded-2xl border border-[#1a2230] bg-[#0b0f16] p-6 shadow-2xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 text-lg font-black text-[#06131a]">
          A
        </div>
        <h1 className="mt-4 text-lg font-black tracking-tight text-slate-50">ATIKVIEWER</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Bu kurulum erişim anahtarı ile korunuyor. Devam etmek için anahtarı girin.
        </p>
        <Suspense fallback={<p className="mt-6 text-center text-xs text-slate-500">Yükleniyor…</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}

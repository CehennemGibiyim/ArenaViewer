"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/csrfClient";

interface SetupInfo {
  needed: boolean;
  requiresTotp: boolean;
  accessEnabled: boolean;
}

/** İlk yönetici kurulumu: hiç etkin kullanıcı yokken /giris üzerinden yapılır. */
export default function SetupForm({ accessEnabled }: { accessEnabled: boolean }) {
  const router = useRouter();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [qr, setQr] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await apiFetch("/api/auth/setup");
        if (r.ok) setInfo((await r.json()) as SetupInfo);
      } catch {
        /* çevrimdışı */
      }
    })();
  }, []);

  if (!info?.needed) return null;

  async function startTotp() {
    const r = await apiFetch("/api/auth/setup", { method: "PUT" });
    if (r.ok) setQr(await r.json());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !info) return;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          username,
          fullName,
          password,
          totpSecret: qr?.secret,
          code: info.requiresTotp ? code : undefined,
        }),
      });
      const d = (await r.json().catch(() => null)) as { error?: string; requiresTotp?: boolean } | null;
      if (!r.ok) {
        if (d?.requiresTotp && !qr) await startTotp();
        setError(d?.error ?? `Kurulum tamamlanamadı (${r.status})`);
        return;
      }
      router.replace("/");
    } catch {
      setError("Sunucuya ulaşılamadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
        Bu kurulumda hiç kullanıcı hesabı yok. İlk yönetici hesabını oluşturun; daha sonra
        Yönetim → Kullanıcılar bölümünden ek hesaplar eklenir.
      </p>

      {accessEnabled && (
        <>
          <label htmlFor="setup-token" className="block text-xs font-bold uppercase tracking-widest text-slate-400">Erişim anahtarı</label>
          <input id="setup-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" />
        </>
      )}
      <label htmlFor="setup-username" className="block text-xs font-bold uppercase tracking-widest text-slate-400">Kullanıcı adı</label>
      <input id="setup-username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" placeholder="yonetici" />
      <label htmlFor="setup-name" className="block text-xs font-bold uppercase tracking-widest text-slate-400">Ad soyad</label>
      <input id="setup-name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" placeholder="Ayşe Kaya" />
      <label htmlFor="setup-password" className="block text-xs font-bold uppercase tracking-widest text-slate-400">Parola (en az 8, harf+rakam)</label>
      <input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" />

      {info.requiresTotp && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
          <p className="text-[11px] font-semibold text-emerald-200">Yönetici hesabı için iki faktörlü doğrulama zorunlu.</p>
          {!qr ? (
            <button type="button" onClick={() => void startTotp()} className={`${btnStyle} mt-2`}>Authenticator ile QR oluştur</button>
          ) : (
            <div className="mt-2 space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- önceden üretilmiş veri URL'si */}
              <img src={qr.qr} alt="MFA QR kodu" className="h-40 w-40 rounded-lg border border-[#232e40] bg-white p-1" />
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-full rounded-lg border border-emerald-500/50 bg-[#080c12] px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-slate-100 outline-none" placeholder="000000" />
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <button type="submit" disabled={busy || username.trim().length < 3 || fullName.trim().length < 3 || password.length < 8 || (accessEnabled && !token.trim()) || (info.requiresTotp && (!qr || code.length !== 6))} className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-black text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Oluşturuluyor…" : "İlk yöneticiyi oluştur"}
      </button>
    </form>
  );
}

const btnStyle = "cursor-pointer rounded-lg bg-emerald-500 px-2.5 py-1 text-[10.5px] font-bold text-slate-950 hover:bg-emerald-400";

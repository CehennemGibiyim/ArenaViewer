"use client";

/**
 * Kullanıcı tercihleri paneli (F3 + f-prefs + i-a11y).
 * Sunucuda (`/api/profile/preferences`) saklanır; yalnız beyaz-listeli alanlar
 * gönderilir. Tema, hareket azaltma ve klavye kısayolları da buradan yönetilir.
 */
import { useCallback, useEffect, useState } from "react";
import { LAYOUTS, THEMES, WINDOW_PRESETS, type LayoutPref, type ThemePref, type UserPrefs } from "@/lib/prefs";
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, findConflicts, formatShortcut, normalizeBinding, resolveShortcuts } from "@/lib/shortcuts";
import { apiFetch } from "@/lib/csrfClient";

export default function PreferencesPanel() {
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [defaults, setDefaults] = useState<UserPrefs | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/profile/preferences");
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Tercihler yüklenemedi");
      const d = (await r.json()) as { prefs: UserPrefs; defaults: UserPrefs };
      setPrefs({ ...d.prefs, shortcuts: d.prefs.shortcuts ?? {} }); setDefaults(d.defaults);
      setErrors({}); setMsg("");
    } catch (e) { setMsg(e instanceof Error ? e.message : "Tercihler yüklenemedi"); }
  }, []);

  // Sayfa açıldığında tercihleri getir (düğme elle yenileme içindir). İstek bir
  // sonraki tıka ertelenir: React 19'da effect gövdesinde ardışık setState zinciri
  // istenmez (react-hooks/set-state-in-effect).
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async (next: UserPrefs) => {
    if (Object.keys(errors).length > 0) { setMsg("Önce geçersiz kısayolları düzeltin."); return; }
    setBusy(true); setMsg("");
    const r = await apiFetch("/api/profile/preferences", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; prefs?: UserPrefs; error?: string };
    setBusy(false);
    if (!r.ok || !d.prefs) { setMsg(d.error ?? "Kaydedilemedi"); return; }
    setPrefs(d.prefs);
    // Tema kaydı hemen uygulanır; bir sonraki açılışta da istasyon aynı temayı yükler.
    const attr = THEMES.find((t) => t.id === d.prefs!.theme)?.attr ?? "";
    if (attr) document.documentElement.setAttribute("data-theme", attr);
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("atik-theme", attr); } catch { /* depolama kapalı */ }
    document.documentElement.dataset.motion = d.prefs.reducedMotion ? "reduce" : "auto";
    // Açık sekmelerdeki istasyon bu olayla kısayolları yeniler (storage olayı).
    try {
      localStorage.setItem("atik-shortcuts", JSON.stringify(d.prefs.shortcuts ?? {}));
      localStorage.setItem("atik-motion", d.prefs.reducedMotion ? "reduce" : "auto");
    } catch { /* depolama kapalı */ }
    setMsg("Tercihler kaydedildi.");
  };

  const reset = async () => {
    setBusy(true); setMsg("");
    const r = await apiFetch("/api/profile/preferences", { method: "DELETE" });
    const d = (await r.json().catch(() => ({}))) as { prefs?: UserPrefs };
    setBusy(false);
    if (d.prefs) { setPrefs({ ...d.prefs, shortcuts: d.prefs.shortcuts ?? {} }); setErrors({}); setMsg("Varsayılanlara dönüldü."); }
    else setMsg("Sıfırlanamadı");
  };

  const setBinding = (id: string, raw: string) => {
    if (!prefs) return;
    const text = raw.trim();
    if (!text) {
      setErrors((e) => ({ ...e, [id]: "Boş bırakılamaz (devre dışı bırakmak için varsayılana dönün)." }));
      return;
    }
    const norm = normalizeBinding(text);
    if (!norm) {
      setErrors((e) => ({ ...e, [id]: "Geçersiz tuş. Tek tuş + isteğe bağlı Ctrl/Alt/Shift kullanın (ör. shift+r)." }));
      return;
    }
    setErrors((e) => { const next = { ...e }; delete next[id]; return next; });
    setPrefs({ ...prefs, shortcuts: { ...prefs.shortcuts, [id]: norm } });
  };

  const sel = "rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200";
  const conflicts = prefs ? findConflicts(prefs.shortcuts) : [];
  const effective = prefs ? resolveShortcuts(prefs.shortcuts) : DEFAULT_SHORTCUTS;

  return (
    <div id="main-content" tabIndex={-1} className="mx-auto max-w-3xl overflow-y-auto p-6">
      <button onClick={() => void load()} className="cursor-pointer rounded border border-slate-500/40 px-2 py-1 text-[11px] font-bold text-cyan-200 hover:bg-slate-500/10">Yenile</button>
      <h1 className="text-lg font-black text-cyan-300">Kullanıcı tercihleri</h1>
      <p className="mt-1 text-xs text-slate-400">Tercihleriniz sunucuda, kimlik doğrulamalı hesabınızla saklanır ve cihazlar arası taşınır.</p>

      {!prefs && <p className="mt-4 text-sm text-slate-400">{msg || "Tercihler yükleniyor…"}</p>}
      {prefs && (
        <div className="mt-4 space-y-4 rounded-xl border border-[#232e40] bg-[#0d121a] p-4">
          <label className="block text-xs">
            <span className="font-bold text-slate-200">Açılış düzeni</span>
            <select className={`mt-1 w-full ${sel}`} value={prefs.layout} onChange={(e) => setPrefs({ ...prefs, layout: e.target.value as LayoutPref })}>
              {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <span className="mt-0.5 block text-[10px] text-slate-500">Seri seçildiğinde pencere ön ayarı bu değerle başlar (sonra elle değiştirilebilir).</span>
          </label>

          <label className="block text-xs">
            <span className="font-bold text-slate-200">Varsayılan pencere ön ayarı</span>
            <select className={`mt-1 w-full ${sel}`} value={prefs.defaultWindow} onChange={(e) => setPrefs({ ...prefs, defaultWindow: e.target.value })}>
              {WINDOW_PRESETS.map((w) => <option key={w || "yok"} value={w}>{w || "(varsayılan yok)"}</option>)}
            </select>
          </label>

          <label className="block text-xs">
            <span className="font-bold text-slate-200">Tema (erişilebilirlik)</span>
            <select className={`mt-1 w-full ${sel}`} value={prefs.theme} onChange={(e) => setPrefs({ ...prefs, theme: e.target.value as ThemePref })}>
              {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <span className="mt-0.5 block text-[10px] text-slate-500">Yüksek kontrast, düşük görüş keskinliği için kenarlıkları ve metni güçlendirir; tanı kalitesini değiştirmez.</span>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prefs.autoHangingProtocol} onChange={(e) => setPrefs({ ...prefs, autoHangingProtocol: e.target.checked })} />
            Seri yüklendiğinde otomatik hanging protocol uygula
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prefs.autoSelectLatest} onChange={(e) => setPrefs({ ...prefs, autoSelectLatest: e.target.checked })} />
            Çalışma listesinde en yeni çalışmayı otomatik seç
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => setPrefs({ ...prefs, reducedMotion: e.target.checked })} />
            Animasyonları ve geçişleri azalt (hareket hassasiyeti)
          </label>

          <section aria-label="Klavye kısayolları">
            <h2 className="text-xs font-black text-cyan-200">Klavye kısayolları</h2>
            <p className="mt-0.5 text-[10px] text-slate-500">
              İstasyonda görüntüleme alanı odaktayken çalışır. Bir tuşu iki eyleme atarsanız kaydetmeden önce uyarı görürsünüz.
              Yardım listesini istasyonda <kbd className="rounded border border-slate-600 px-1">{formatShortcut(effective.help)}</kbd> ile açabilirsiniz.
            </p>
            {conflicts.length > 0 && (
              <p role="alert" className="mt-1 rounded border border-amber-400/40 bg-amber-400/10 p-1.5 text-[10.5px] text-amber-200">
                Çakışan atamalar: {conflicts.map((c) => `${formatShortcut(c.binding)} → ${c.actions.join(", ")}`).join("; ")}. Çakışan eylem varsayılan tuşuna döner.
              </p>
            )}
            <table className="mt-2 w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className="py-1 font-bold">Eylem</th>
                  <th scope="col" className="py-1 font-bold">Tuş</th>
                  <th scope="col" className="py-1 text-right font-bold">Etkin</th>
                </tr>
              </thead>
              <tbody>
                {SHORTCUT_ACTIONS.map((a) => (
                  <tr key={a.id} className="border-t border-[#1b2634]">
                    <th scope="row" className="py-1 pr-2 text-left font-semibold text-slate-200">{a.label}<span className="ml-1 text-[9px] font-normal text-slate-500">{a.group}</span></th>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${a.label} kısayolu`}
                        defaultValue={prefs.shortcuts[a.id] ?? DEFAULT_SHORTCUTS[a.id as keyof typeof DEFAULT_SHORTCUTS] ?? ""}
                        onBlur={(e) => setBinding(a.id, e.currentTarget.value)}
                        className={`w-32 rounded border bg-[#141b24] px-2 py-0.5 font-mono text-[11px] text-slate-200 ${errors[a.id] ? "border-rose-400" : "border-[#232e40]"}`}
                      />
                      {errors[a.id] && <span role="alert" className="ml-1 text-[9.5px] text-rose-300">{errors[a.id]}</span>}
                    </td>
                    <td className="py-1 text-right font-mono text-cyan-200">{formatShortcut(effective[a.id])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button disabled={busy} onClick={() => void save(prefs)} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">Kaydet</button>
            <button disabled={busy} onClick={() => void reset()} className="cursor-pointer rounded border border-rose-400/40 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-400/10 disabled:opacity-50">Varsayılana döndür</button>
            {msg && <span role="status" aria-live="polite" className="text-xs text-slate-400">{msg}</span>}
          </div>

          {defaults && defaults.layout !== prefs.layout && <p className="text-[10px] text-slate-500">Varsayılan düzen: {defaults.layout}</p>}
        </div>
      )}
    </div>
  );
}

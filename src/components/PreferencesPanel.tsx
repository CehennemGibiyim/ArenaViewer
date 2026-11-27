"use client";

/**
 * Kullanıcı tercihleri paneli (F3). Sunucuda (`/api/profile/preferences`) saklanır;
 * yalnız beyaz-listeli alanlar gönderilir. Düzen tercihi, istasyon sonraki
 * açılışında uygulanır.
 */
import Link from "next/link";
import { useState } from "react";
import { LAYOUTS, WINDOW_PRESETS, type LayoutPref, type UserPrefs } from "@/lib/prefs";
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_LABELS, formatKeyList, loadShortcuts, parseKeyList,
  resetShortcuts, saveShortcuts, shortcutConflicts, type ShortcutAction,
} from "@/lib/shortcuts";
import { apiFetch } from "@/lib/csrfClient";

export default function PreferencesPanel() {
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [defaults, setDefaults] = useState<UserPrefs | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, string[]>>(DEFAULT_SHORTCUTS);
  const [scMsg, setScMsg] = useState("");

  const setKeys = (action: ShortcutAction, text: string) =>
    setShortcuts((s) => ({ ...s, [action]: parseKeyList(text) }));
  const saveSc = () => {
    const ok = saveShortcuts(shortcuts);
    setScMsg(ok ? "Kısayollar bu tarayıcıda kaydedildi." : "Kısayollar kalıcı yazılamadı; yalnız bu sekmede geçerli.");
  };
  const resetSc = () => { setShortcuts(resetShortcuts()); setScMsg("Varsayılan kısayollara dönüldü."); };
  const conflicts = shortcutConflicts(shortcuts);

  const load = async () => {
    try {
      const r = await apiFetch("/api/profile/preferences");
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Tercihler yüklenemedi");
      const d = (await r.json()) as { prefs: UserPrefs; defaults: UserPrefs };
      setPrefs(d.prefs); setDefaults(d.defaults);
      setShortcuts(loadShortcuts());
    } catch (e) { setMsg(e instanceof Error ? e.message : "Tercihler yüklenemedi"); }
  };

  const save = async (next: UserPrefs) => {
    setBusy(true); setMsg("");
    const r = await apiFetch("/api/profile/preferences", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; prefs?: UserPrefs; error?: string };
    setBusy(false);
    if (!r.ok || !d.prefs) { setMsg(d.error ?? "Kaydedilemedi"); return; }
    setPrefs(d.prefs);
    setMsg("Tercihler kaydedildi.");
  };

  const reset = async () => {
    setBusy(true); setMsg("");
    const r = await apiFetch("/api/profile/preferences", { method: "DELETE" });
    const d = (await r.json().catch(() => ({}))) as { prefs?: UserPrefs };
    setBusy(false);
    if (d.prefs) { setPrefs(d.prefs); setMsg("Varsayılanlara dönüldü."); } else setMsg("Sıfırlanamadı");
  };

  const sel = "rounded border border-[var(--t34)] bg-[var(--t17)] px-2 py-1 text-xs text-[var(--sl200)]";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <button onClick={() => void load()} className="cursor-pointer rounded border border-[var(--sl500)]/40 px-2 py-1 text-[11px] font-bold text-[var(--ac-cyan200)] hover:bg-[var(--sl500)]/10">Tercihleri getir</button>
      <h1 className="text-lg font-black text-[var(--ac-cyan300)]">Kullanıcı tercihleri</h1>
      <p className="mt-1 text-xs text-[var(--sl400)]">Tercihleriniz sunucuda, kimlik doğrulamalı hesabınızla saklanır ve cihazlar arası taşınır.</p>

      {!prefs && <p className="mt-4 text-sm text-[var(--sl400)]">{msg || "Tercihleri yüklemek için Yenile’yi kullanın."}</p>}
      {prefs && (
        <div className="mt-4 space-y-4 rounded-xl border border-[var(--t34)] bg-[var(--t07)] p-4">
          <label className="block text-xs">
            <span className="font-bold text-[var(--sl200)]">Açılış düzeni</span>
            <select className={`mt-1 w-full ${sel}`} value={prefs.layout} onChange={(e) => setPrefs({ ...prefs, layout: e.target.value as LayoutPref })}>
              {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <span className="mt-0.5 block text-[10px] text-[var(--sl500)]">Seri seçildiğinde pencere ön ayarı bu değerle başlar (sonra elle değiştirilebilir).</span>
          </label>

          <label className="block text-xs">
            <span className="font-bold text-[var(--sl200)]">Varsayılan pencere ön ayarı</span>
            <select className={`mt-1 w-full ${sel}`} value={prefs.defaultWindow} onChange={(e) => setPrefs({ ...prefs, defaultWindow: e.target.value })}>
              {WINDOW_PRESETS.map((w) => <option key={w || "yok"} value={w}>{w || "(varsayılan yok)"}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prefs.autoHangingProtocol} onChange={(e) => setPrefs({ ...prefs, autoHangingProtocol: e.target.checked })} />
            Seri yüklendiğinde otomatik hanging protocol uygula
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prefs.autoSelectLatest} onChange={(e) => setPrefs({ ...prefs, autoSelectLatest: e.target.checked })} />
            Çalışma listesinde en yeni çalışmayı otomatik seç
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button disabled={busy} onClick={() => void save(prefs)} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 text-xs font-bold text-[var(--sl950)] hover:bg-cyan-400 disabled:opacity-50">Kaydet</button>
            <button disabled={busy} onClick={() => void reset()} className="cursor-pointer rounded border border-rose-400/40 px-3 py-1.5 text-xs font-bold text-[var(--ac-rose200)] hover:bg-rose-400/10 disabled:opacity-50">Varsayılana döndür</button>
            {msg && <span className="text-xs text-[var(--sl400)]">{msg}</span>}
          </div>

          {defaults && defaults.layout !== prefs.layout && <p className="text-[10px] text-[var(--sl500)]">Varsayılan düzen: {defaults.layout}</p>}
        </div>
      )}

      <div className="mt-4 space-y-2 rounded-xl border border-[var(--t34)] bg-[var(--t07)] p-4">
        <h2 className="text-sm font-black text-[var(--ac-cyan300)]">Klavye kısayolları</h2>
        <p className="text-[11px] text-[var(--sl400)]">
          Görüntüleyici kısayollarını kendiniz atayabilirsiniz. Birden çok tuş için virgülle ayırın (ör. <code>r, R2</code>).
          Boş bırakılan eylemde kısayol çalışmaz. Bu ayar <b>bu tarayıcıda</b> saklanır; hesaba bağlı değildir.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {SHORTCUT_ACTIONS.map((action) => (
            <label key={action} className="block text-xs">
              <span className="font-bold text-[var(--sl200)]">{SHORTCUT_LABELS[action]}</span>
              <input
                value={formatKeyList(shortcuts[action])}
                onChange={(e) => setKeys(action, e.target.value)}
                placeholder="(atanmadı)"
                aria-label={`${SHORTCUT_LABELS[action]} kısayolu`}
                className="mt-1 w-full rounded border border-[var(--t34)] bg-[var(--t17)] px-2 py-1 font-mono text-xs text-[var(--sl200)]"
              />
            </label>
          ))}
        </div>
        {conflicts.length > 0 && (
          <p className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] text-[var(--ac-amber200)]">
            Çakışma: {conflicts.map((c) => `${c.key} → ${c.actions.map((a) => SHORTCUT_LABELS[a]).join(" / ")}`).join(" · ")}. Çakışmada listedeki ilk eylem çalışır.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button onClick={() => { setShortcuts(loadShortcuts()); setScMsg("Kayıtlı kısayollar yüklendi."); }} className="cursor-pointer rounded border border-[var(--sl500)]/40 px-3 py-1.5 text-xs font-bold text-[var(--ac-cyan200)] hover:bg-[var(--sl500)]/10">Kısayolları getir</button>
          <button onClick={saveSc} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 text-xs font-bold text-[var(--sl950)] hover:bg-cyan-400">Kısayolları kaydet</button>
          <button onClick={resetSc} className="cursor-pointer rounded border border-rose-400/40 px-3 py-1.5 text-xs font-bold text-[var(--ac-rose200)] hover:bg-rose-400/10">Varsayılana döndür</button>
          {scMsg && <span className="text-xs text-[var(--sl400)]">{scMsg}</span>}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-cyan-400/40 bg-cyan-400/5 p-4">
        <h2 className="text-sm font-black text-[var(--ac-cyan200)]">Yardım ve resimli anlatım</h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--sl300)]">
          Ayarların arayüzde nerede olduğunu, bir çalışmanın nasıl açıldığını ve raporun nasıl onaylandığını
          <b> gerçek ekran görüntüleriyle</b> adım adım gösteren sayfa.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href="/resimlianlatim" className="rounded border border-cyan-400/50 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-[var(--ac-cyan200)] hover:bg-cyan-500/20">
            🖼 Resimli anlatım →
          </Link>
          <Link href="/yardim" className="rounded border border-[var(--sl500)]/40 px-2.5 py-1 text-[11px] font-bold text-[var(--sl200)] hover:bg-[var(--sl500)]/10">
            Yardım / S.S.S.
          </Link>
        </div>
      </div>
    </div>
  );
}

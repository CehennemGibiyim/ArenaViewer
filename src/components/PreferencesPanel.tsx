"use client";

/**
 * Kullanıcı tercihleri paneli (F3).
 *
 * **İki katman:** (1) hesap — `/api/profile/preferences` (girişli kurulumda
 * cihazlar arası taşınır), (2) cihaz — `localStorage` (`src/lib/prefsStore.ts`).
 * Cihaz katmanı olmadan panel statik demoda/çevrimdışıyken hiç açılmıyordu;
 * artık her ortamda açılır ve yalnız beyaz-listeli alanlar gönderilir.
 * Kaydetme sonucu **dürüstçe** yazılır: hangi katmana yazıldığı söylenir.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PREFS, LAYOUTS, THEMES, WINDOW_PRESETS, type LayoutPref, type ThemeName, type UserPrefs } from "@/lib/prefs";
import {
  applyTheme, clearStoredPrefs, loadStoredPrefs, mergeSources, saveStoredPrefs, type PrefSource,
} from "@/lib/prefsStore";
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_LABELS, formatKeyList, loadShortcuts, parseKeyList,
  resetShortcuts, saveShortcuts, shortcutConflicts, type ShortcutAction,
} from "@/lib/shortcuts";
import { apiFetch } from "@/lib/csrfClient";

export default function PreferencesPanel() {
  // İlk boyama **cihaz katmanından** yapılır (senkron, effect gerekmez): sayfa
  // açılır açılmaz kullanıcı kendi seçimini görür; sunucu kopyası gelince
  // birleştirilir. Aksi hâlde her açılışta "kayıtlı tercih yok" görünüyordu.
  const [prefs, setPrefs] = useState<UserPrefs | null>(() => (typeof window === "undefined" ? null : loadStoredPrefs()));
  const [defaults, setDefaults] = useState<UserPrefs | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<PrefSource>("varsayılan");
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

  // Sunucu + cihaz katmanını birlikte okur. Sunucu yoksa (statik demo, oturum
  // düşmüş, çevrimdışı) cihaz kopyası kullanılır; ikisi de yoksa varsayılan —
  // ve bunun **varsayılan** olduğu kullanıcıya söylenir.
  const load = useCallback(async () => {
    setBusy(true); setMsg("");
    let server: Partial<UserPrefs> | null = null;
    let serverErr = "";
    try {
      const r = await apiFetch("/api/profile/preferences");
      if (r.ok) {
        const d = (await r.json()) as { prefs?: Partial<UserPrefs>; defaults?: UserPrefs };
        server = d.prefs ?? null;
        if (d.defaults) setDefaults(d.defaults);
      } else {
        serverErr = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
      }
    } catch (e) {
      serverErr = e instanceof Error ? e.message : "sunucuya ulaşılamadı";
    }
    const merged = mergeSources(server);
    setPrefs(merged.prefs);
    setSource(merged.source);
    setShortcuts(loadShortcuts());
    applyTheme(merged.prefs.theme);
    setBusy(false);
    const notes: string[] = [];
    if (merged.source === "cihaz") notes.push("Hesap tercihleri okunamadı; bu tarayıcıdaki kayıt yüklendi.");
    if (merged.source === "varsayılan") notes.push("Kayıtlı tercih bulunamadı; varsayılanlar gösteriliyor.");
    if (serverErr && merged.source !== "sunucu") notes.push(`Sunucu: ${serverErr}`);
    if (merged.warning) notes.push(merged.warning);
    setMsg(notes.join(" "));
  }, []);

  const save = async (next: UserPrefs) => {
    setBusy(true); setMsg("");
    // 1) Cihaz katmanı her zaman yazılır (çevrimdışı da çalışsın).
    const deviceSaved = saveStoredPrefs(next);
    applyTheme(next.theme);
    // 2) Hesap katmanı varsa güncellenir.
    let serverSaved = false;
    let serverErr = "";
    try {
      const r = await apiFetch("/api/profile/preferences", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; prefs?: UserPrefs; error?: string };
      if (r.ok && d.prefs) { setPrefs(d.prefs); serverSaved = true; }
      else serverErr = d.error ?? `HTTP ${r.status}`;
    } catch (e) {
      serverErr = e instanceof Error ? e.message : "sunucuya ulaşılamadı";
    }
    setBusy(false);
    if (!deviceSaved && !serverSaved) { setMsg("Kaydedilemedi: tarayıcı depolaması kapalı ve sunucuya ulaşılamadı."); return; }
    if (deviceSaved && serverSaved) setSource("sunucu");
    else if (deviceSaved) setSource("cihaz");
    setMsg(
      deviceSaved && serverSaved
        ? "Kaydedildi: bu tarayıcı + hesabınız (cihazlar arası taşınır)."
        : deviceSaved
          ? `Bu tarayıcıya kaydedildi.${serverErr ? ` Hesap katmanı yazılamadı (${serverErr}) — giriş yapınca tekrar deneyin.` : ""}`
          : "Yalnız hesaba kaydedildi (bu tarayıcıda depolama kapalı).",
    );
  };

  const reset = async () => {
    setBusy(true); setMsg("");
    clearStoredPrefs();
    applyTheme(DEFAULT_PREFS.theme);
    setPrefs({ ...DEFAULT_PREFS });
    setSource("varsayılan");
    let serverReset = false;
    try {
      const r = await apiFetch("/api/profile/preferences", { method: "DELETE" });
      const d = (await r.json().catch(() => ({}))) as { prefs?: UserPrefs };
      if (d.prefs) { setPrefs(d.prefs); serverReset = true; }
    } catch { /* çevrimdışı: cihaz kopyası silindi, bu yeterli */ }
    setBusy(false);
    setMsg(serverReset ? "Varsayılanlara dönüldü (cihaz + hesap)." : "Varsayılanlara dönüldü (bu tarayıcı).");
  };

  // Panel açılınca kendiliğinden yüklenir: statik demoda "önce düğmeye bas"
  // şartı, hiç yüklenmemiş boş ekran demekti.
  // Otomatik yükleme: yalnız bir kez. `setState` effect gövdesinde değil,
  // `load()` içindeki async akışta (veya kaynağı atamak için ref üzerinden) olur;
  // React kuralları senkron setState'i effect gövdesinde istemiyor.
  const autoRef = useRef(false);
  useEffect(() => {
    if (autoRef.current) return;
    autoRef.current = true;
    void load();
  }, [load]);

  const sel = "rounded border border-[var(--t34)] bg-[var(--t17)] px-2 py-1 text-xs text-[var(--sl200)]";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <button onClick={() => void load()} disabled={busy} className="cursor-pointer rounded border border-[var(--sl500)]/40 px-2 py-1 text-[11px] font-bold text-[var(--ac-cyan200)] hover:bg-[var(--sl500)]/10 disabled:opacity-50">↻ Yenile</button>
      <h1 className="text-lg font-black text-[var(--ac-cyan300)]">Kullanıcı tercihleri</h1>
      <p className="mt-1 text-xs text-[var(--sl400)]">
        Tercihleriniz <b>hesabınızda</b> (girişli kurulumda, cihazlar arası taşınır) ve <b>bu tarayıcıda</b> saklanır.
        Statik demoda yalnız tarayıcı katmanı vardır — seçimler yine kalıcıdır.
      </p>
      <p className="mt-1 text-[11px] text-[var(--sl500)]">
        Kaynak: <b>{source === "sunucu" ? "hesap" : source === "cihaz" ? "bu tarayıcı" : "varsayılan"}</b>
        {source === "varsayılan" && " — henüz kayıtlı bir seçiminiz yok."}
      </p>

      {!prefs && <p className="mt-4 text-sm text-[var(--sl400)]">{msg || (busy ? "Yükleniyor…" : "Tercihler okunuyor…")}</p>}
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

          <label className="block text-xs">
            <span className="font-bold text-[var(--sl200)]">Görünüm teması</span>
            <select
              className={`mt-1 w-full ${sel}`}
              value={prefs.theme}
              onChange={(e) => {
                const theme = e.target.value as ThemeName;
                setPrefs({ ...prefs, theme });
                applyTheme(theme); // seçim anında görünür; kaydet ile kalıcılaşır
              }}
            >
              {THEMES.map((tm) => (
                <option key={tm} value={tm}>
                  {tm === "koyu" ? "Koyu (varsayılan)" : tm === "clinic-blue" ? "Klinik mavi" : tm === "slate-light" ? "Açık tema" : "Yüksek kontrast"}
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[10px] text-[var(--sl500)]">
              Tema, görüntüleyicinin üst çubuğundaki seçiciyle aynı anahtarı (`atik-theme`) kullanır.
            </span>
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

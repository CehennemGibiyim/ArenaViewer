/**
 * Tercihlerin **tarayıcı tarafı** kalıcı kopyası (F3 — yeni).
 *
 * Neden gerekli: sunucu tercihleri (`/api/profile/preferences`) yalnız girişli
 * kurulumda vardır. GitHub Pages demosunda, çevrimdışı PWA'da ya da oturum
 * düşmüşken kullanıcının tema/düzen/kısayol seçimi **kaybolmamalı**; ayrıca
 * "kaydedildi" deyip hiçbir şey saklamamak bu projede yasak bir davranış.
 *
 * Sözleşme:
 *  1. Depolama yoksa/bozuksa `null` döner — **varsayım üretilmez**.
 *  2. Yazma başarısızsa `false` döner; arayüz "kaydedildi" demez.
 *  3. Sunucu kopyası varsa o kazanır (bkz. `mergeSources`): cihaz seçimi
 *     hesabın seçimini sessizce ezmez.
 */
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs, type UserPrefs } from "@/lib/prefs";

export const PREFS_STORAGE_KEY = "atik-prefs";
export const THEME_STORAGE_KEY = "atik-theme";

export type PrefSource = "sunucu" | "cihaz" | "varsayılan";

export interface PrefReadResult {
  prefs: UserPrefs;
  source: PrefSource;
  /** Depolama kapalı/bozuk olduğunda neden bilgisi (kullanıcıya gösterilir). */
  warning?: string;
}

/** localStorage erişimi güvenli mi? (gizli sekme / katı CSP / SSR) */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    const probe = "__atik_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Cihazda saklı tercihler — yoksa `null`. */
export function loadStoredPrefs(): UserPrefs | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const patch = sanitizePrefs(parsed);
    if (Object.keys(patch).length === 0) return null;
    return mergePrefs(DEFAULT_PREFS, patch);
  } catch {
    return null;
  }
}

/**
 * Cihaza yazar. `false` → kalıcı değil (arayüz bunu söylemeli).
 *
 * Kayıt **tam** yazılır: geçersiz bir alan gelirse o alan sessizce "yok" olmaz,
 * önceki geçerli değer korunur — aksi hâlde tek bir hatalı alan kullanıcının
 * düzen seçimini varsayılana düşürürdü.
 */
export function saveStoredPrefs(prefs: UserPrefs): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const full = mergePrefs(loadStoredPrefs() ?? DEFAULT_PREFS, sanitizePrefs(prefs));
    s.setItem(PREFS_STORAGE_KEY, JSON.stringify(full));
    return true;
  } catch {
    return false;
  }
}

/** Cihaz kopyasını siler (varsayılana dönüş). */
export function clearStoredPrefs(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.removeItem(PREFS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sunucu ve cihaz kopyasını birleştirir.
 *
 * Kural: **sunucu kazanır** (hesap cihazlar arasında taşınır), ancak sunucu
 * yoksa cihaz kopyası kullanılır. Hiçbiri yoksa varsayılanlar — ve bu durum
 * `varsayılan` olarak **açıkça** bildirilir, "sizin seçiminiz" gibi gösterilmez.
 */
export function mergeSources(server: Partial<UserPrefs> | null | undefined): PrefReadResult {
  const device = loadStoredPrefs();
  const serverPatch = server ? sanitizePrefs(server) : {};
  const hasServer = Object.keys(serverPatch).length > 0;
  if (hasServer) {
    return { prefs: mergePrefs(device ?? DEFAULT_PREFS, serverPatch), source: "sunucu" };
  }
  if (device) return { prefs: device, source: "cihaz" };
  const s = storage();
  return {
    prefs: { ...DEFAULT_PREFS },
    source: "varsayılan",
    warning: s ? undefined : "Tarayıcı depolaması kapalı; seçimleriniz bu sekme kapanınca kaybolur.",
  };
}

/**
 * Temayı belgeye uygular ve cihaza yazar. Tema `[data-theme]` ile globals.css
 * değişkenlerini değiştirir; "koyu" varsayılan olduğu için boş değer = nitelik yok.
 */
export function applyTheme(theme: string): void {
  if (typeof document === "undefined") return;
  if (theme && theme !== "koyu") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  const s = storage();
  try { s?.setItem(THEME_STORAGE_KEY, theme || "koyu"); } catch { /* yazamıyorsak sessiz geç: görünüm yine uygulandı */ }
}

/** Kayıtlı temayı okur; yoksa `""` (varsayılan görünüm). */
export function readStoredTheme(): string {
  const s = storage();
  try { return s?.getItem(THEME_STORAGE_KEY) ?? ""; } catch { return ""; }
}

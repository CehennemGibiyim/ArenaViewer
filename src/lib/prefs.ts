/**
 * Kullanıcı tercihleri (F3): sunucuda saklanan, doğrulanmış uygulama ayarları.
 *
 * Yalnızca beyaz listedeki alanlar kabul edilir; bilinmeyen/kötü niyetli anahtarlar
 * sessizce atılır. İstemci tarafı (localStorage) buradaki kopyayla senkronize
 * tutulabilir.
 */
import { sanitizeShortcuts } from "./shortcuts";

export const LAYOUTS = ["1x1", "1x2", "2x1", "2x2", "1x3", "3x1", "2x3", "3x2"] as const;
export type LayoutPref = (typeof LAYOUTS)[number];

/** Pencere ön ayarı adları (CT/MR/WL-WW) — boş = varsayılan yok. */
/** İstasyondaki pencere ön ayar adlarıyla birebir (küçük harf, kısaltmalar). */
export const WINDOW_PRESETS = [
  "", "beyin", "akciğer", "kemik", "yumuşak doku", "karaciğer", "mediasten", "meme", "pelvis",
] as const;

/**
 * Temalar: `theme` tercihi doğrudan `data-theme` özniteliğine yazılır.
 * `koyu` varsayılan olduğu için öznitelik kaldırılır.
 */
export const THEMES = [
  { id: "koyu", label: "Koyu (varsayılan)", attr: "" },
  { id: "clinic-blue", label: "Klinik mavi", attr: "clinic-blue" },
  { id: "slate-light", label: "Açık tema", attr: "slate-light" },
  { id: "high-contrast", label: "Yüksek kontrast (erişilebilirlik)", attr: "high-contrast" },
] as const;
export type ThemePref = (typeof THEMES)[number]["id"];

export interface UserPrefs {
  /** Açılış düzeni */
  layout: LayoutPref;
  /** Varsayılan pencere ön ayarı */
  defaultWindow: string;
  /** Seri yüklendiğinde otomatik hanging protocol uygulanmasın */
  autoHangingProtocol: boolean;
  /** Renk teması (yüksek kontrast bir erişilebilirlik seçeneğidir, "açık tema" değil) */
  theme: ThemePref;
  /** Çalışma listesinde son raporlanan çalışmayı otomatik seç */
  autoSelectLatest: boolean;
  /** Animasyon/geçişleri azalt (işletim sistemi ayarından bağımsız zorunlu tercih) */
  reducedMotion: boolean;
  /** Eylem → tuş ataması; boş bırakılan eylem devre dışıdır (bkz. lib/shortcuts). */
  shortcuts: Record<string, string>;
}

export const DEFAULT_PREFS: UserPrefs = {
  layout: "1x2",
  defaultWindow: "",
  autoHangingProtocol: true,
  theme: "koyu",
  autoSelectLatest: false,
  reducedMotion: false,
  shortcuts: {},
};

const isStr = (v: unknown): v is string => typeof v === "string";
const THEME_IDS = THEMES.map((t) => t.id) as readonly string[];

/** Ham girdiden yalnız geçerli alanları çıkarır (beyaz liste). */
export function sanitizePrefs(input: unknown): Partial<UserPrefs> {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const out: Partial<UserPrefs> = {};
  if (isStr(o.layout) && (LAYOUTS as readonly string[]).includes(o.layout)) out.layout = o.layout as LayoutPref;
  if (isStr(o.defaultWindow) && (WINDOW_PRESETS as readonly string[]).includes(o.defaultWindow)) out.defaultWindow = o.defaultWindow;
  if (typeof o.autoHangingProtocol === "boolean") out.autoHangingProtocol = o.autoHangingProtocol;
  if (typeof o.autoSelectLatest === "boolean") out.autoSelectLatest = o.autoSelectLatest;
  if (isStr(o.theme) && THEME_IDS.includes(o.theme)) out.theme = o.theme as ThemePref;
  if (typeof o.reducedMotion === "boolean") out.reducedMotion = o.reducedMotion;
  if (o.shortcuts && typeof o.shortcuts === "object" && !Array.isArray(o.shortcuts)) {
    const shortcuts = sanitizeShortcuts(o.shortcuts);
    // Boş nesne "hepsini varsayılana döndür" anlamına gelir; kabul edilir.
    out.shortcuts = shortcuts;
  }
  return out;
}

/** Mevcut tercihlere yamayı uygular; eksik alanlar korunur. */
export function mergePrefs(base: UserPrefs, patch: Partial<UserPrefs>): UserPrefs {
  return { ...base, ...sanitizePrefs(patch) };
}

/** Tema tercihini `data-theme` değerine çevirir ("" = varsayılan koyu). */
export function themeAttr(theme: string | undefined): string {
  return THEMES.find((t) => t.id === theme)?.attr ?? "";
}

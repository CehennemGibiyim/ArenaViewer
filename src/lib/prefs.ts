/**
 * Kullanıcı tercihleri (F3): sunucuda saklanan, doğrulanmış uygulama ayarları.
 *
 * Yalnızca beyaz listedeki alanlar kabul edilir; bilinmeyen/kötü niyetli anahtarlar
 * sessizce atılır. İstemci tarafı (localStorage) buradaki kopyayla senkronize
 * tutulabilir.
 */

export const THEMES = ["koyu", "clinic-blue", "slate-light", "high-contrast"] as const;
export type ThemeName = (typeof THEMES)[number];

export const LAYOUTS = ["1x1", "1x2", "2x1", "2x2", "1x3", "3x1", "2x3", "3x2"] as const;
export type LayoutPref = (typeof LAYOUTS)[number];

/** Pencere ön ayarı adları (CT/MR/WL-WW) — boş = varsayılan yok. */
/** İstasyondaki pencere ön ayar adlarıyla birebir (küçük harf, kısaltmalar). */
export const WINDOW_PRESETS = [
  "", "beyin", "akciğer", "kemik", "yumuşak doku", "karaciğer", "mediasten", "meme", "pelvis",
] as const;

export interface UserPrefs {
  /** Açılış düzeni */
  layout: LayoutPref;
  /** Varsayılan pencere ön ayarı */
  defaultWindow: string;
  /** Seri yüklendiğinde otomatik hanging protocol uygulanmasın */
  autoHangingProtocol: boolean;
  /** Görünüm teması (globals.css [data-theme] ile uygulanır) */
  theme: ThemeName;
  /** Çalışma listesinde son raporlanan çalışmayı otomatik seç */
  autoSelectLatest: boolean;
}

export const DEFAULT_PREFS: UserPrefs = {
  layout: "1x2",
  defaultWindow: "",
  autoHangingProtocol: true,
  theme: "koyu",
  autoSelectLatest: false,
};

const isStr = (v: unknown): v is string => typeof v === "string";

/** Ham girdiden yalnız geçerli alanları çıkarır (beyaz liste). */
export function sanitizePrefs(input: unknown): Partial<UserPrefs> {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const out: Partial<UserPrefs> = {};
  if (isStr(o.layout) && (LAYOUTS as readonly string[]).includes(o.layout)) out.layout = o.layout as LayoutPref;
  if (isStr(o.defaultWindow) && (WINDOW_PRESETS as readonly string[]).includes(o.defaultWindow)) out.defaultWindow = o.defaultWindow;
  if (typeof o.autoHangingProtocol === "boolean") out.autoHangingProtocol = o.autoHangingProtocol;
  if (typeof o.autoSelectLatest === "boolean") out.autoSelectLatest = o.autoSelectLatest;
  if (isStr(o.theme) && (THEMES as readonly string[]).includes(o.theme)) out.theme = o.theme as ThemeName;
  return out;
}

/** Mevcut tercihlere yamayı uygular; eksik alanlar korunur. */
export function mergePrefs(base: UserPrefs, patch: Partial<UserPrefs>): UserPrefs {
  return { ...base, ...sanitizePrefs(patch) };
}

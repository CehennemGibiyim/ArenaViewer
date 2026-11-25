/**
 * Kullanıcı tercihleri (F3): sunucuda saklanan, doğrulanmış uygulama ayarları.
 *
 * Yalnızca beyaz listedeki alanlar kabul edilir; bilinmeyen/kötü niyetli anahtarlar
 * sessizce atılır. İstemci tarafı (localStorage) buradaki kopyayla senkronize
 * tutulabilir.
 */

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
  /** Karanlık/açık görünüm (şimdilik arayüzde karanlık sabit; aydınlık hazır değil) */
  theme: "koyu";
  /** Çalışma listesinde son raporlanan çalışmayı otomatik seç */
  autoSelectLatest: boolean;
  /** Favori şablon kimlikleri (en fazla 40; ilk sıradaki en yeni). */
  favoriteTemplates: number[];
}

export const DEFAULT_PREFS: UserPrefs = {
  layout: "1x2",
  defaultWindow: "",
  autoHangingProtocol: true,
  theme: "koyu",
  autoSelectLatest: false,
  favoriteTemplates: [],
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
  if (o.theme === "koyu") out.theme = "koyu";
  if (Array.isArray(o.favoriteTemplates)) {
    const ids = o.favoriteTemplates.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
    out.favoriteTemplates = [...new Set(ids)].slice(0, 40);
  }
  return out;
}

/** Mevcut tercihlere yamayı uygular; eksik alanlar korunur. */
export function mergePrefs(base: UserPrefs, patch: Partial<UserPrefs>): UserPrefs {
  return { ...base, ...sanitizePrefs(patch) };
}

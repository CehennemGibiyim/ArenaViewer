/**
 * Klavye kısayolu motoru (i-a11y + f-prefs).
 *
 * Neden ayrı modül: kısayollar istasyonda sabit kodluydu; kullanıcıya özelleştirme
 * ve erişilebilirlik için "hangi tuş ne yapar" listesi gerekiyordu. Buradaki
 * fonksiyonlar saftır (DOM'a dokunmaz), böylece sunucuda doğrulama, istemcide
 * eşleştirme ve testler aynı kuralları kullanır.
 *
 * Kural: tek bir fiziksel tuş + isteğe bağlı Ctrl/Alt/Shift/Meta. Çok adımlı
 * diziler (ör. "g sonra k") desteklenmez; belirsiz/çakışan atamalar sessizce
 * düşürülür ve varsayılana döner.
 */

export const SHORTCUT_ACTIONS = [
  { id: "slicePrev", label: "Önceki kesit", group: "Navigasyon", hint: "Cine kapalıyken bir kesit geri" },
  { id: "sliceNext", label: "Sonraki kesit", group: "Navigasyon", hint: "Cine kapalıyken bir kesit ileri" },
  { id: "resetView", label: "Görünümü sıfırla", group: "Navigasyon", hint: "Zoom/pan/döndürme/ters çevirme temizlenir" },
  { id: "rotate", label: "90° döndür", group: "Görüntü", hint: "Saat yönünde çeyrek tur" },
  { id: "flipH", label: "Yatay çevir", group: "Görüntü", hint: "Sol-sağ aynalama" },
  { id: "flipV", label: "Dikey çevir", group: "Görüntü", hint: "Üst-alt aynalama" },
  { id: "invert", label: "Ters gösterim", group: "Görüntü", hint: "MONOCHROME1 benzeri negatif" },
  { id: "keyImage", label: "Anahtar kesit", group: "Rapor", hint: "Geçerli kesiti ★ olarak işaretler" },
  { id: "report", label: "Rapor paneli", group: "Rapor", hint: "Rapor ekranını açar" },
  { id: "dose", label: "Doz paneli", group: "Araçlar", hint: "RDSR doz özetini açar" },
  { id: "fullscreen", label: "Tam ekran", group: "Araçlar", hint: "Tam ekranı açar/kapatır" },
  { id: "help", label: "Kısayol yardımı", group: "Yardım", hint: "Bu listeyi gösterir" },
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]["id"];

/** Fabrika ayarları. Çakışma yoktur (test bunu doğrular). */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  slicePrev: "arrowup",
  sliceNext: "arrowdown",
  resetView: "0",
  rotate: "r",
  flipH: "h",
  flipV: "v",
  invert: "i",
  keyImage: "k",
  report: "p",
  dose: "d",
  fullscreen: "f",
  help: "?",
};

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

const ALIASES: Record<string, string> = {
  up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright",
  esc: "escape", return: "enter", del: "delete", ins: "insert",
  spacebar: "space", pgup: "pageup", pgdn: "pagedown",
};

/** Kabul edilen tek tuşlar: harf, rakam, ok, işlev tuşu ve yaygın işaretler. */
const NAMED_KEYS = new Set([
  "arrowup", "arrowdown", "arrowleft", "arrowright", "escape", "enter", "tab", "space",
  "home", "end", "pageup", "pagedown", "delete", "backspace", "insert",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const SYMBOL_KEYS = new Set(["?", "/", "\\", ".", ",", ";", ":", "'", '"', "[", "]", "-", "=", "+", "*", "`"]);

/** Shift ile üretilen işaretler: bu tuşlarda shift zorunlu sayılmaz. */
const SHIFTED_SYMBOLS = new Set(["?", ":", '"', "+", "*"]);

export interface Binding {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * Ham atamayı ("Shift+R", "arrowup", "?") ayrıştırır. Geçersizse `null`.
 * Tek tuş zorunludur; "ctrl+shift" gibi tuşsuz ifadeler reddedilir.
 */
export function parseBinding(raw: string): Binding | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 40) return null;

  // "+" hem ayırıcı hem tuş olabilir: yalnız başına "+" tuşudur.
  const parts = text === "+" ? ["+"] : text.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let key = "";
  const mods = new Set<Modifier>();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if ((MODIFIERS as readonly string[]).includes(lower)) {
      mods.add(lower as Modifier); // sıra bağımsız: "r+shift" = "shift+r"
      continue;
    }
    if (key) return null; // iki tuş: desteklenmez
    key = ALIASES[lower] ?? lower;
  }
  if (!key) return null;
  if (/^[a-z0-9]$/.test(key)) { /* tek harf/rakam */ }
  else if (NAMED_KEYS.has(key)) { /* adlandırılmış tuş */ }
  else if (SYMBOL_KEYS.has(key)) { /* işaret */ }
  else return null;

  return {
    key: key.length === 1 ? key : key.toLowerCase(),
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    shift: mods.has("shift"),
    meta: mods.has("meta"),
  };
}

/** Ayrıştırılmış atamayı kanonik metne çevirir (ör. "shift+r"). */
export function serializeBinding(b: Binding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("ctrl");
  if (b.alt) parts.push("alt");
  if (b.shift) parts.push("shift");
  if (b.meta) parts.push("meta");
  parts.push(b.key);
  return parts.join("+");
}

/** Ham atamayı kanonikleştirir; geçersizse null. */
export function normalizeBinding(raw: string): string | null {
  const b = parseBinding(raw);
  return b ? serializeBinding(b) : null;
}

/**
 * Girdiyi beyaz listeye göre temizler: bilinmeyen eylem, geçersiz tuş ve
 * tekrarlanan atamalar düşer. Tekrar eden atamada ilk eylem kazanır.
 */
export function sanitizeShortcuts(input: unknown): Partial<Record<ShortcutAction, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<Record<ShortcutAction, string>> = {};
  const used = new Set<string>();
  for (const { id } of SHORTCUT_ACTIONS) {
    const value = raw[id];
    if (typeof value !== "string") continue;
    const norm = normalizeBinding(value);
    if (!norm || used.has(norm)) continue;
    used.add(norm);
    out[id] = norm;
  }
  return out;
}

/**
 * Varsayılanlarla birleştirir ve çakışmaları çözer: özel atama kendi eylemini
 * kazanır; çakışan eylem varsayılanına döner, o da doluysa devre dışı ("").
 */
export function resolveShortcuts(custom: unknown): Record<ShortcutAction, string> {
  const patch = sanitizeShortcuts(custom);
  const result = { ...DEFAULT_SHORTCUTS, ...patch } as Record<ShortcutAction, string>;
  const taken = new Map<string, ShortcutAction>();
  for (const { id } of SHORTCUT_ACTIONS) {
    const value = result[id];
    if (!value) continue;
    const owner = taken.get(value);
    if (!owner) { taken.set(value, id); continue; }
    // Çakışma: özel atamayı koru, diğeri varsayılana dönsün.
    const keepCustom = id in patch;
    const loser: ShortcutAction = keepCustom ? owner : id;
    const winner: ShortcutAction = keepCustom ? id : owner;
    taken.set(value, winner);
    const fallback = DEFAULT_SHORTCUTS[loser];
    if (fallback && !taken.has(fallback)) {
      result[loser] = fallback;
      taken.set(fallback, loser);
    } else if (loser === id) {
      result[loser] = "";
    } else {
      result[owner] = "";
    }
  }
  return result;
}

/** Tercihlerde saklanan (JSON) özel atamaları güvenle okur. */
export function shortcutFor(shortcuts: unknown, action: ShortcutAction): string {
  const resolved = resolveShortcuts(shortcuts);
  return resolved[action];
}

export interface KeyLikeEvent {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/**
 * Olayın atamayla eşleşip eşleşmediğini söyler. Shift ile üretilen işaretlerde
 * (`?`, `:`, `+` …) shift durumu yok sayılır: klavye düzenine göre farklı
 * raporlanabilir.
 */
export function matchShortcut(event: KeyLikeEvent, binding: string | null | undefined): boolean {
  if (!binding) return false;
  const b = parseBinding(binding);
  if (!b) return false;
  const eventKey = ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase();
  if (eventKey !== b.key) return false;
  const shiftOptional = b.key.length === 1 && SHIFTED_SYMBOLS.has(b.key);
  if (!!event.ctrlKey !== b.ctrl) return false;
  if (!!event.altKey !== b.alt) return false;
  if (!!event.metaKey !== b.meta) return false;
  if (!shiftOptional && !!event.shiftKey !== b.shift) return false;
  return true;
}

/** İnsan okunur biçim (yardım tablosu ve düğme ipuçları). */
export function formatShortcut(binding: string | null | undefined): string {
  if (!binding) return "—";
  const b = parseBinding(binding);
  if (!b) return "—";
  const keyLabel: Record<string, string> = {
    arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
    escape: "Esc", enter: "Enter", space: "Boşluk", pageup: "PgUp", pagedown: "PgDn",
    delete: "Del", backspace: "Backspace", insert: "Ins", tab: "Tab", home: "Home", end: "End",
  };
  const label = keyLabel[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key.toUpperCase());
  const mods: string[] = [];
  if (b.ctrl) mods.push("Ctrl");
  if (b.alt) mods.push("Alt");
  if (b.shift) mods.push("Shift");
  if (b.meta) mods.push("⌘");
  return [...mods, label].join(" + ");
}

/** Aynı tuşa atanmış eylemleri bulur (düzenleme ekranında uyarı için). */
export function findConflicts(shortcuts: unknown): { binding: string; actions: ShortcutAction[] }[] {
  const custom = sanitizeShortcuts(shortcuts);
  const byBinding = new Map<string, ShortcutAction[]>();
  for (const { id } of SHORTCUT_ACTIONS) {
    const binding = custom[id];
    if (!binding) continue;
    const list = byBinding.get(binding) ?? [];
    list.push(id);
    byBinding.set(binding, list);
  }
  return [...byBinding.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([binding, actions]) => ({ binding, actions }));
}

/** Yardım tablosu için eylem + etkin tuş listesi. */
export function shortcutRows(shortcuts: unknown) {
  const resolved = resolveShortcuts(shortcuts);
  return SHORTCUT_ACTIONS.map((a) => ({ ...a, binding: resolved[a.id], label: formatShortcut(resolved[a.id]) }));
}

/**
 * Klavye kısayolları (v-geo) — kullanıcı özelleştirmesi.
 *
 * Neden: görüntüleyici kısayolları (R/H/V/K, ok tuşları) kodda sabitti; kullanıcı
 * kendi tuşunu atayamıyordu. Bu modül eylem listesini, tuş normalleştirmesini,
 * çakışma denetimini ve tarayıcıda saklanan tercih biçimini tek yerde toplar.
 *
 * Kapsam: yalnız görüntüleme eylemleri (kesit ileri/geri, döndür, yatay/dikey
 * çevir, anahtar kesit). Metin alanlarında ve Ctrl/Alt/Meta basılıyken kısayol
 * çalışmaz — bu kural çağıran taraftadır (isTyping kontrolü).
 */
import { readPreference, writePreference } from "./browserPreferences";

export const SHORTCUT_ACTIONS = ["sliceUp", "sliceDown", "rotate", "flipH", "flipV", "keyImage"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const SHORTCUT_STORAGE_KEY = "atik_shortcuts";

/** Eylem başına en çok kaç tuş atanabilir. */
export const MAX_KEYS_PER_ACTION = 4;

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  sliceUp: "Önceki kesit",
  sliceDown: "Sonraki kesit",
  rotate: "90° döndür",
  flipH: "Yatay çevir",
  flipV: "Dikey çevir",
  keyImage: "Anahtar kesit (★)",
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string[]> = {
  sliceUp: ["ArrowUp", "ArrowLeft"],
  sliceDown: ["ArrowDown", "ArrowRight"],
  rotate: ["r"],
  flipH: ["h"],
  flipV: ["v"],
  keyImage: ["k"],
};

/** Tarayıcı tuş adını tek biçime indirger: tek harf küçük, özel tuşlar adıyla. */
export function normalizeKey(key: string): string {
  const raw = key ?? "";
  if (raw === " ") return "Space"; // boşluk tuşu kırpılmadan yakalanır
  const k = raw.trim();
  if (!k) return "";
  if (k.length === 1) return k.toLocaleLowerCase("en-US");
  // "arrowup" / "ARROWUP" / "ArrowUp" → "ArrowUp"
  const known = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space", "Enter", "Tab"];
  const hit = known.find((x) => x.toLocaleLowerCase("en-US") === k.toLocaleLowerCase("en-US"));
  return hit ?? k;
}

/** "r, R2, ArrowUp" gibi virgül/boşluk ayrılmış metni tuş listesine çevirir. */
export function parseKeyList(text: string): string[] {
  const parts = (text ?? "").split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const k = normalizeKey(p);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.slice(0, MAX_KEYS_PER_ACTION);
}

/** Tuş listesini düzenleme kutusunda gösterilecek metne çevirir. */
export function formatKeyList(keys: string[]): string {
  return (keys ?? []).join(", ");
}

/** Bilinmeyen/bozuk kayıtları varsayılana düşürerek geçerli bir harita üretir. */
export function sanitizeShortcuts(raw: unknown): Record<ShortcutAction, string[]> {
  const out: Record<ShortcutAction, string[]> = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const action of SHORTCUT_ACTIONS) {
    const v = rec[action];
    if (!Array.isArray(v)) continue;
    const keys = v.map((x) => (typeof x === "string" ? normalizeKey(x) : "")).filter(Boolean);
    const uniq = [...new Set(keys)].slice(0, MAX_KEYS_PER_ACTION);
    if (uniq.length > 0) out[action] = uniq;
  }
  return out;
}

/** Aynı tuşa birden çok eylem atanmışsa çakışmaları döndürür (ilk eylem kazanır). */
export function shortcutConflicts(map: Record<ShortcutAction, string[]>): { key: string; actions: ShortcutAction[] }[] {
  const owners = new Map<string, ShortcutAction[]>();
  for (const action of SHORTCUT_ACTIONS) {
    for (const key of map[action] ?? []) {
      const arr = owners.get(key) ?? [];
      arr.push(action);
      owners.set(key, arr);
    }
  }
  return [...owners.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([key, actions]) => ({ key, actions }))
    .sort((a, b) => a.key.localeCompare(b.key, "tr"));
}

/** Basılan tuşu eyleme çevirir; atanmamışsa null. Çakışmada listedeki ilk eylem kazanır. */
export function resolveAction(key: string, map: Record<ShortcutAction, string[]>): ShortcutAction | null {
  const k = normalizeKey(key);
  if (!k) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if ((map[action] ?? []).includes(k)) return action;
  }
  return null;
}

/** Tarayıcıda saklanan kısayol haritasını okur (yoksa varsayılan). */
export function loadShortcuts(): Record<ShortcutAction, string[]> {
  return sanitizeShortcuts(readPreference(SHORTCUT_STORAGE_KEY));
}

/** Kısayol haritasını tarayıcıya yazar; başarısızsa false. */
export function saveShortcuts(map: Record<ShortcutAction, string[]>): boolean {
  return writePreference(SHORTCUT_STORAGE_KEY, sanitizeShortcuts(map));
}

/** Varsayılanlara döner ve kaydı temizler. */
export function resetShortcuts(): Record<ShortcutAction, string[]> {
  writePreference(SHORTCUT_STORAGE_KEY, null);
  return { ...DEFAULT_SHORTCUTS };
}

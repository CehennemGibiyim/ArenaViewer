"use client";

/**
 * Basit i18n altyapısı (i18n-framework yok, kasıtlı olarak bağımlılıksız).
 *
 * - Dil paketleri `src/i18n/<kod>.json` içindedir; **lazy-load** edilir:
 *   ilk açılışta yalnız `tr` + `en` (yedek) yüklenir, kullanıcı başka dili
 *   seçtiğinde ilgili paket `import()` ile çekilir (bundle'ı şişirmez).
 * - Eksik anahtarlar sırayla: seçili dil → `en` → anahtarın kendisi.
 * - Bilinen ~25 dil paketle gelir (dünyadaki konuşucu sayısının ~%75'i).
 *   Yeni dil eklemek: paket JSON'u + aşağıdaki kayıt + CI (`npm run test:i18n`).
 * - Uzun metinler (raporlar, modal içerikleri, belgeler) henüz yalnızca
 *   Türkçe'dir; çevirilen katman arayüz kromudur (üst çubuk, durum şeridi,
 *   tema/dil seçicileri).
 */
import { useEffect, useSyncExternalStore } from "react";
import en from "@/i18n/en.json";
import tr from "@/i18n/tr.json";

export interface LanguageInfo {
  code: string;
  native: string;
  english: string;
  dir: "ltr" | "rtl";
}

/** Kayıtlı diller — yeni paket buraya eklenir (CI anahtar eşleşmesini denetler). */
export const LANGUAGES: LanguageInfo[] = [
  { code: "tr", native: "Türkçe", english: "Turkish", dir: "ltr" },
  { code: "en", native: "English", english: "English", dir: "ltr" },
  { code: "es", native: "Español", english: "Spanish", dir: "ltr" },
  { code: "fr", native: "Français", english: "French", dir: "ltr" },
  { code: "de", native: "Deutsch", english: "German", dir: "ltr" },
  { code: "it", native: "Italiano", english: "Italian", dir: "ltr" },
  { code: "pt", native: "Português", english: "Portuguese", dir: "ltr" },
  { code: "nl", native: "Nederlands", english: "Dutch", dir: "ltr" },
  { code: "pl", native: "Polski", english: "Polish", dir: "ltr" },
  { code: "ru", native: "Русский", english: "Russian", dir: "ltr" },
  { code: "uk", native: "Українська", english: "Ukrainian", dir: "ltr" },
  { code: "cs", native: "Čeština", english: "Czech", dir: "ltr" },
  { code: "sv", native: "Svenska", english: "Swedish", dir: "ltr" },
  { code: "ro", native: "Română", english: "Romanian", dir: "ltr" },
  { code: "hu", native: "Magyar", english: "Hungarian", dir: "ltr" },
  { code: "bg", native: "Български", english: "Bulgarian", dir: "ltr" },
  { code: "ar", native: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629", english: "Arabic", dir: "rtl" },
  { code: "he", native: "\u05E2\u05D1\u05E8\u05D9\u05EA", english: "Hebrew", dir: "rtl" },
  { code: "hi", native: "हिन्दी", english: "Hindi", dir: "ltr" },
  { code: "zh", native: "中文（简体）", english: "Chinese (Simplified)", dir: "ltr" },
  { code: "ja", native: "日本語", english: "Japanese", dir: "ltr" },
  { code: "ko", native: "한국어", english: "Korean", dir: "ltr" },
  { code: "id", native: "Bahasa Indonesia", english: "Indonesian", dir: "ltr" },
  { code: "th", native: "ไทย", english: "Thai", dir: "ltr" },
];

export const DEFAULT_LOCALE = "tr";
export const FALLBACK_LOCALE = "en";
const STORAGE_KEY = "atik-lang";

type Pack = Record<string, string>;
const loaded = new Map<string, Pack>([
  ["en", en as Pack],
  ["tr", tr as Pack],
]);

/** Kayıtlı dillerin lazy yükleyicileri (statik `import()` listesi gerekli). */
const registry: Record<string, () => Promise<{ default: Pack }>> = {
  es: () => import("@/i18n/es.json"),
  fr: () => import("@/i18n/fr.json"),
  de: () => import("@/i18n/de.json"),
  it: () => import("@/i18n/it.json"),
  pt: () => import("@/i18n/pt.json"),
  nl: () => import("@/i18n/nl.json"),
  pl: () => import("@/i18n/pl.json"),
  ru: () => import("@/i18n/ru.json"),
  uk: () => import("@/i18n/uk.json"),
  cs: () => import("@/i18n/cs.json"),
  sv: () => import("@/i18n/sv.json"),
  ro: () => import("@/i18n/ro.json"),
  hu: () => import("@/i18n/hu.json"),
  bg: () => import("@/i18n/bg.json"),
  ar: () => import("@/i18n/ar.json"),
  he: () => import("@/i18n/he.json"),
  hi: () => import("@/i18n/hi.json"),
  zh: () => import("@/i18n/zh.json"),
  ja: () => import("@/i18n/ja.json"),
  ko: () => import("@/i18n/ko.json"),
  id: () => import("@/i18n/id.json"),
  th: () => import("@/i18n/th.json"),
};

let active: string = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Dil paketini (gerekirse) yükleyip etkin dili değiştirir. Bilinmeyen kod sessizce yoksayılır. */
export async function setLocale(code: string): Promise<void> {
  const info = LANGUAGES.find((l) => l.code === code);
  if (!info) return;
  if (!loaded.has(code)) {
    const loader = registry[code];
    if (!loader) return; // kayıt var ama paket yok: yoksay (CI bunu zaten yakalar)
    const mod = await loader();
    loaded.set(code, mod.default);
  }
  active = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
    document.documentElement.setAttribute("lang", code);
    // Yerleşim LTR kalır; RTL görsel doğrulaması ayrı bir iştir (KILAVUZ_BAKIMI §Not).
    document.documentElement.setAttribute("dir", "ltr");
  } catch { /* depolama kapalıysa oturum içi geçerlidir */ }
  emit();
}

export function getLocale(): string {
  return active;
}

/** `useSyncExternalStore` getSnapshot — referans kararlıdır (string). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Anahtarı çözer: etkin dil → en → anahtar. */
export function translate(code: string, key: string): string {
  return loaded.get(code)?.[key] ?? loaded.get(FALLBACK_LOCALE)?.[key] ?? key;
}

/** Bileşenlerde kullanım: `const { locale, t, setLocale } = useI18n();` */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, () => active, () => DEFAULT_LOCALE);

  // İlk açılış: kayıtlı dili geri yükle
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== active) void setLocale(saved);
    } catch { /* yoksa varsayılan kalır */ }
  }, []);

  return {
    locale,
    languages: LANGUAGES,
    t: (key: string) => translate(locale, key),
    setLocale: (code: string) => setLocale(code),
  };
}

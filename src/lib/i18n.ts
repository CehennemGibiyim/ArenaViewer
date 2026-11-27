"use client";

/**
 * Basit i18n altyapısı (i18n-framework yok, kasıtlı olarak bağımlılıksız).
 *
 * - Dil paketleri `src/i18n/<kod>.json` içindedir; **lazy-load** edilir:
 *   ilk açılışta yalnız `tr` + `en` (yedek) yüklenir, kullanıcı başka dili
 *   seçtiğinde ilgili paket `import()` ile çekilir (bundle'ı şişirmez).
 * - Eksik anahtarlar sırayla: seçili dil → `en` → anahtarın kendisi.
 * - 78 dil paketle gelir (dünyanın en çok konuşulan ~80 dili; konuşucuların ~%90'ı).
 *   Kalan diller topluluk katkısıyla, aynı kalite eşiğiyle eklenir.
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
  { code: "en", native: "English", english: "English", dir: "ltr" },
  { code: "tr", native: "Türkçe", english: "Turkish", dir: "ltr" },
  { code: "af", native: "Afrikaans", english: "Afrikaans", dir: "ltr" },
  { code: "az", native: "Azərbaycan", english: "Azerbaijani", dir: "ltr" },
  { code: "id", native: "Bahasa Indonesia", english: "Indonesian", dir: "ltr" },
  { code: "ms", native: "Bahasa Melayu", english: "Malay", dir: "ltr" },
  { code: "bs", native: "Bosanski", english: "Bosnian", dir: "ltr" },
  { code: "ca", native: "Català", english: "Catalan", dir: "ltr" },
  { code: "ceb", native: "Cebuano", english: "Cebuano", dir: "ltr" },
  { code: "da", native: "Dansk", english: "Danish", dir: "ltr" },
  { code: "de", native: "Deutsch", english: "German", dir: "ltr" },
  { code: "et", native: "Eesti", english: "Estonian", dir: "ltr" },
  { code: "es", native: "Español", english: "Spanish", dir: "ltr" },
  { code: "eu", native: "Euskara", english: "Basque", dir: "ltr" },
  { code: "fil", native: "Filipino", english: "Filipino", dir: "ltr" },
  { code: "fr", native: "Français", english: "French", dir: "ltr" },
  { code: "gl", native: "Galego", english: "Galician", dir: "ltr" },
  { code: "ha", native: "Hausa", english: "Hausa", dir: "ltr" },
  { code: "hr", native: "Hrvatski", english: "Croatian", dir: "ltr" },
  { code: "ig", native: "Igbo", english: "Igbo", dir: "ltr" },
  { code: "rw", native: "Ikinyarwanda", english: "Kinyarwanda", dir: "ltr" },
  { code: "zu", native: "isiZulu", english: "Zulu", dir: "ltr" },
  { code: "it", native: "Italiano", english: "Italian", dir: "ltr" },
  { code: "sw", native: "Kiswahili", english: "Swahili", dir: "ltr" },
  { code: "ht", native: "Kreyòl ayisyen", english: "Haitian Creole", dir: "ltr" },
  { code: "lv", native: "Latviešu", english: "Latvian", dir: "ltr" },
  { code: "lt", native: "Lietuvių", english: "Lithuanian", dir: "ltr" },
  { code: "hu", native: "Magyar", english: "Hungarian", dir: "ltr" },
  { code: "mg", native: "Malagasy", english: "Malagasy", dir: "ltr" },
  { code: "nl", native: "Nederlands", english: "Dutch", dir: "ltr" },
  { code: "uz", native: "Oʻzbekcha", english: "Uzbek", dir: "ltr" },
  { code: "pl", native: "Polski", english: "Polish", dir: "ltr" },
  { code: "pt", native: "Português", english: "Portuguese", dir: "ltr" },
  { code: "ro", native: "Română", english: "Romanian", dir: "ltr" },
  { code: "sq", native: "Shqip", english: "Albanian", dir: "ltr" },
  { code: "sk", native: "Slovenčina", english: "Slovak", dir: "ltr" },
  { code: "sl", native: "Slovenščina", english: "Slovenian", dir: "ltr" },
  { code: "so", native: "Soomaali", english: "Somali", dir: "ltr" },
  { code: "fi", native: "Suomi", english: "Finnish", dir: "ltr" },
  { code: "sv", native: "Svenska", english: "Swedish", dir: "ltr" },
  { code: "vi", native: "Tiếng Việt", english: "Vietnamese", dir: "ltr" },
  { code: "yo", native: "Yorùbá", english: "Yoruba", dir: "ltr" },
  { code: "cs", native: "Čeština", english: "Czech", dir: "ltr" },
  { code: "el", native: "Ελληνικά", english: "Greek", dir: "ltr" },
  { code: "bg", native: "Български", english: "Bulgarian", dir: "ltr" },
  { code: "ky", native: "Кыргызча", english: "Kyrgyz", dir: "ltr" },
  { code: "mk", native: "Македонски", english: "Macedonian", dir: "ltr" },
  { code: "mn", native: "Монгол", english: "Mongolian", dir: "ltr" },
  { code: "ru", native: "Русский", english: "Russian", dir: "ltr" },
  { code: "sr", native: "Српски", english: "Serbian", dir: "ltr" },
  { code: "uk", native: "Українська", english: "Ukrainian", dir: "ltr" },
  { code: "kk", native: "Қазақша", english: "Kazakh", dir: "ltr" },
  { code: "hy", native: "Հայերեն", english: "Armenian", dir: "ltr" },
  { code: "he", native: "עברית", english: "Hebrew", dir: "rtl" },
  { code: "ur", native: "اردو", english: "Urdu", dir: "rtl" },
  { code: "ar", native: "العربية", english: "Arabic", dir: "rtl" },
  { code: "fa", native: "فارسی", english: "Persian", dir: "rtl" },
  { code: "ne", native: "नेपाली", english: "Nepali", dir: "ltr" },
  { code: "mr", native: "मराठी", english: "Marathi", dir: "ltr" },
  { code: "hi", native: "हिन्दी", english: "Hindi", dir: "ltr" },
  { code: "bn", native: "বাংলা", english: "Bengali", dir: "ltr" },
  { code: "pa", native: "ਪੰਜਾਬੀ", english: "Punjabi", dir: "ltr" },
  { code: "gu", native: "ગુજરાતી", english: "Gujarati", dir: "ltr" },
  { code: "or", native: "ଓଡ଼ିଆ", english: "Odia", dir: "ltr" },
  { code: "ta", native: "தமிழ்", english: "Tamil", dir: "ltr" },
  { code: "te", native: "తెలుగు", english: "Telugu", dir: "ltr" },
  { code: "kn", native: "ಕನ್ನಡ", english: "Kannada", dir: "ltr" },
  { code: "ml", native: "മലയാളം", english: "Malayalam", dir: "ltr" },
  { code: "si", native: "සිංහල", english: "Sinhala", dir: "ltr" },
  { code: "th", native: "ไทย", english: "Thai", dir: "ltr" },
  { code: "lo", native: "ລາວ", english: "Lao", dir: "ltr" },
  { code: "my", native: "မြန်မာ", english: "Myanmar (Burmese)", dir: "ltr" },
  { code: "ka", native: "ქართული", english: "Georgian", dir: "ltr" },
  { code: "am", native: "አማርኛ", english: "Amharic", dir: "ltr" },
  { code: "km", native: "ខ្មែរ", english: "Khmer", dir: "ltr" },
  { code: "zh", native: "中文（简体）", english: "Chinese (Simplified)", dir: "ltr" },
  { code: "ja", native: "日本語", english: "Japanese", dir: "ltr" },
  { code: "ko", native: "한국어", english: "Korean", dir: "ltr" },
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
  af: () => import("@/i18n/af.json"),
  az: () => import("@/i18n/az.json"),
  id: () => import("@/i18n/id.json"),
  ms: () => import("@/i18n/ms.json"),
  bs: () => import("@/i18n/bs.json"),
  ca: () => import("@/i18n/ca.json"),
  ceb: () => import("@/i18n/ceb.json"),
  da: () => import("@/i18n/da.json"),
  de: () => import("@/i18n/de.json"),
  et: () => import("@/i18n/et.json"),
  es: () => import("@/i18n/es.json"),
  eu: () => import("@/i18n/eu.json"),
  fil: () => import("@/i18n/fil.json"),
  fr: () => import("@/i18n/fr.json"),
  gl: () => import("@/i18n/gl.json"),
  ha: () => import("@/i18n/ha.json"),
  hr: () => import("@/i18n/hr.json"),
  ig: () => import("@/i18n/ig.json"),
  rw: () => import("@/i18n/rw.json"),
  zu: () => import("@/i18n/zu.json"),
  it: () => import("@/i18n/it.json"),
  sw: () => import("@/i18n/sw.json"),
  ht: () => import("@/i18n/ht.json"),
  lv: () => import("@/i18n/lv.json"),
  lt: () => import("@/i18n/lt.json"),
  hu: () => import("@/i18n/hu.json"),
  mg: () => import("@/i18n/mg.json"),
  nl: () => import("@/i18n/nl.json"),
  uz: () => import("@/i18n/uz.json"),
  pl: () => import("@/i18n/pl.json"),
  pt: () => import("@/i18n/pt.json"),
  ro: () => import("@/i18n/ro.json"),
  sq: () => import("@/i18n/sq.json"),
  sk: () => import("@/i18n/sk.json"),
  sl: () => import("@/i18n/sl.json"),
  so: () => import("@/i18n/so.json"),
  fi: () => import("@/i18n/fi.json"),
  sv: () => import("@/i18n/sv.json"),
  vi: () => import("@/i18n/vi.json"),
  yo: () => import("@/i18n/yo.json"),
  cs: () => import("@/i18n/cs.json"),
  el: () => import("@/i18n/el.json"),
  bg: () => import("@/i18n/bg.json"),
  ky: () => import("@/i18n/ky.json"),
  mk: () => import("@/i18n/mk.json"),
  mn: () => import("@/i18n/mn.json"),
  ru: () => import("@/i18n/ru.json"),
  sr: () => import("@/i18n/sr.json"),
  uk: () => import("@/i18n/uk.json"),
  kk: () => import("@/i18n/kk.json"),
  hy: () => import("@/i18n/hy.json"),
  he: () => import("@/i18n/he.json"),
  ur: () => import("@/i18n/ur.json"),
  ar: () => import("@/i18n/ar.json"),
  fa: () => import("@/i18n/fa.json"),
  ne: () => import("@/i18n/ne.json"),
  mr: () => import("@/i18n/mr.json"),
  hi: () => import("@/i18n/hi.json"),
  bn: () => import("@/i18n/bn.json"),
  pa: () => import("@/i18n/pa.json"),
  gu: () => import("@/i18n/gu.json"),
  or: () => import("@/i18n/or.json"),
  ta: () => import("@/i18n/ta.json"),
  te: () => import("@/i18n/te.json"),
  kn: () => import("@/i18n/kn.json"),
  ml: () => import("@/i18n/ml.json"),
  si: () => import("@/i18n/si.json"),
  th: () => import("@/i18n/th.json"),
  lo: () => import("@/i18n/lo.json"),
  my: () => import("@/i18n/my.json"),
  ka: () => import("@/i18n/ka.json"),
  am: () => import("@/i18n/am.json"),
  km: () => import("@/i18n/km.json"),
  zh: () => import("@/i18n/zh.json"),
  ja: () => import("@/i18n/ja.json"),
  ko: () => import("@/i18n/ko.json"),
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

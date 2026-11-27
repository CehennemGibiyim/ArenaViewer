"use client";

/**
 * Dil seçici (üst çubuk). Liste `LANGUAGES` kaydından gelir; arama ile filtrelenir.
 * Seçilen paket `setLocale` ile lazy yüklenir; yedek dil İngilizce'dir.
 * Not: uzun metinler henüz yalnız Türkçe'dir (i18n katmanı krom düzeyindedir);
 * uzun biçim çeviriler katkı ile gelir — bkz. docs/KILAVUZ_BAKIMI.md.
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

export default function LanguageMenu() {
  const { locale, languages, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Dışarı tıklayınca / Escape'te kapat
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? languages.filter((l) =>
        [l.code, l.native, l.english].some((s) => s.toLowerCase().includes(q)),
      )
    : languages;
  const current = languages.find((l) => l.code === locale);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="Dil seç"
        aria-label="Dil seç"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 rounded-md border border-[var(--t30)] bg-[var(--t10)] px-1.5 py-1 text-[10px] font-semibold text-[var(--sl300)] hover:bg-[var(--t26)]"
      >
        <span aria-hidden>🌐</span>
        <span className="font-mono uppercase">{locale}</span>
        <span aria-hidden className="text-[8px]">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("language.change")}
          className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-[var(--t37)] bg-[var(--t05)] shadow-2xl"
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ara… / Search…"
            aria-label="Dil ara"
            className="w-full border-b border-[var(--t30)] bg-[var(--t10)] px-2 py-1.5 text-[11px] text-[var(--sl200)] outline-none placeholder:text-[var(--sl500)]"
          />
          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.map((l) => {
              const selected = l.code === locale;
              return (
                <li key={l.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      void setLocale(l.code);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1 text-left text-[11px] hover:bg-[var(--t26)] ${selected ? "text-[var(--ac-cyan300)]" : "text-[var(--sl200)]"}`}
                  >
                    <span className="truncate">{l.native}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[9px] text-[var(--sl500)]">
                      <span>{l.english}</span>
                      <span className="font-mono uppercase">{l.code}</span>
                      {selected && <span aria-hidden>✓</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-[var(--sl500)]">Sonuç yok / No results</li>
            )}
          </ul>
          <p className="border-t border-[var(--t30)] px-2 py-1 text-[9px] leading-snug text-[var(--sl500)]">
            Seçilen dil yalnız arayüzü değiştirir; belgeler ve AI rapor metni Türkçe kalır. Yeni dil paketleri PR ile eklenir.
          </p>
        </div>
      )}
    </div>
  );
}

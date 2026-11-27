"use client";

/**
 * Dil seçici (üst çubuk). İki katman:
 *  1. Çevirisi hazır diller (`LANGUAGES`, 83) — arama ile filtrelenir.
 *  2. ISO 639-3 canlı dillerinin tümü (`catalog.json`, 7.027) — 2+ harf
 *     yazınca görünür; çevirisi olmayan dil arayüz **İngilizce yedeğiyle**
 *     açılır (dürüst davranış) ve çeviri katkısı bekler.
 * Seçilen paket `setLocale` ile lazy yüklenir; yedek dil İngilizce'dir.
 * Not: uzun metinler henüz yalnız Türkçe'dir (i18n katmanı krom düzeyindedir);
 * uzun biçim çeviriler katkı ile gelir — bkz. docs/CEVIRI_KATKI.md.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, loadCatalog, type CatalogEntry } from "@/lib/i18n";

const OTHERS_CAP = 100;

export default function LanguageMenu() {
  const { locale, languages, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Katalog yalnız seçici ilk açıldığında lazy yüklenir (~194 KB, bir kez).
  useEffect(() => {
    if (!open || catalog) return;
    let alive = true;
    void loadCatalog().then((c) => {
      if (alive) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, [open, catalog]);

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
  // Çevirisi hazır dillerin ISO karşılıkları (katalogda tekrar listelenmesin)
  const translatedCodes = useMemo(() => new Set(languages.map((l) => l.code)), [languages]);
  const otherTotal = useMemo(
    () =>
      catalog
        ? catalog.filter((e) => !translatedCodes.has(e.c) && !(e.p1 && translatedCodes.has(e.p1))).length
        : null,
    [catalog, translatedCodes],
  );
  // Diğer diller yalnız 2+ harfli aramada, en fazla OTHERS_CAP kayıtla
  const others = useMemo(() => {
    if (!catalog || q.length < 2) return [] as { code: string; n: string }[];
    const out: { code: string; n: string }[] = [];
    for (const e of catalog) {
      if (translatedCodes.has(e.c) || (e.p1 && translatedCodes.has(e.p1))) continue;
      if (
        e.n.toLowerCase().includes(q) ||
        e.c.startsWith(q) ||
        (e.p1 ?? "").startsWith(q)
      ) {
        out.push({ code: e.p1 ?? e.c, n: e.n });
        if (out.length >= OTHERS_CAP) break;
      }
    }
    return out;
  }, [catalog, q, translatedCodes]);

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
          className="absolute left-0 z-50 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--t37)] bg-[var(--t05)] shadow-2xl"
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ara… / Search… (ör. Kʼicheʼ, quc)"
            aria-label="Dil ara"
            className="w-full border-b border-[var(--t30)] bg-[var(--t10)] px-2 py-1.5 text-[11px] text-[var(--sl200)] outline-none placeholder:text-[var(--sl500)]"
          />
          <ul className="max-h-72 overflow-y-auto py-1">
            <li className="px-2 pt-1 text-[8.5px] font-semibold uppercase tracking-wide text-[var(--sl500)]">
              Çevirisi hazır ({languages.length})
            </li>
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
              <li className="px-3 py-1 text-[10px] text-[var(--sl500)]">Çevirisi hazır dillerde sonuç yok</li>
            )}

            {q.length >= 2 && (
              <>
                <li className="mt-1 border-t border-[var(--t30)] px-2 pt-1.5 text-[8.5px] font-semibold uppercase tracking-wide text-[var(--sl500)]">
                  Tüm canlı diller{otherTotal !== null ? ` (${otherTotal})` : ""} — arayüz İngilizce
                </li>
                {!catalog && (
                  <li className="px-3 py-1.5 text-[10px] text-[var(--sl500)]">Katalog yükleniyor…</li>
                )}
                {catalog &&
                  others.map((o) => {
                    const selected = locale === o.code;
                    return (
                      <li key={o.code}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            void setLocale(o.code);
                            setOpen(false);
                            setQuery("");
                          }}
                          className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1 text-left text-[11px] hover:bg-[var(--t26)] ${selected ? "text-[var(--ac-cyan300)]" : "text-[var(--sl200)]"}`}
                        >
                          <span className="truncate">{o.n}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-[9px] text-[var(--sl500)]">
                            <span className="rounded border border-[var(--t30)] px-1 text-[8px] uppercase">EN UI</span>
                            <span className="font-mono uppercase">{o.code}</span>
                            {selected && <span aria-hidden>✓</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                {catalog && others.length === 0 && (
                  <li className="px-3 py-1.5 text-[10px] text-[var(--sl500)]">Sonuç yok / No results</li>
                )}
                {catalog && others.length >= OTHERS_CAP && (
                  <li className="px-3 py-1 text-[9px] text-[var(--sl500)]">İlk {OTHERS_CAP} kayıt — aramayı daraltın</li>
                )}
              </>
            )}
            {q.length < 2 && otherTotal !== null && (
              <li className="mt-1 border-t border-[var(--t30)] px-3 py-1.5 text-[9px] leading-snug text-[var(--sl500)]">
                + {otherTotal} yaşayan dil daha — aramak için en az 2 harf yazın (ISO 639-3)
              </li>
            )}
          </ul>
          <p className="border-t border-[var(--t30)] px-2 py-1 text-[9px] leading-snug text-[var(--sl500)]">
            Çevirisi olmayan dil arayüz İngilizce açılır (çeviri katkısı bekler). Seçim yalnız arayüzü değiştirir;
            belgeler ve AI rapor metni Türkçe kalır. Yeni dil: PR + <span className="font-mono">npm run test:i18n</span>
          </p>
        </div>
      )}
    </div>
  );
}

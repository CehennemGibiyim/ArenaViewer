"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { SharedImagePayload } from "@/lib/share";

/**
 * Süreli **görüntü** paylaşımı (f-share): filigranlı, salt okunur, indirmesiz görünüm.
 *
 * Kareler `/api/share/{token}/image/{n}` ucundan `image/jpeg` olarak gelir; hasta
 * kimliği yakılmamış anonim kesitlerdir. Filigran hem görüntünün üstünde hem
 * yazdırma çıktısında görünür. Bağlantı kapatılır/süresi dolarsa görüntüler
 * sunucuda silinir ve bu sayfa 404 döner.
 */
export default function SharedImageView({ payload, token }: { payload: SharedImagePayload; token: string }) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const wm = payload.watermark || `${token.slice(0, 8).toUpperCase()} · ${t("share.image")}`;
  const fmt = (v: string | Date) => new Date(v).toLocaleString();
  const frame = payload.frames[active];

  return (
    <div className="relative min-h-dvh bg-[var(--t05)] text-[var(--sl200)] print:bg-white">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden print:fixed">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="absolute whitespace-nowrap font-mono text-[34px] font-bold uppercase tracking-widest text-cyan-500/[0.07]"
            style={{ top: `${i * 8}%`, left: "-10%", transform: "rotate(-28deg)" }}
          >
            {Array.from({ length: 4 }).map((__, j) => <span key={j} className="mr-10">{wm}</span>)}
          </div>
        ))}
      </div>

      <header className="relative z-10 border-b border-cyan-500/30 bg-[var(--t47)]/90 px-4 py-2.5 print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <span className="font-mono text-xs font-black tracking-[0.2em] text-[var(--sl100)]">
            ATIK<span className="text-[var(--ac-cyan400)]">VIEWER</span>
          </span>
          <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10.5px] font-bold text-[var(--ac-amber300)]">
            {t("share.image")} · {t("share.readOnly")}
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl space-y-4 px-4 py-5 print:max-w-none">
        <section className="rounded-lg border border-[var(--t30)] bg-[var(--t47)]/95 p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--sl300)]">
            <span><span className="text-[var(--sl500)]">{t("share.series")}:</span> <strong>{payload.label}</strong></span>
            <span><span className="text-[var(--sl500)]">{t("share.modality")}:</span> {payload.modality}</span>
            <span><span className="text-[var(--sl500)]">{t("share.studyDate")}:</span> {payload.studyDate || "—"}</span>
            <span><span className="text-[var(--sl500)]">{t("share.frames")}:</span> {payload.frames.length}</span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--sl500)]">
            {t("share.createdAt")}: {fmt(payload.createdAt)} ·{" "}
            <span className="font-bold text-[var(--ac-amber300)]">{t("share.expiresAt")}: {fmt(payload.expiresAt)}</span>
          </div>
        </section>

        <section className="rounded-lg border border-[var(--t30)] bg-black/40 p-3">
          <div className="relative">
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/share/${token}/image/${frame.n}`}
                alt={`${payload.label} — ${t("share.frame")} ${frame.n}`}
                className="mx-auto h-auto max-h-[70vh] w-auto max-w-full select-none object-contain"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
              />
            ) : (
              <p className="py-10 text-center text-xs text-[var(--sl400)]">{t("share.noFrames")}</p>
            )}
            <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="-rotate-[24deg] font-mono text-lg font-black uppercase tracking-widest text-white/25">
                {wm}
              </span>
            </div>
          </div>

          {payload.frames.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
              <button
                type="button"
                onClick={() => setActive((i) => Math.max(0, i - 1))}
                disabled={active === 0}
                className="cursor-pointer rounded border border-[var(--sl500)]/50 px-2.5 py-1 text-xs font-bold text-[var(--sl200)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                ←
              </button>
              <span className="font-mono text-[11px] text-[var(--sl400)]">
                {t("share.frame")} {active + 1} / {payload.frames.length} · {t("share.slice")} {frame ? frame.slice + 1 : "—"}
              </span>
              <button
                type="button"
                onClick={() => setActive((i) => Math.min(payload.frames.length - 1, i + 1))}
                disabled={active === payload.frames.length - 1}
                className="cursor-pointer rounded border border-[var(--sl500)]/50 px-2.5 py-1 text-xs font-bold text-[var(--sl200)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                →
              </button>
              <input
                type="range"
                min={0}
                max={payload.frames.length - 1}
                value={active}
                onChange={(e) => setActive(Number(e.target.value))}
                aria-label={t("share.frame")}
                className="ml-auto w-40"
              />
            </div>
          )}
        </section>

        <footer className="pb-6 pt-1 text-center text-[11px] leading-relaxed text-[var(--sl500)]">
          {payload.note}
        </footer>
      </main>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { SeriesData } from "@/lib/types";
import { renderSliceCanvas } from "@/lib/exportMedia";
import { apiFetch } from "@/lib/csrfClient";
import { useI18n } from "@/lib/i18n";
import { SHARE_IMAGE_MAX_SIDE, SHARE_IMAGE_QUALITY, formatBytes, sampleSelection } from "@/lib/shareImage";

const TTLS = [24, 72, 168, 720] as const;

const ttlLabel = (h: number) => (h >= 24 ? `${h / 24} gün` : `${h} saat`);

/**
 * Görüntü paylaşımı (f-share): seçilen kesitleri **anonim JPEG** olarak süreli
 * bağlantıyla paylaşır. Ham DICOM gönderilmez; hasta kimliği görüntüye yakılmaz;
 * filigran + süre + erişim kaydı sunucudadır. Karar metni Türkçe dışındaki
 * arayüzlerde de görünür — bu bir güvenlik uyarısıdır, süsleme değildir.
 */
export default function ShareImageDialog({
  series, wl, ww, invert, slice, onClose, toast,
}: {
  series: SeriesData;
  wl: number; ww: number; invert: boolean; slice: number;
  onClose: () => void;
  toast: (m: string, ms?: number) => void;
}) {
  const { t } = useI18n();
  const n = series.slices.length;
  const [from, setFrom] = useState(Math.max(1, slice + 1));
  const [to, setTo] = useState(Math.max(1, slice + 1));
  const [ttl, setTtl] = useState<number>(24);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ url: string; expiresAt: string; frames: number; totalLabel: string } | null>(null);
  const [error, setError] = useState("");

  // Geniş aralık seyreltilir (her n. kesit) — kullanıcı diyalogda kaç kesit gideceğini görür.
  const plan = useMemo(() => sampleSelection(n, from, to), [n, from, to]);

  const renderFrame = (s: number): { b64: string; width: number; height: number } => {
    const canvas = renderSliceCanvas(series, s, { wl, ww, invert, maxSide: SHARE_IMAGE_MAX_SIDE });
    const url = canvas.toDataURL("image/jpeg", SHARE_IMAGE_QUALITY);
    const b64 = url.slice(url.indexOf(",") + 1);
    return { b64, width: canvas.width, height: canvas.height };
  };

  const create = async () => {
    if (plan.error || plan.slices.length === 0) { setError(plan.error || t("share.noFrames")); return; }
    setBusy(true); setError(""); setResult(null);
    try {
      const frames: { slice: number; width: number; height: number; b64: string }[] = [];
      for (let i = 0; i < plan.slices.length; i++) {
        setProgress({ done: i, total: plan.slices.length });
        const f = renderFrame(plan.slices[i]);
        frames.push({ slice: plan.slices[i], ...f });
      }
      setProgress({ done: plan.slices.length, total: plan.slices.length });
      const r = await apiFetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "image",
          ttlHours: ttl,
          // Hasta kimliği BİLİNÇLİ olarak gönderilmez (sunucu da reddeder).
          label: series.description,
          modality: series.modality,
          studyDate: series.studyDate,
          frames,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; expiresAt?: string; frames?: number; totalLabel?: string; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult({ url: d.url!, expiresAt: d.expiresAt!, frames: d.frames ?? frames.length, totalLabel: d.totalLabel ?? formatBytes(0) });
      toast(t("share.created"), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    const abs = `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(abs);
      toast(t("share.copied"), 3000);
    } catch {
      window.prompt(t("share.copyManual"), abs);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={t("share.title")}>
      <div className="w-[26rem] max-w-full rounded-xl border border-[var(--t39)] bg-[var(--t05)] p-4 text-xs text-[var(--sl200)] shadow-2xl">
        <div className="mb-3 text-sm font-bold text-[var(--ac-cyan300)]">{t("share.title")}</div>

        {result ? (
          <div className="space-y-3">
            <p className="text-[11.5px] leading-relaxed text-[var(--sl300)]">
              {t("share.createdBody", { frames: result.frames, size: result.totalLabel })}
            </p>
            <div className="rounded border border-[var(--t30)] bg-[var(--t10)] px-2 py-1.5 font-mono text-[11px] break-all text-[var(--sl200)]">{result.url}</div>
            <p className="text-[10.5px] text-[var(--sl500)]">
              {t("share.expiresAt")}: {new Date(result.expiresAt).toLocaleString()}
            </p>
            <div className="flex justify-end gap-2">
              <button className="cursor-pointer rounded border border-[var(--t39)] px-3 py-1" onClick={() => void copy(result.url)}>{t("share.copy")}</button>
              <a className="cursor-pointer rounded bg-cyan-500 px-3 py-1 font-bold text-black" href={result.url} target="_blank" rel="noreferrer">{t("share.open")}</a>
              <button className="cursor-pointer rounded border border-[var(--t39)] px-3 py-1" onClick={onClose}>{t("common.close")}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label className="flex items-center justify-between">{t("share.from")}
                <input aria-label={t("share.from")} type="number" min={1} max={n} value={from} onChange={(e) => setFrom(Number(e.target.value))} className="w-20 rounded border border-[var(--t30)] bg-[var(--t10)] px-1 py-0.5" />
              </label>
              <label className="flex items-center justify-between">{t("share.to")}
                <input aria-label={t("share.to")} type="number" min={1} max={n} value={to} onChange={(e) => setTo(Number(e.target.value))} className="w-20 rounded border border-[var(--t30)] bg-[var(--t10)] px-1 py-0.5" />
              </label>
              <label className="flex items-center justify-between">{t("share.ttl")}
                <select aria-label={t("share.ttl")} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="w-28 rounded border border-[var(--t30)] bg-[var(--t10)] px-1 py-0.5">
                  {TTLS.map((h) => <option key={h} value={h}>{ttlLabel(h)}</option>)}
                </select>
              </label>
              <div className="text-[10.5px] leading-relaxed text-[var(--sl500)]">
                {plan.error
                  ? <span className="text-[var(--ac-rose300)]">{plan.error}</span>
                  : t("share.plan", { n: plan.slices.length, stride: plan.stride ?? 1 })}
              </div>
              <div className="rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 text-[10.5px] leading-relaxed text-[var(--ac-amber200)]">
                {t("share.warning")}
              </div>
              {progress && (
                <div className="h-2 overflow-hidden rounded bg-[var(--t25)]">
                  <div className="h-full bg-cyan-400" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                </div>
              )}
              {error && <div className="text-[11px] text-[var(--ac-rose300)]">{error}</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="cursor-pointer rounded border border-[var(--t39)] px-3 py-1" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
              <button className="cursor-pointer rounded bg-cyan-500 px-3 py-1 font-bold text-black disabled:opacity-50" disabled={busy || !!plan.error} onClick={() => void create()}>
                {busy ? (progress ? `${progress.done}/${progress.total}` : "…") : t("share.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

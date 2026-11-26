"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/csrfClient";

/**
 * Yerel derin AI worker durumu — canlı.
 *
 * GET /api/deep-scan → ai-worker/server.py (127.0.0.1:8787) sağlık ucuna köprü.
 * Burada yalnız DURUM okunur; hasta verisi bu bileşenden geçmez.
 */

interface WorkerHealth {
  ok?: boolean;
  worker?: "up" | "down";
  hint?: string;
  modelLoaded?: boolean;
  modelFile?: boolean;
  roi?: number[];
  brain?: { modelFile?: boolean; modelLoaded?: boolean };
  knee?: { modelFile?: boolean; modelLoaded?: boolean };
}

const Badge = ({ on, label }: { on: boolean | null; label: string }) => (
  <span
    className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
      on === null
        ? "bg-slate-500/20 text-slate-300"
        : on
          ? "bg-emerald-500/20 text-emerald-200"
          : "bg-amber-500/20 text-amber-200"
    }`}
  >
    {label}: {on === null ? "?" : on ? "HAZIR" : "YOK"}
  </span>
);

export default function AiWorkerStatus() {
  const [data, setData] = useState<WorkerHealth | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "down">("loading");
  const [stamp, setStamp] = useState<string>("");
  /** "Yenile" düğmesi effect içindeki tick'i çağırır (ilk yüklemeden bağımsız). */
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Not: effect gövdesinde senkron setState çağrısı yapmak
    // react-hooks/set-state-in-effect kuralını tetikler (ve gereksiz yeniden
    // render üretir). Bu yüzden durum güncellemeleri yalnızca fetch yanıtından
    // sonra, async akışın içinde yapılır; ilk sorgu da zamanlayıcı içinde başlar.
    const tick = async () => {
      try {
        const r = await apiFetch("/api/deep-scan", { cache: "no-store" });
        const j = (await r.json()) as WorkerHealth;
        setData(j);
        setState(j.worker === "up" ? "ok" : "down");
      } catch {
        setData(null);
        setState("down");
      } finally {
        setStamp(new Date().toLocaleTimeString("tr-TR"));
      }
    };
    reloadRef.current = tick;
    const first = window.setTimeout(() => void tick(), 0);
    const t = window.setInterval(() => void tick(), 15000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, []);

  const up = state === "ok";

  return (
    <div className="rounded-xl border border-[#1a2230] bg-[#0b0f16] p-4" data-testid="ai-worker-status">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            state === "loading" ? "animate-pulse bg-slate-400" : up ? "bg-emerald-400" : "bg-amber-400"
          }`}
          aria-hidden
        />
        <h3 className="text-sm font-black text-slate-100">Yerel derin AI worker</h3>
        <span
          className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${
            up ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-200" : "border-amber-400/50 bg-amber-500/10 text-amber-200"
          }`}
        >
          {state === "loading" ? "sorgulanıyor…" : up ? "127.0.0.1:8787 · çalışıyor" : "kapalı"}
        </span>
        <button
          onClick={() => reloadRef.current()}
          className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[#161e2b]"
        >
          ↻ Yenile
        </button>
        {stamp && <span className="font-mono text-[10px] text-slate-600">son sorgu {stamp}</span>}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Badge on={up ? data?.modelFile ?? null : null} label="Akciğer modeli dosyası (MONAI · LUNA16)" />
        <Badge on={up ? data?.modelLoaded ?? null : null} label="Akciğer modeli bellekte" />
        <Badge on={up ? data?.brain?.modelFile ?? null : null} label="Beyin modeli dosyası (ICH · MIT/RSNA)" />
        <Badge on={up ? data?.brain?.modelLoaded ?? null : null} label="Beyin modeli bellekte" />
        <Badge on={up ? data?.knee?.modelFile ?? null : null} label="Diz MR modeli dosyası (nnU-Net · MIT)" />
      </div>

      <div className="mt-3 rounded-lg border border-[#1a2230] bg-[#0a0e15] p-3 font-mono text-[11px] leading-relaxed text-slate-400">
        {up ? (
          <>
            <div>
              <span className="text-slate-500">$ </span>python ai-worker/server.py
            </div>
            {data?.roi && <div className="text-slate-500"># ROI (Z,Y,X): {data.roi.join("×")}</div>}
            <div className="text-emerald-300">
              ✓ Çıkarım bu makinede çalışıyor — hasta verisi dışarı çıkmaz, ücretli servis kullanılmaz.
            </div>
            <div className="text-slate-500">
              Uçlar: POST /api/deep-scan?protocol=ct-chest | ct-head (gzip int16 HU) · cxr (gzip float32) · knee (gzip int16, T2 diz MR)
            </div>
            <div className="text-slate-500">
              Diz MR segmentasyonu (MIT, ≈1,6 GB): .venv/bin/python ai-worker/setup_knee_model.py
            </div>
          </>
        ) : (
          <>
            <div className="text-amber-300">
              ⚠ Worker kapalı — uygulama kural tabanlı motora düşer ve bu durum panelde açıkça yazılır.
              <strong className="text-slate-200"> Sahte bulgu üretilmez.</strong>
            </div>
            <div className="mt-1 text-slate-500">{data?.hint ?? "ai-worker başlatılmalı (127.0.0.1:8787)"}</div>
            <div className="mt-2 text-cyan-300">Kurulum (ücretsiz, ≈231 MB model):</div>
            <div className="text-slate-300">python -m venv .venv</div>
            <div className="text-slate-300">.venv/bin/pip install -r ai-worker/requirements.txt</div>
            <div className="text-slate-300">.venv/bin/python ai-worker/setup_model.py</div>
            <div className="text-slate-300">.venv/bin/python ai-worker/server.py</div>
          </>
        )}
      </div>

      <p className="mt-2.5 text-[10px] leading-relaxed text-slate-500">
        Çıkarım <strong className="text-slate-400">yerel ve ücretsizdir</strong>; harici bulut AI API’si, API anahtarı veya
        abonelik <strong className="text-slate-400">kullanılmaz</strong>. Model kartı, sınırlılıklar ve doğrulama durumu
        görüntüleyicinin AI panelinde ve rapor çıktısında yer alır.{" "}
        <strong className="text-amber-300">Tüm bulgular radyoloji uzmanı onayı gerektirir.</strong>
      </p>
    </div>
  );
}

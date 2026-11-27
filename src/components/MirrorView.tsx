"use client";
/**
 * İkinci ekran alıcısı (v-multimon).
 *
 * Ana pencereden `BroadcastChannel` ile yalnız seri künyesi, görüntülenen kesit
 * pikselleri ve görünüm durumu gelir. Son `MIRROR_CACHE_MAX` kesit bellekte
 * tutulur; eksik kesitler paylaşılan sıfır tamponuyla çizilir. Veri sunucuya
 * yazılmaz; bu pencere salt izlemedir.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Viewport from "./Viewport";
import type { SeriesData } from "@/lib/types";
import {
  buildSlices, MIRROR_CHANNEL, putSlice, readMirrorMessage, stateLabel,
  type MirrorMeta, type MirrorPixels, type MirrorState,
} from "@/lib/mirror";

const INITIAL: MirrorState = { slice: 0, wl: 40, ww: 80, invert: false, zoom: 1, pan: { x: 0, y: 0 } };
type Status = "waiting" | "live" | "unsupported";

export default function MirrorView() {
  const [meta, setMeta] = useState<MirrorMeta | null>(null);
  const [state, setState] = useState<MirrorState>(INITIAL);
  const [received, setReceived] = useState<Map<number, { pixels: MirrorPixels; rgba?: Uint32Array }>>(new Map());
  const [status, setStatus] = useState<Status>("waiting");
  const [lastAt, setLastAt] = useState("");

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      void (async () => setStatus("unsupported"))();
      return;
    }
    const ch = new BroadcastChannel(MIRROR_CHANNEL);
    let timer: ReturnType<typeof setTimeout> | null = null;
    ch.onmessage = (ev: MessageEvent) => {
      const m = readMirrorMessage(ev.data);
      if (!m) return;
      if (m.type === "bye") {
        setStatus("waiting");
        setMeta(null);
        setReceived(new Map());
        return;
      }
      if (m.type === "series") {
        setMeta(m.series);
        setState(m.state);
        setReceived(new Map());
      } else if (m.type === "slice") {
        setReceived((prev) => {
          const next = new Map(prev);
          putSlice(next, m.index, m.pixels, m.rgba);
          return next;
        });
      } else {
        setState(m.state);
      }
      setStatus("live");
      setLastAt(new Date().toLocaleTimeString("tr-TR"));
      if (timer) clearTimeout(timer);
      // 15 sn mesaj gelmezse yayın koptu say (ana pencere kapandı/dondu).
      timer = setTimeout(() => setStatus("waiting"), 15000);
    };
    return () => { ch.close(); if (timer) clearTimeout(timer); };
  }, []);

  // Alıcı salt izleme: geri çağrılar bilinçli olarak boş.
  const noop = useCallback(() => {}, []);

  const series = useMemo<SeriesData | null>(() => {
    if (!meta) return null;
    // Yayın künyesi `SeriesData`nın görüntüleme alt kümesidir; eksik alanlar
    // yalnız etiket/ölçüm içindir ve boş bırakılır.
    return { ...meta, slices: buildSlices(meta, received) } as unknown as SeriesData;
  }, [meta, received]);

  const sliceReady = received.has(state.slice);

  return (
    <main className="flex h-screen w-screen flex-col bg-[var(--t01)] text-[var(--sl200)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--t25)] px-3 py-1.5 text-[11px]">
        <span className="font-bold text-[var(--ac-cyan200)]">İKİNCİ EKRAN</span>
        <span className={`rounded px-1.5 py-0.5 font-mono ${status === "live" ? "bg-emerald-500/15 text-[var(--ac-emerald300)]" : "bg-amber-500/15 text-[var(--ac-amber300)]"}`}>
          {status === "live" ? "● canlı" : status === "unsupported" ? "desteklenmiyor" : "⏳ yayın bekleniyor"}
        </span>
        {status === "live" && <span className="min-w-0 truncate font-mono text-[var(--sl400)]">{stateLabel(state, meta, meta?.sliceCount)}</span>}
        {status === "live" && !sliceReady && <span className="rounded bg-[var(--sl500)]/20 px-1.5 py-0.5 text-[var(--sl300)]">kesit alınıyor…</span>}
        {lastAt && <span className="ml-auto font-mono text-[var(--sl500)]">son mesaj {lastAt}</span>}
      </header>
      <div className="relative min-h-0 flex-1">
        {series ? (
          <Viewport
            series={series}
            slice={state.slice}
            wl={state.wl}
            ww={state.ww}
            invert={state.invert}
            zoom={state.zoom}
            pan={state.pan}
            tool="pan"
            rotation={0}
            flipH={false}
            flipV={false}
            pxMm={series.pixelSpacing}
            onSlice={noop}
            onWL={noop}
            onZoom={noop}
            onPan={noop}
            readOnly
            label="AYNA · SALT İZLEME"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--sl400)]">
            <p className="text-base font-bold text-[var(--sl200)]">
              {status === "unsupported" ? "Bu tarayıcı ikinci ekran yayınını desteklemiyor." : "Ana pencereden yayın bekleniyor…"}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-[var(--sl500)]">
              Ana pencerede <b>İkinci ekran</b> düğmesine basın. Görüntülenen kesit, WL/WW ve yakınlaştırma canlı aktarılır;
              veri sunucuya gitmez. Bu pencereyi başka bir monitöre sürükleyerek çoklu monitör kullanabilirsiniz.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

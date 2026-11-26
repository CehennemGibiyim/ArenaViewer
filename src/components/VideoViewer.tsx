"use client";

/**
 * DICOM video oynatıcı (f-objects).
 *
 * Kapsüllenmiş video payload'u Blob URL'ye çevrilip <video> öğesinde oynatılır.
 * Oynatma codec'i tarayıcıya bağlıdır: MPEG-2 (video/mpeg) ve HEVC çoğu modern
 * tarayıcıda OYNATILAMAZ — bu durumda kullanıcıya dürüst bir hata gösterilir ve
 * payload'u indirip yerel oynatıcıda açması önerilir (indirme düğmesi codec'ten
 * bağımsız çalışır).
 */
import { useEffect, useMemo, useState } from "react";
import type { DicomVideoSequence } from "@/lib/types";
import { videoFileExtension } from "@/lib/dicomVideo";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function VideoViewer({ video }: { video: DicomVideoSequence }) {
  // Blob URL'si render sırasında türetilir (video girdisi değişirse yenisi üretilir);
  // effect yalnızca ESKİ url'yi serbest bırakır — setState içermez.
  const url = useMemo(
    () => URL.createObjectURL(new Blob([video.payload.slice()], { type: video.mimeType })),
    [video],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // Hata url ile ilişkilendirilir; yeni video → eski hata otomatik düşer.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === url;

  const fileName = `${(video.title || "dicom-video").replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 80)}${videoFileExtension(video.mimeType)}`;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#07090c] p-4">
      <div className="flex max-w-full flex-col items-center gap-3">
        {url && !failed ? (
          <video
            key={url}
            src={url}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailedFor(url)}
            className="max-h-[calc(100vh-220px)] max-w-full rounded border border-[#232e40] bg-black"
          />
        ) : failed ? (
          <div role="alert" className="max-w-md rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-center">
            <p className="text-sm font-bold text-amber-300">Bu tarayıcı bu videoyu çözemiyor</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
              {video.codecLabel} payload&apos;u geçerli bir DICOM nesnesidir, ancak tarayıcınız <code className="text-amber-200">{video.mimeType}</code> codec&apos;ini oynatamadı (MPEG-2 ve HEVC masaüstü tarayıcılarda genellikle desteklenmez).
              Payload&apos;u indirip cihazınızdaki bir medya oynatıcısında (VLC vb.) açabilirsiniz.
            </p>
          </div>
        ) : (
          <div className="text-sm text-slate-400">Video hazırlanıyor…</div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3 font-mono text-[10.5px] text-slate-400">
          <span className="rounded bg-[#111826] px-2 py-1 text-cyan-300">{video.codecLabel}</span>
          {video.totalFrames > 0 && <span>{video.totalFrames} kare</span>}
          {video.frameRate > 0 && <span>{video.frameRate} fps</span>}
          <span>{formatBytes(video.payload.length)}</span>
          {url && (
            <a
              href={url}
              download={fileName}
              className="cursor-pointer rounded bg-cyan-500/15 px-2 py-1 font-bold text-cyan-300 ring-1 ring-cyan-400/40 hover:bg-cyan-500/25"
            >
              ↓ Payload&apos;u indir ({videoFileExtension(video.mimeType).slice(1)})
            </a>
          )}
        </div>
        <p className="max-w-md text-center text-[9.5px] text-slate-600">
          Video tarayıcı codec&apos;iyle oynatılır; tanısal amaçla azami dikkatle değerlendirin. Oynatma garanti edilmez — desteklenmeyen codec&apos;lerde indirme düğmesini kullanın.
        </p>
      </div>
    </div>
  );
}

"use client";

import type { GspsImportResult } from "@/lib/gspsImport";
import { useEscapeKey } from "@/lib/useEscapeKey";

export interface GspsImportOutcome extends GspsImportResult {
  label: string;
  /** Bu içe aktarmada eklenen ölçüm sayısı */
  added: number;
  /** Zaten aynı geometriyle var olduğu için eklenmeyen sayı */
  duplicates: number;
}

/**
 * PR/GSPS ölçüm içe aktarma sonucu.
 * Sessiz başarı yok: kaç ölçüm alındı, kaçı atlandı ve **neden** atlandı yazılır.
 */
export default function GspsImportDialog({ outcome, onClose }: { outcome: GspsImportOutcome; onClose: () => void }) {
  useEscapeKey(onClose);
  const { label, added, duplicates, graphics, skipped, texts, notes } = outcome;
  const failed = added === 0;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="PR ölçüm içe aktarma sonucu">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--t30)] bg-[var(--t02)] p-5 shadow-2xl">
        <h2 className="text-sm font-bold text-[var(--sl100)]">
          {failed ? "PR ölçümü alınamadı" : `${added} GSPS ölçümü çalışmaya alındı`}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-[var(--sl500)]">{label}</p>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--sl300)]">
          <dt>Belgedeki grafik</dt><dd>{graphics}</dd>
          <dt>Eklenen</dt><dd className={added > 0 ? "text-[var(--ac-emerald300)]" : ""}>{added}</dd>
          <dt>Zaten var (kopya)</dt><dd>{duplicates}</dd>
          <dt>Atlanan</dt><dd className={skipped > 0 ? "text-[var(--ac-amber300)]" : ""}>{skipped}</dd>
          <dt>Metin nesnesi</dt><dd>{texts} (ölçüme çevrilmez)</dd>
        </dl>

        {notes.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-[var(--sl400)]">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}

        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-[var(--ac-amber200)]">
          Ölçümler hekim onayı olmadan rapora girmez. GSPS ROI istatistikleri (ort/SS/min/maks) taşımaz;
          içe aktarılan ölçümlerin piksel istatistiği boştur ve kaydedilene kadar raporda görünmez.
        </p>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full cursor-pointer rounded-lg border border-[var(--t30)] bg-[var(--t10)] px-3 py-2 text-xs font-semibold text-[var(--sl200)] hover:bg-[var(--t15)]"
        >
          Kapat
        </button>
      </div>
    </div>
  );
}

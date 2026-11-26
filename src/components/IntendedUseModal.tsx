"use client";

/**
 * "Hakkında & amaçlanan kullanım" paneli (t-disclaimer).
 *
 * Metin tek kaynaktan gelir (`src/lib/intendedUse.ts`); burada yalnız gösterilir ve
 * panoya kopyalanabilir. Amaç, ürünün ne olmadığını (tıbbi cihaz değil, klinik
 * karar için kullanılamaz) tek ekranda eksiksiz göstermek.
 */
import Link from "next/link";
import { INTENDED_USE, intendedUseText, SHORT_DISCLAIMER, versionLine } from "@/lib/intendedUse";
import { useEscapeKey } from "@/lib/useEscapeKey";

/** Başlık + madde listesi (bileşen dışında tanımlı: render sırasında oluşturulmaz). */
function Section({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <ul className={`space-y-1 pl-4 text-[11.5px] ${tone}`}>
        {items.map((i) => <li key={i} className="list-disc">{i}</li>)}
      </ul>
    </div>
  );
}

export default function IntendedUseModal({ onClose }: { onClose: () => void }) {
  useEscapeKey(onClose);
  const copy = () => {
    void navigator.clipboard?.writeText(intendedUseText()).catch(() => { /* pano kapalı */ });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      data-testid="intended-use"
      role="dialog"
      aria-modal="true"
      aria-label="Hakkında ve amaçlanan kullanım"
    >
      <div className="max-h-[88vh] w-[46rem] max-w-full overflow-y-auto rounded-lg border border-[#2a3547] bg-[#0f1620] p-4 text-slate-200 shadow-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{INTENDED_USE.product} — Hakkında & amaçlanan kullanım</h2>
          <div className="flex items-center gap-2">
            <button onClick={copy} className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 text-[11px] hover:bg-[#1a2330]" title="Metni panoya kopyala">
              Kopyala
            </button>
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 text-[11px] hover:bg-[#1a2330]">✕</button>
          </div>
        </div>

        <p className="mb-3 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-[11.5px] text-amber-200">
          {SHORT_DISCLAIMER} · sürüm {versionLine()}
        </p>

        <p className="mb-3 text-[11.5px] leading-relaxed text-slate-300">{INTENDED_USE.statement}</p>

        <div className="space-y-3">
          <Section title="Kullanıcılar" items={INTENDED_USE.users} tone="text-slate-300" />
          <Section title="Amaçlanan kullanım" items={INTENDED_USE.indications} tone="text-slate-300" />
          <Section title="Amaçlanmayan kullanımlar" items={INTENDED_USE.contraindications} tone="text-rose-200" />
          <Section title="Bilinen sınırlar" items={INTENDED_USE.limits} tone="text-amber-200/90" />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#22303f] pt-2 text-[10.5px] text-slate-500">
          <span>{INTENDED_USE.regulatory}</span>
          <Link href="/yardim" className="shrink-0 font-bold text-cyan-400 hover:underline">Yardım / S.S.S. →</Link>
        </div>
      </div>
    </div>
  );
}

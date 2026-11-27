"use client";

/**
 * Rapor metnindeki cümleleri bulguya bağlı olarak listeler (r-link).
 *
 * Her satır bir cümle; bağlı cümleler tıklanabilir düğme olup ilgili kesiti açar ve
 * bulguyu vurgular. Bağlanamayan cümleler soluk gösterilir — uydurma bağ kurulmaz.
 */
import { useMemo } from "react";
import { linkCoverage, linkSentences, type LinkTarget } from "@/lib/sentenceLinks";

interface Props {
  text: string;
  findings: LinkTarget[];
  onGoto: (findingId: string, sliceNumber: number) => void;
  /** Yazdırma sırasında gizlemek için. */
  printHidden?: boolean;
}

export default function LinkedFindingsText({ text, findings, onGoto, printHidden = true }: Props) {
  const links = useMemo(() => linkSentences(text, findings), [text, findings]);
  const coverage = useMemo(() => linkCoverage(links), [links]);
  if (!text?.trim()) return null;

  return (
    <div className={`rounded border border-[var(--t35)] bg-[var(--t11)] p-2 ${printHidden ? "print:hidden" : ""}`} data-testid="linked-sentences">
      <div className="mb-1 flex items-center justify-between text-[10.5px] text-[var(--sl400)]">
        <span>
          <b className="text-[var(--sl300)]">Cümle → bulgu bağlantısı</b> · {coverage.linked}/{coverage.total} cümle bağlı
          {coverage.total > 0 ? ` (%${Math.round(coverage.ratio * 100)})` : ""}
        </span>
        <span className="text-[9.5px] text-[var(--sl500)]">cümleye tıkla: kesit açılır, bulgu vurgulanır</span>
      </div>
      <ul className="space-y-1">
        {links.map((l) => {
          const label = l.findingId ? findings.find((f) => f.id === l.findingId)?.label : null;
          const clickable = l.findingId !== null && l.sliceNumber !== null;
          return (
            <li key={l.index}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onGoto(l.findingId as string, l.sliceNumber as number)}
                  title={`Kesit ${l.sliceNumber} · ${l.matchedBy === "kesit" ? "metindeki kesit numarası" : "etiket eşleşmesi"}`}
                  className="w-full cursor-pointer rounded border border-cyan-400/30 bg-cyan-400/5 px-1.5 py-1 text-left text-[11px] text-[var(--sl200)] hover:bg-cyan-400/10"
                >
                  <span className="mr-1 rounded bg-cyan-400/20 px-1 text-[9.5px] font-bold text-[var(--ac-cyan100)]">
                    Kesit {l.sliceNumber}
                  </span>
                  {label && <span className="mr-1 text-[9.5px] text-[var(--ac-cyan200)]/80">{label} ·</span>}
                  {l.text}
                </button>
              ) : (
                <span className="block px-1.5 py-1 text-[11px] text-[var(--sl500)]" title="Bu cümle bir bulguya bağlanamadı">
                  {l.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[9.5px] text-[var(--sl500)]">
        Eşleme kural tabanlıdır: metindeki «Kesit N» veya bulgu etiketiyle ortak sözcük. Bağ kurulamayan cümle vurgulanmaz.
      </p>
    </div>
  );
}

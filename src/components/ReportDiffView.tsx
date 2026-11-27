"use client";

/**
 * İki rapor sürümünün anlık görüntüsü arasındaki metin farkı (r-version).
 * Satır bazlı, LCS hizalamalı; yalnız değişen alanlar gösterilir.
 * Hiçbir klinik anlam çıkarımı yapılmaz — bu, metnin görsel karşılaştırmasıdır.
 */
import { useMemo } from "react";
import { diffReportSnapshots, summarizeDiff, parseReportSnapshot, type FieldDiff } from "@/lib/reportDiff";

function FieldBlock({ d }: { d: FieldDiff }) {
  const { added, removed } = summarizeDiff(d.lines);
  return (
    <div className="overflow-hidden rounded-md border border-[var(--t30)]">
      <div className="flex items-center justify-between border-b border-[var(--t30)] bg-[var(--t05)] px-2 py-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sl300)]">{d.label}</span>
        <span className="font-mono text-[9px] text-[var(--sl500)]">+{added} −{removed}</span>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-[#05080d] p-2 font-mono text-[10.5px] leading-snug">
        {d.lines.map((l, i) => (
          <div
            key={i}
            className={
              l.type === "add" ? "bg-emerald-500/10 text-[var(--ac-emerald300)]" :
              l.type === "del" ? "bg-rose-500/10 text-[var(--ac-rose300)] line-through decoration-rose-400/40" :
              "text-[var(--sl400)]"
            }
          >
            <span className="select-none opacity-60">{l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** `aRaw`/`bRaw`: report_versions.snapshot JSON metinleri (eski sürüm ile yeni sürüm). */
export default function ReportDiffView({ aRaw, bRaw }: { aRaw?: string | null; bRaw?: string | null }) {
  const a = useMemo(() => parseReportSnapshot(aRaw), [aRaw]);
  const b = useMemo(() => parseReportSnapshot(bRaw), [bRaw]);
  const fields = useMemo(() => diffReportSnapshots(a, b), [a, b]);
  const changed = fields.filter((f) => f.changed);

  if (!a && !b) return <p className="text-[10.5px] text-[var(--ac-amber300)]">Anlık görüntüler okunamadı; fark gösterilemiyor.</p>;
  if (!a || !b) {
    return <p className="text-[10.5px] text-[var(--ac-amber300)]">Sürümlerden birinin anlık görüntüsü yok; fark yalnız iki anlık görüntü mevcutsa gösterilebilir.</p>;
  }
  if (changed.length === 0) return <p className="text-[10.5px] text-[var(--ac-emerald300)]">Metin alanlarında fark yok (Teknik/Bulgular/İzlenim/Öneri).</p>;
  return (
    <div className="space-y-2">
      {!Array.isArray(a.findingsJson) || !Array.isArray(b.findingsJson) ? (
        <p className="text-[9.5px] text-[var(--sl500)]">Sürümlerden biri tam bulgu tablosu içermiyor; fark yalnız metin alanlarını kapsar.</p>
      ) : null}
      {changed.map((d) => <FieldBlock key={d.field} d={d} />)}
    </div>
  );
}

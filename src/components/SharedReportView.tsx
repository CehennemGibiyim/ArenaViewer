"use client";

import type { SharedPayload } from "@/lib/share";

/**
 * Süreli paylaşım görünümü: filigranlı, salt okunur rapor özeti + anahtar kesit.
 * Görüntüleyen her erişim sunucuda denetim kaydına düşer; bağlantı süreli/kapatılabilir.
 */


const fmt = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString("tr-TR") : "—");

export default function SharedReportView({ payload, token }: { payload: SharedPayload; token: string }) {
  const wm = payload.watermark || `${token.slice(0, 8).toUpperCase()} · SÜRELİ PAYLAŞIM`;
  return (
    <div className="relative min-h-dvh bg-[var(--t05)] text-[var(--sl200)] print:bg-white">
      {/* Filigran: tüm sayfayı kaplayan, döndürülmüş yinelenen metin */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden print:fixed">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="absolute whitespace-nowrap font-mono text-[34px] font-bold uppercase tracking-widest text-cyan-500/[0.07]" style={{ top: `${i * 8}%`, left: "-10%", transform: "rotate(-28deg)" }}>
            {Array.from({ length: 4 }).map((__, j) => <span key={j} className="mr-10">{wm}</span>)}
          </div>
        ))}
      </div>

      <header className="relative z-10 border-b border-cyan-500/30 bg-[var(--t47)]/90 px-4 py-2.5">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <span className="font-mono text-xs font-black tracking-[0.2em] text-[var(--sl100)]">ATIK<span className="text-[var(--ac-cyan400)]">VIEWER</span></span>
          <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10.5px] font-bold text-[var(--ac-amber300)]">Süreli paylaşım · salt okunur</span>
          <button onClick={() => window.print()} className="ml-auto cursor-pointer rounded border border-[var(--sl500)]/50 px-2.5 py-1 text-xs font-bold text-[var(--sl200)] hover:bg-[var(--sl500)]/10">⎙ Yazdır</button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-4xl space-y-4 px-4 py-5 print:max-w-none">
        <section className="rounded-lg border border-[var(--t30)] bg-[var(--t47)]/95 p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--sl300)]">
            <span><span className="text-[var(--sl500)]">Hasta:</span> <strong>{payload.patient.name}</strong> ({payload.patient.id})</span>
            <span><span className="text-[var(--sl500)]">Modalite:</span> {payload.modality}</span>
            <span><span className="text-[var(--sl500)]">Tetkik:</span> {fmt(payload.studyDate)}</span>
            <span><span className="text-[var(--sl500)]">Durum:</span> {payload.report.status}</span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--sl500)]">
            Bağlantı: {fmt(payload.createdAt)} itibarıyla oluşturuldu · <span className="font-bold text-[var(--ac-amber300)]">{fmt(payload.expiresAt)}</span> tarihinde sona erecek · bu ekranın her açılışı kayda geçer.
          </div>
        </section>

        {payload.keyImages.length > 0 && (
          <section className="rounded-lg border border-[var(--t30)] bg-[var(--t47)]/95 p-4">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--ac-cyan300)]">Anahtar kesitler</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {payload.keyImages.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt={`Anahtar kesit ${i + 1}`} className="h-auto w-full rounded border border-[var(--t32)] bg-black object-contain" />
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3 rounded-lg border border-[var(--t30)] bg-[var(--t47)]/95 p-4">
          <Block title="Teknik" text={payload.report.technique} />
          <Block title={`Bulgular (${payload.report.findingCount})`} text={payload.report.findings} />
          <Block title="İzlenim / Sonuç" text={payload.report.impression} strong />
          <Block title="Öneri" text={payload.report.recommendation} />
        </section>

        <footer className="pb-6 pt-2 text-center text-[11px] leading-relaxed text-[var(--sl500)]">
          {payload.report.approvedBy ? `Onaylayan: ${payload.report.doctorTitle} ${payload.report.approvedBy} · ${fmt(payload.report.approvedAt)}` : "Henüz onaylanmadı."}
          <div className="mt-1">Bu çıktı bir karar destek aracının salt okunur özetidir; tanısal asortiye orijinal görüntü ve kurumsal onay süreci gereklidir. Yapay zeka ile üretilmiş bölümler hekim onayına tabidir.</div>
        </footer>
      </main>
    </div>
  );
}

function Block({ title, text, strong }: { title: string; text: string; strong?: boolean }) {
  if (!text.trim()) return null;
  return (
    <div>
      <h2 className={`text-[11px] font-bold uppercase tracking-wider ${strong ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-cyan300)]"}`}>{title}</h2>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--sl200)]">{text}</p>
    </div>
  );
}

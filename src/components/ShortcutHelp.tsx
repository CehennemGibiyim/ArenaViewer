"use client";

/**
 * Klavye kısayolu yardımı (i-a11y).
 *
 * Erişilebilirlik notu: diyalog `role="dialog"` + `aria-modal`, başlıkla
 * ilişkilendirilmiş ve açıldığında kapat düğmesine odaklanır; Escape ve
 * arka plana tıklama kapatır. Liste, eylem gruplarına göre okunur bir tablodur.
 */
import { useEffect, useRef } from "react";
import { shortcutRows } from "@/lib/shortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
  shortcuts: unknown;
}

export default function ShortcutHelp({ open, onClose, shortcuts }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const rows = shortcutRows(shortcuts);
  const groups = [...new Set(rows.map((r) => r.group))];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#223047] bg-[#0b1018] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="shortcut-help-title" className="text-base font-black text-cyan-300">Klavye kısayolları</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Görüntüleme alanı odaktayken çalışır; metin kutusuna yazarken tuşlar engellenmez.
              Kendi atamalarınızı <span className="text-slate-200">Tercihler → Klavye</span> ekranından değiştirebilirsiniz.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Kısayol yardımını kapat"
            className="shrink-0 cursor-pointer rounded border border-slate-500/40 px-2 py-1 text-xs font-bold text-slate-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          >
            Esc ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-1 text-[10px] font-black uppercase tracking-widest text-emerald-300">{group}</h3>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {rows.filter((r) => r.group === group).map((r) => (
                    <tr key={r.id} className="border-b border-[#182231] last:border-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-semibold text-slate-200">{r.label}</th>
                      <td className="py-1.5 pr-3 text-right font-mono text-cyan-200">
                        {r.binding ? (
                          <kbd className="rounded border border-[#2a3a52] bg-[#111a26] px-1.5 py-0.5 text-[11px]">{r.label}</kbd>
                        ) : (
                          <span className="text-slate-500" title="Bu eylem devre dışı">kapalı</span>
                        )}
                      </td>
                      <td className="w-[45%] py-1.5 text-[11px] text-slate-400">{r.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>

        <p className="mt-4 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-amber-200">
          Kısayollar yalnızca arayüz kullanımını hızlandırır; hiçbir eylem tanı veya onay yerine geçmez.
          Bir eylem iki tuşa atanırsa sonraki atama varsayılana döner (Tercihler ekranında uyarı gösterilir).
        </p>
      </div>
    </div>
  );
}

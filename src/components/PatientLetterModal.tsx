"use client";

/**
 * Hasta dostu sonuç mektubu paneli (d-patient-letter).
 *
 * Onaylı rapor metninden dil (TR/EN/DE) ve okuma düzeyi (sade/standart) seçilerek
 * özet üretilir; önizleme düzenlenebilir, yazdırma/PDF ve panoya kopyalama vardır.
 * Rapor onaylı değilse mektup TASLAK olarak işaretlenir ve yazdırma kilitlidir.
 */
import { useMemo, useState } from "react";
import {
  LANG_LABELS, LETTER_LANGS, READING_LEVELS, buildPatientLetter, letterToText, parseGlossary,
  type LetterLang, type ReadingLevel,
} from "@/lib/patientLetter";
import { analyzeReadability, readabilityVerdict } from "@/lib/readability";
import { useEscapeKey } from "@/lib/useEscapeKey";

export interface PatientLetterSource {
  patientName: string;
  studyDate: string;
  modality: string;
  bodyPart: string;
  findingsText: string;
  impression: string;
  recommendation: string;
  institution: string;
  approvedBy: string;
  doctorTitle: string;
  approved: boolean;
}

interface Props {
  source: PatientLetterSource;
  onClose: () => void;
}

export default function PatientLetterModal({ source, onClose }: Props) {
  useEscapeKey(onClose);
  const [lang, setLang] = useState<LetterLang>("tr");
  const [level, setLevel] = useState<ReadingLevel>("sade");
  const [includeFindings, setIncludeFindings] = useState(true);
  const [copied, setCopied] = useState("");
  // Kuruma özel terim sözlüğü (satır başına "terim = karşılık") + okunabilirlik ölçümü.
  const [glossaryText, setGlossaryText] = useState("");
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const glossary = useMemo(() => parseGlossary(glossaryText), [glossaryText]);

  const letter = useMemo(
    () => buildPatientLetter({ ...source, doctorName: source.approvedBy }, { lang, level, includeFindings, glossary }),
    [source, lang, level, includeFindings, glossary],
  );
  const text = useMemo(() => letterToText(letter), [letter]);

  // Ateşman indeksi mektubun tamamı üzerinden; hedef düzeyle karşılaştırılır.
  const readability = useMemo(() => analyzeReadability(text, lang), [text, lang]);
  const verdict = useMemo(() => readabilityVerdict(readability, level), [readability, level]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Panoya kopyalandı.");
    } catch {
      setCopied("Panoya kopyalanamadı; metni seçip elle kopyalayın.");
    }
    setTimeout(() => setCopied(""), 3000);
  };

  /** Yazdırma: mektup kâğıdı #print-root içine kopyalanır (rapor yazdırmayla aynı yol). */
  const printLetter = () => {
    const paper = document.getElementById("patient-letter-paper");
    if (!paper) { window.print(); return; }
    const root = document.createElement("div");
    root.id = "print-root";
    root.appendChild(paper.cloneNode(true));
    document.body.appendChild(root);
    const cleanup = () => { root.remove(); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3" data-testid="patient-letter-modal" role="dialog" aria-modal="true" aria-label="Hasta mektubu">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--t39)] bg-[var(--t05)] text-xs text-[var(--sl200)] shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--t25)] px-4 py-2">
          <b className="text-sm text-[var(--sl100)]">Hasta mektubu</b>
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={lang} onChange={(e) => setLang(e.target.value as LetterLang)} aria-label="Mektup dili" className="rounded border border-[var(--t34)] bg-[var(--t17)] px-1.5 py-0.5">
              {LETTER_LANGS.map((l) => <option key={l} value={l}>{LANG_LABELS[l]}</option>)}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value as ReadingLevel)} aria-label="Okuma düzeyi" className="rounded border border-[var(--t34)] bg-[var(--t17)] px-1.5 py-0.5">
              {READING_LEVELS.map((r) => <option key={r} value={r}>{r === "sade" ? "sade dil" : "standart"}</option>)}
            </select>
            <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-[var(--sl400)]">
              <input type="checkbox" checked={includeFindings} onChange={(e) => setIncludeFindings(e.target.checked)} className="h-3 w-3 accent-cyan-500" />
              bulguları ekle
            </label>
            <button onClick={() => void copy()} className="cursor-pointer rounded border border-[var(--t39)] px-2 py-0.5 hover:bg-[var(--t26)]">Kopyala</button>
            <button onClick={printLetter} disabled={!source.approved} title={source.approved ? "Yazdır / PDF" : "Rapor onaylanmadan mektup verilemez"} className={`rounded border px-2 py-0.5 ${source.approved ? "cursor-pointer border-cyan-400/50 text-[var(--ac-cyan200)] hover:bg-cyan-400/10" : "cursor-not-allowed border-[var(--t39)] text-[var(--sl500)] opacity-60"}`}>🖨 Yazdır / PDF</button>
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[var(--t39)] px-2 py-0.5 hover:bg-[var(--t26)]">✕</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {letter.draftWarning && (
            <div className="mb-2 rounded border border-rose-400/50 bg-rose-400/10 px-2 py-1 font-bold text-[var(--ac-rose200)]">{letter.draftWarning}</div>
          )}
          {copied && <div role="status" className="mb-2 rounded border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[var(--ac-cyan200)]">{copied}</div>}

          <div
            data-testid="letter-readability"
            className={`mb-2 rounded border px-2 py-1 text-[10.5px] ${readability.index === null ? "border-[var(--t35)] text-[var(--sl400)]" : verdict.met ? "border-emerald-400/40 bg-emerald-400/10 text-[var(--ac-emerald200)]" : "border-amber-400/40 bg-amber-400/10 text-[var(--ac-amber200)]"}`}
          >
            <b>Okunabilirlik:</b> {verdict.message}
            <span className="ml-1 text-[var(--sl500)]">(Ateşman 1997; ölçüm yaklaşıktır, hekim onayı gerekir)</span>
            <button
              type="button"
              onClick={() => setGlossaryOpen((v) => !v)}
              className="ml-2 cursor-pointer rounded border border-[var(--t39)] px-1.5 py-0.5 hover:bg-[var(--t26)]"
              title="Kuruma özel terim sözlüğü: satır başına 'terim = karşılık'"
            >
              Terim sözlüğü{glossary.length > 0 ? ` (${glossary.length})` : ""}
            </button>
          </div>

          {glossaryOpen && (
            <div className="mb-2 rounded border border-[var(--t35)] bg-[var(--t11)] p-2">
              <div className="mb-1 text-[10.5px] text-[var(--sl400)]">
                Kuruma özel terimler (yalnız <b>sade</b> düzeyde uygulanır). Satır başına <code>terim = karşılık</code>; <code>#</code> ile başlayan satırlar yorumdur.
              </div>
              <textarea
                value={glossaryText}
                onChange={(e) => setGlossaryText(e.target.value)}
                rows={4}
                aria-label="Kuruma özel terim sözlüğü"
                placeholder={"nodül = küçük yumru\nkontrastlanma = boya tutan alan"}
                className="w-full rounded border border-[var(--t34)] bg-[var(--t05)] p-1.5 font-mono text-[10.5px] text-[var(--sl200)]"
              />
              <div className="mt-1 text-[10px] text-[var(--sl500)]">
                {glossary.length} terim etkin · örnek: {glossary.slice(0, 3).map(([t, r]) => `${t} → ${r}`).join(" · ") || "—"}
              </div>
            </div>
          )}

          <article id="patient-letter-paper" className="rounded-lg border border-[var(--t30)] bg-[var(--t11)] p-4 leading-relaxed text-[var(--sl200)]">
            <h2 className="text-sm font-bold text-[var(--sl100)]">{letter.title}</h2>
            <div className="mt-1 text-[11px] text-[var(--sl500)]">{source.institution || ""}{source.institution ? " · " : ""}{source.modality}{source.bodyPart ? ` · ${source.bodyPart}` : ""}</div>
            <p className="mt-3 font-semibold">{letter.greeting}</p>
            {letter.paragraphs.map((p, i) => (
              <p key={i} className="mt-2 text-[12px]">
                {p.split(": ").length === 2 && p.includes(": ") ? (
                  <>
                    <b>{p.split(": ")[0]}:</b> {p.split(": ").slice(1).join(": ")}
                  </>
                ) : p}
              </p>
            ))}
            <p className="mt-3 text-[12px] font-semibold">{letter.nextSteps}</p>
            <p className="mt-1 text-[11px] text-[var(--sl400)]">{letter.contact}</p>
            <p className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1 text-[10.5px] text-[var(--ac-amber200)]">{letter.important}</p>
            <p className="mt-2 text-[10px] text-[var(--sl500)]">{letter.disclaimer}</p>
          </article>

          <div className="mt-2 text-[10px] leading-relaxed text-[var(--sl500)]">
            Mektup, hekimin onayladığı rapor metninden <b>şablonla</b> üretilir (LLM kullanılmaz). Sade düzeyde bazı tıbbi terimler
            günlük karşılıklarıyla değiştirilir. Gönderilmeden önce içeriğin doğruluğu hekim tarafından kontrol edilmelidir.
          </div>
        </div>
      </div>
    </div>
  );
}

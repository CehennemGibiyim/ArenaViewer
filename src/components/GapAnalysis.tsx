"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { gapProgress } from "@/lib/gapProgress";
import {
  CANDIDATE_MODULES,
  CATEGORIES,
  COMPETITORS,
  COMPETITOR_SITES,
  GAP_ITEMS,
  ROADMAP,
  type CategoryId,
  type CompetitorType,
  type GapEffort,
  type GapItem,
  type GapPriority,
  type GapStatus,
} from "@/lib/gapAnalysis";
import { GAP_SOURCES, SOURCES_UPDATED, competitorLink, itemSources, sourceSummary } from "@/lib/gapSources";

/**
 * Metin içi biçim: satır metinleri `**kalın**` ve `` `kod` `` işaretleri taşır.
 * Düz metin olarak basıldığında tablo okunmuyordu (yıldız/ters tırnak görünür);
 * burada güvenli biçimde (dangerouslySetInnerHTML YOK) React düğümlerine çevrilir.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p !== "");
  return (
    <>
      {parts.map((p, k) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
          return <strong key={k} className="font-semibold text-[var(--sl100)]">{p.slice(2, -2)}</strong>;
        }
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
          return <code key={k} className="rounded bg-[var(--t12)] px-1 py-0.5 font-mono text-[10.5px] text-[var(--ac-cyan300)]">{p.slice(1, -1)}</code>;
        }
        return <span key={k}>{p}</span>;
      })}
    </>
  );
}

const STATUS_META: Record<GapStatus, { label: string; cls: string }> = {
  var: { label: "VAR", cls: "bg-emerald-500/15 text-[var(--ac-emerald300)] border-emerald-500/40" },
  kismi: { label: "KISMİ", cls: "bg-amber-500/15 text-[var(--ac-amber300)] border-amber-500/40" },
  yok: { label: "YOK", cls: "bg-rose-500/15 text-[var(--ac-rose300)] border-rose-500/40" },
};

const PRIORITY_META: Record<GapPriority, { label: string; cls: string }> = {
  P0: { label: "P0 · Kritik", cls: "bg-rose-500/20 text-[var(--ac-rose200)] border-rose-500/50" },
  P1: { label: "P1 · Yüksek", cls: "bg-orange-500/15 text-[var(--ac-orange200)] border-orange-500/40" },
  P2: { label: "P2 · Orta", cls: "bg-sky-500/15 text-[var(--ac-sky200)] border-sky-500/40" },
  P3: { label: "P3 · Düşük", cls: "bg-[var(--sl500)]/15 text-[var(--sl300)] border-[var(--sl500)]/40" },
};

const EFFORT_LABEL: Record<GapEffort, string> = {
  S: "Küçük (≤ 2 gün)",
  M: "Orta (1–2 hafta)",
  L: "Büyük (≥ 1 ay)",
};

const TYPE_STYLE: Record<CompetitorType, string> = {
  viewer: "border-cyan-400/40 text-[var(--ac-cyan300)] bg-cyan-400/5",
  ai: "border-amber-400/40 text-[var(--ac-amber300)] bg-amber-400/5",
  report: "border-violet-400/40 text-[var(--ac-violet300)] bg-violet-400/5",
};

const TYPE_LABEL: Record<CompetitorType, string> = {
  viewer: "Görüntüleyici",
  ai: "AI platformu",
  report: "Raporlama",
};

const NAME_TYPE: Record<string, CompetitorType> = Object.fromEntries(COMPETITORS.map((c) => [c.name, c.type]));

function barColor(pct: number): string {
  if (pct >= 70) return "from-emerald-400 to-teal-400";
  if (pct >= 40) return "from-amber-400 to-orange-400";
  return "from-rose-400 to-orange-500";
}

export default function GapAnalysis() {
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [status, setStatus] = useState<GapStatus | "all">("all");
  const [priority, setPriority] = useState<GapPriority | "all">("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const itemById = useMemo(() => new Map(GAP_ITEMS.map((i) => [i.id, i])), []);

  const progress = useMemo(() => gapProgress(GAP_ITEMS), []);
  const srcStats = useMemo(() => sourceSummary(GAP_ITEMS), []);
  const usedSources = useMemo(
    () => Object.values(GAP_SOURCES).filter((s) => s.kind !== "kod").sort((a, b) => a.label.localeCompare(b.label, "tr")),
    []
  );
  const overall = progress.indexPercent;
  const counts = useMemo(
    () => ({
      var: GAP_ITEMS.filter((i) => i.status === "var").length,
      kismi: GAP_ITEMS.filter((i) => i.status === "kismi").length,
      yok: GAP_ITEMS.filter((i) => i.status === "yok").length,
      p0open: GAP_ITEMS.filter((i) => i.priority === "P0" && i.status !== "var").length,
    }),
    []
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GAP_ITEMS.filter((i) => {
      if (category !== "all" && i.category !== category) return false;
      if (status !== "all" && i.status !== status) return false;
      if (priority !== "all" && i.priority !== priority) return false;
      if (q) {
        const hay = `${i.title} ${i.ours} ${i.action} ${i.market.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [category, status, priority, query]);

  const copyMarkdown = async () => {
    const lines: string[] = [
      "# ATIKVIEWER — Piyasa Kıyaslaması ve Eksik Analizi",
      "",
      `Durum endeksi: %${overall} (var ${counts.var} · kısmi ${counts.kismi} · yok ${counts.yok}); tamamlanan madde oranı: %${progress.completedPercent}`,
      "Endeks: var=1, kısmi=0,5, yok=0; kısmi işin gerçek yüzdesi ölçülmez.",
      "",
      `Kaynaklar: ${srcStats.usedSources} kaynak kaydı, ${srcStats.codeRefs} depo dosyası referansı (varlığı testle doğrulanır), ${srcStats.unverified} doğrulanmamış kayıt. Son gözden geçirme: ${SOURCES_UPDATED}.`,
      "",
      "| Özellik | Durum | Öncelik | Efor | Piyasada | Kaynak | Aksiyon |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...GAP_ITEMS.map((i) => {
        const r = itemSources(i);
        const srcs = [...r.external.map((x) => x.url ?? `${x.label} (doğrulanmadı)`), ...r.code.map((c) => `\`${c}\``)].join("<br>");
        return `| ${i.title} | ${STATUS_META[i.status].label} | ${i.priority} | ${i.effort} | ${i.market.join(", ")} | ${srcs} | ${i.action} |`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* pano erişimi yoksa sessiz geç */
    }
  };

  return (
    <div className="h-screen w-screen overflow-y-auto bg-[var(--t02)] text-[var(--sl200)]">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--t25)] bg-[var(--t05)]/95 px-5 py-3 backdrop-blur">
        <Link
          href="/"
          className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-[var(--ac-cyan300)] hover:bg-cyan-500/20"
        >
          ← Görüntüleyiciye dön
        </Link>
        <h1 className="font-mono text-sm font-black tracking-[0.15em] text-[var(--sl100)]">
          ATIK<span className="text-[var(--ac-cyan400)]">VIEWER</span> · PİYASA KIYASLAMASI
        </h1>
        <button
          onClick={copyMarkdown}
          className="ml-auto rounded-md border border-[var(--t39)] bg-[var(--t17)] px-3 py-1.5 text-xs font-semibold text-[var(--sl200)] hover:bg-[var(--t26)]"
        >
          {copied ? "✓ Kopyalandı" : "Markdown olarak kopyala"}
        </button>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">
        {/* Dürüstlük notu */}
        <section className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4">
          <h2 className="text-sm font-black tracking-wide text-[var(--ac-amber300)]">⚠ Kodla kapatılamayanlar ve açık kalan sınırlar</h2>
          <ul className="mt-2 grid gap-1.5 text-[12.5px] leading-relaxed text-[var(--sl300)] md:grid-cols-2">
            <li>
              <b className="text-[var(--ac-amber200)]">Yapay zeka klinik olarak doğrulanmadı.</b> BT beyin (kanama adayı) ve BT toraks (nodül adayı)
              için kural tabanlı motor ve isteğe bağlı yerel modeller bulunur; CXR için de yerel model seçeneği vardır.
              Diz MR için <b>araştırma amaçlı</b> bir segmentasyon modeli (menisküs/kıkırdak/kemik; yırtık tanısı konmaz) eklendi — yine de
              modellerin klinik kullanımı doğrulanmış değildir; MR&apos;da hastalık dedektörü yoktur ve örnekler DEMO niteliğindedir.
            </li>
            <li>
              <b className="text-[var(--ac-amber200)]">Düzenleyici yol sizin sürecinizdir.</b> Tıbbi cihaz yazılımı sınıflandırması (MDR/TİTCK),
              ISO 13485/62304/14971 ve klinik performans çalışması koda dönüştürülemez; Yönetim → Uyum sekmesi yalnızca takip içindir.
            </li>
            <li>
              <b className="text-[var(--ac-rose300)]">Demo modu kimlik doğrulamaz.</b> Hesap modu ve erişim kontrolü yapılandırılmadığında
              erişimi olanlar işlemleri demo kullanıcısı olarak yapabilir. SHA-256 mühür elektronik imza değildir.
              Gerçek hasta verileri için uygun erişim kontrolü ve kurumsal güvenlik gerekir.
            </li>
            <li>
              <b className="text-[var(--ac-amber200)]">Gerçek hastane ortamında doğrulanmadı.</b> PACS (DICOMweb) sahte bir sunucuyla, codec&apos;ler
              pydicom test dosyalarıyla denendi; 1000+ kesitlik çalışmalarda performans, çok kullanıcılı yük ve gerçek PACS uyumu test edilmedi.
            </li>
          </ul>
        </section>

        {/* Skor kartları */}
        <section className="mt-6 grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4 md:col-span-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--sl500)]">Durum endeksi</div>
            <div className="mt-1 text-4xl font-black text-[var(--sl100)]">%{overall}</div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--t50)]">
              <div className={`h-full bg-gradient-to-r ${barColor(overall)}`} style={{ width: `${overall}%` }} />
            </div>
            <div className="mt-2 text-[11px] text-[var(--sl400)]">
              Var = 1, Kısmi = 0,5, Yok = 0 puan; {GAP_ITEMS.length} madde. Bu bir karşılaştırma endeksidir, gerçek iş bitiş yüzdesi veya klinik yeterlilik değildir.
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 md:col-span-2">
            {(["var", "kismi", "yok"] as const).map((s) => (
              <div key={s} className={`rounded-xl border p-4 ${STATUS_META[s].cls}`}>
                <div className="text-[10px] font-bold uppercase tracking-widest opacity-80">{STATUS_META[s].label}</div>
                <div className="mt-1 text-3xl font-black">{counts[s]}</div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--ac-rose300)]">Açık P0 madde</div>
            <div className="mt-1 text-3xl font-black text-[var(--ac-rose200)]">{counts.p0open}</div>
            <div className="mt-1 text-[11px] text-[var(--ac-rose200)]/80">Açık P0; ayrıca tüm açık maddeler: {progress.open}</div>
          </div>
        </section>

        <p className="mt-3 text-xs leading-relaxed text-[var(--sl400)]">
          Tamamlanan madde oranı: <strong className="text-[var(--sl200)]">%{progress.completedPercent}</strong> ({progress.var}/{progress.total}).
          Kısmi maddelerin gerçek tamamlanma oranı ayrı ölçülmediğinden %50 tamamlandı sayılmaz; yukarıdaki endekste yalnızca sabit ağırlık olarak kullanılır.
          Durumlar elle işaretlenir (bir özellik ancak gerçek kod varsa VAR sayılır) ve sayfa bu kaynaktan üretilir; satırlardaki dosya yolları{" "}
          <code className="font-mono text-[10.5px] text-[var(--ac-cyan300)]">test:gap-sources</code> ile dosya sisteminden doğrulanır.
        </p>

        {/* Kategori çubukları */}
        <section className="mt-6 rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
          <h2 className="text-sm font-black tracking-wide text-[var(--sl100)]">Kategori bazlı durum endeksi</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {CATEGORIES.map((c) => {
              const items = GAP_ITEMS.filter((i) => i.category === c.id);
              const summary = gapProgress(items);
              const pct = summary.indexPercent;
              return (
                <button
                  key={c.id}
                  onClick={() => setCategory(category === c.id ? "all" : c.id)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    category === c.id ? "border-cyan-400/60 bg-cyan-400/10" : "border-[var(--t30)] bg-[var(--t10)] hover:border-[var(--t38)]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--sl100)]">
                      {c.icon} {c.title}
                    </span>
                    <span className="font-mono text-xs font-bold text-[var(--sl300)]">%{pct}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--t50)]">
                    <div className={`h-full bg-gradient-to-r ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-[10.5px] text-[var(--sl500)]">
                    {c.blurb} · {summary.var} var / {summary.kismi} kısmi / {summary.yok} yok · tamamlanan %{summary.completedPercent}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Özellik tablosu */}
        <section className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-sm font-black tracking-wide text-[var(--sl100)]">
              Özellik karşılaştırması <span className="font-mono text-[var(--sl500)]">({filtered.length})</span>
            </h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ara: MPR, PACS, e-imza…"
              className="w-56 rounded-md border border-[var(--t30)] bg-[var(--t10)] px-3 py-1.5 text-xs text-[var(--sl200)] placeholder:text-[var(--sl600)] focus:border-cyan-400/50 focus:outline-none"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as GapStatus | "all")}
              className="rounded-md border border-[var(--t30)] bg-[var(--t10)] px-2 py-1.5 text-xs text-[var(--sl200)] focus:outline-none"
            >
              <option value="all">Tüm durumlar</option>
              <option value="yok">Yok</option>
              <option value="kismi">Kısmi</option>
              <option value="var">Var</option>
            </select>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as GapPriority | "all")}
              className="rounded-md border border-[var(--t30)] bg-[var(--t10)] px-2 py-1.5 text-xs text-[var(--sl200)] focus:outline-none"
            >
              <option value="all">Tüm öncelikler</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
            {(category !== "all" || status !== "all" || priority !== "all" || query) && (
              <button
                onClick={() => {
                  setCategory("all");
                  setStatus("all");
                  setPriority("all");
                  setQuery("");
                }}
                className="text-xs text-[var(--ac-cyan400)] hover:underline"
              >
                Filtreleri temizle
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {filtered.length === 0 && (
              <p className="rounded-lg border border-[var(--t30)] bg-[var(--t06)] p-6 text-center text-xs text-[var(--sl500)]">
                Bu filtrelerle eşleşen madde yok.
              </p>
            )}
            {filtered.map((i) => {
              const cat = CATEGORIES.find((c) => c.id === i.category);
              const src = itemSources(i);
              return (
                <article key={i.id} className="rounded-lg border border-[var(--t30)] bg-[var(--t06)] p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--sl500)]">
                        {cat?.icon} {cat?.title}
                      </div>
                      <h3 className="mt-0.5 text-[13px] font-bold text-[var(--sl100)]">{i.title}</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-black ${STATUS_META[i.status].cls}`}>
                        {STATUS_META[i.status].label}
                      </span>
                      <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${PRIORITY_META[i.priority].cls}`}>
                        {PRIORITY_META[i.priority].label}
                      </span>
                      <span className="rounded border border-[var(--t39)] px-2 py-0.5 font-mono text-[10px] text-[var(--sl400)]">
                        {EFFORT_LABEL[i.effort]}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-semibold text-[var(--sl500)]">Piyasada:</span>
                    {i.market.map((m) => (
                      <span
                        key={m}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_STYLE[NAME_TYPE[m] ?? "viewer"]}`}
                      >
                        {m}
                      </span>
                    ))}
                  </div>

                  <div className="mt-2.5 grid gap-2 text-[11.5px] leading-relaxed md:grid-cols-2">
                    <div className="rounded-md border border-[var(--t27)] bg-[var(--t45)] p-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--sl500)]">Bizde şu an</div>
                      <p className="mt-0.5 text-[var(--sl300)]"><Inline text={i.ours ?? ""} /></p>
                    </div>
                    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/5 p-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--ac-cyan400)]">Önerilen aksiyon</div>
                      <p className="mt-0.5 text-[var(--sl300)]"><Inline text={i.action ?? ""} /></p>
                    </div>

                  <div className="mt-2 rounded-md border border-[var(--t27)] bg-[var(--t45)] p-2.5 text-[11px] leading-relaxed">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--sl500)]">Kaynaklar</div>
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {src.external.map((x) => (
                        <li key={x.key} className="min-w-0">
                          {x.url ? (
                            <a
                              href={x.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`font-semibold hover:underline ${x.checkedAt ? "text-[var(--ac-cyan400)]" : "text-[var(--ac-amber300)]"}`}
                              title={`${x.basis} · ${x.checkedAt ? `doğrulandı ${x.checkedAt} (${x.checkMethod === "get" ? "doğrudan erişim" : "arama"})` : "doğrulanmadı"}`}
                            >
                              {x.checkedAt ? "✓" : "⚠"} {x.label}
                            </a>
                          ) : (
                            <span className="font-semibold text-[var(--ac-amber300)]" title={x.note ?? x.basis}>⚠ {x.label}</span>
                          )}
                        </li>
                      ))}
                      {src.unmapped.map((p) => (
                        <li key={p} className="font-mono text-[10px] text-[var(--ac-rose300)]" title="Bu ürün adı için kaynak kaydı yok">
                          ⚠ kaynaksız: {p}
                        </li>
                      ))}
                    </ul>
                    {src.code.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--sl500)]">Depo:</span>
                        {src.code.map((c) => (
                          <code key={c} className="rounded bg-[var(--t48)] px-1 py-0.5 font-mono text-[10px] text-[var(--sl400)]">
                            {c}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Yol haritası */}
        <section className="mt-8">
          <h2 className="text-sm font-black tracking-wide text-[var(--sl100)]">Önerilen yol haritası</h2>
          <p className="mt-1 text-[11.5px] text-[var(--sl500)]">
            Sıralama mantığı: önce güven ve gerçeklik, sonra okuma konforu, sonra gerçek yapay zeka, en son entegrasyon ve
            düzenleyici yol.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {ROADMAP.map((p) => (
              <div key={p.id} className="rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-bold text-[var(--sl100)]">{p.title}</h3>
                  <span className="rounded border border-cyan-400/40 px-2 py-0.5 font-mono text-[10px] text-[var(--ac-cyan300)]">
                    {p.timeframe}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] text-[var(--sl400)]">{p.goal}</p>
                <ul className="mt-2 flex flex-col gap-1">
                  {p.itemIds.map((id) => {
                    const it = itemById.get(id);
                    if (!it) return null;
                    return (
                      <li key={id} className="flex items-center gap-2 text-[11.5px] text-[var(--sl300)]">
                        <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-black ${STATUS_META[it.status].cls}`}>
                          {STATUS_META[it.status].label}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={it.title}>
                          {it.title}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--sl500)]">{it.priority}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Önerilen aday modüller (kod yok) */}
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-black tracking-wide text-[var(--sl100)]">Önerilen aday modüller <span className="font-mono text-[var(--ac-rose300)]">— henüz kod yok</span></h2>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--sl500)]">kıyaslama tablosuna dahil değildir</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--sl400)]">
            Bu liste, yol haritasını seçerken değerlendirilmek üzere hazırlanmıştır. Buradaki hiçbir madde için satır
            eklenmedi ve <strong className="text-[var(--sl200)]">kod yazılmadı</strong>; bir aday ancak kod + test + satırıyla
            VAR/KISMİ olur. Lisans, kanıt ve önkoşul satırları 2026-11-26&apos;ta incelenmiştir; karar sizinle birlikte verilecektir.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {CANDIDATE_MODULES.map((c) => (
              <div key={c.id} className="flex flex-col rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-rose-400/50 bg-rose-400/10 px-2 py-0.5 font-mono text-[9px] font-black text-[var(--ac-rose300)]">ÖNERİLEN · KOD YOK</span>
                  {c.nextUp && (
                    <span className="rounded border border-cyan-400/50 bg-cyan-400/10 px-2 py-0.5 font-mono text-[9px] font-black text-[var(--ac-cyan300)]">SIRADAKİ</span>
                  )}
                  <span className="font-mono text-[10px] text-[var(--sl500)]">{c.field}</span>
                </div>
                <h3 className="mt-2 text-[13px] font-bold leading-snug text-[var(--sl100)]">{c.title}</h3>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px] leading-relaxed">
                  <dt className="font-semibold text-[var(--ac-amber300)]/90">Lisans</dt><dd className="text-[var(--sl300)]">{c.license}</dd>
                  <dt className="font-semibold text-[var(--sl500)]">Kanıt</dt><dd className="text-[var(--sl300)]">{c.evidence}</dd>
                  <dt className="font-semibold text-[var(--sl500)]">Önkoşul</dt><dd className="text-[var(--sl300)]">{c.blocker}</dd>
                  <dt className="font-semibold text-[var(--ac-cyan300)]/90">Değer</dt><dd className="text-[var(--sl300)]">{c.value}</dd>
                </dl>
              </div>
            ))}
          </div>
        </section>

        {/* Rakip profilleri */}
        <section className="mt-8">
          <h2 className="text-sm font-black tracking-wide text-[var(--sl100)]">Rakip profilleri ve ne öğrenebiliriz</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {COMPETITORS.map((c) => (
              <div key={c.name} className="rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[var(--sl100)]">{c.name}</h3>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_STYLE[c.type]}`}>
                    {TYPE_LABEL[c.type]}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--sl500)]">{c.focus}</p>
                {competitorLink(c.name) && (
                  <a href={competitorLink(c.name)!.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-[11px] font-semibold text-[var(--ac-cyan400)] hover:text-[var(--ac-cyan300)] hover:underline">
                    {competitorLink(c.name)!.official ? "↗ Resmî site" : "↗ Doğrulanmış kaynak"}
                    {!competitorLink(c.name)!.checkedAt && <span className="ml-1 text-[var(--ac-amber300)]">⚠</span>}
                  </a>
                )}
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11.5px] text-[var(--sl300)]">
                  {c.strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <p className="mt-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 p-2 text-[11px] text-[var(--ac-cyan200)]">
                  <b>Bizim için ders:</b> {c.learn}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Kaynaklar ve doğrulama */}
        <section className="mt-8 mb-10 rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-black tracking-wide text-[var(--sl100)]">Kaynaklar, doğrulama ve veri politikası</h2>
            <span className="font-mono text-[11px] text-[var(--sl500)]">son gözden geçirme: {SOURCES_UPDATED}</span>
          </div>
          <ul className="mt-2 grid gap-1.5 text-[11.5px] leading-relaxed text-[var(--sl300)] md:grid-cols-2">
            <li>
              <b className="text-[var(--sl100)]">Sahte veri yok.</b> Her satırdaki &quot;bizde şu an&quot; ifadesi depodaki dosya
              yollarına bağlıdır; bu yolların gerçekten var olduğu <code className="font-mono text-[10.5px] text-[var(--ac-cyan300)]">npm run test:gap-sources</code>{" "}
              ile dosya sisteminden doğrulanır ({srcStats.codeRefs} referans).
            </li>
            <li>
              <b className="text-[var(--sl100)]">Her piyasa iddiasının kaynağı var.</b> {srcStats.usedSources} kaynak kaydı,{" "}
              {srcStats.externalLinks} dış bağlantı; doğrulanmamış {srcStats.unverified} kayıt tabloda <span className="text-[var(--ac-amber300)]">⚠</span> ile
              işaretlenir ve hakkında ayrıntılı iddia kurulmaz.
            </li>
            <li>
              <b className="text-[var(--sl100)]">Rakip iddiaları üretici beyanıdır.</b> Ürün yetenekleri üretici sitesi/dokümantasyonundan
              alınır; sürüme, modüle ve bölgeye göre değişir. Bağımsız klinik doğrulama sayılmaz, hukuki/regülasyon görüşü değildir.
            </li>
            <li>
              <b className="text-[var(--sl100)]">Tablo kodla senkron.</b> Durumlar ve yüzdeler{" "}
              <code className="font-mono text-[10.5px] text-[var(--ac-cyan300)]">src/lib/gapAnalysis.ts</code> +{" "}
              <code className="font-mono text-[10.5px] text-[var(--ac-cyan300)]">gapProgress</code> üzerinden hesaplanır; sayfada sabit
              yüzde tutulmaz, özellik tamamlandıkça tablo kendiliğinden güncellenir.
            </li>
          </ul>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {usedSources.map((x) => (
              <div key={x.key} className="rounded-md border border-[var(--t27)] bg-[var(--t45)] px-2.5 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    {x.url ? (
                      <a href={x.url} target="_blank" rel="noopener noreferrer" className="truncate text-[11.5px] font-semibold text-[var(--ac-cyan400)] hover:underline">
                        {x.label}
                      </a>
                    ) : (
                      <span className="text-[11.5px] font-semibold text-[var(--ac-amber300)]">{x.label} ⚠</span>
                    )}
                    <span className="ml-1.5 rounded border border-[var(--t39)] px-1 py-0.5 font-mono text-[9px] text-[var(--sl400)]">
                      {x.kind === "uretici" ? "üretici" : x.kind === "dokumantasyon" ? "dokümantasyon" : x.kind === "standart" ? "standart" : "ikincil"}
                    </span>
                  </div>
                  <span className={`shrink-0 font-mono text-[10px] ${x.checkedAt ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-amber300)]"}`}>
                    {x.checkedAt ? `✓ ${x.checkedAt}` : "⚠ doğrulanmadı"}
                  </span>
                </div>
                <div className="truncate text-[10.5px] text-[var(--sl500)]" title={x.basis}>{x.basis}</div>
                {x.note && <div className="mt-0.5 text-[10px] leading-snug text-[var(--ac-amber200)]/70">{x.note}</div>}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

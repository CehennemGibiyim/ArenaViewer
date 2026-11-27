import type { Metadata } from "next";
import Link from "next/link";
import { GUIDE_DEMO_NOTE, GUIDE_IMAGE_WIDTHS, GUIDE_INTRO, GUIDE_SECTIONS, guideImageSrc, guideStats, helpAnchor } from "@/lib/guideStory";

export const metadata: Metadata = {
  title: "ATIKVIEWER — Resimli Anlatım",
  description: "İlk açılıştan rapor onayına kadar her işlemin ekran ekran, görselli anlatımı.",
};

/**
 * `/resimlianlatim` — uygulama içi görsel kılavuz.
 *
 * Sunucuya/veritabanına bağlanmaz (tamamen statik): GitHub Pages demosunda da
 * açılır. İçerik `src/lib/guideStory.ts`ten gelir; görseller `public/kilavuz/`
 * altındaki **gerçek** ekran görüntüleridir (docs/img ile bayt bayt aynı —
 * `tests/guide-story.test.ts` denetler).
 */
export default function ResimliAnlatimPage() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const stats = guideStats();

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-[var(--t02)] text-[var(--sl200)]">
      <header className="sticky top-0 z-20 border-b border-[var(--t25)] bg-[var(--t05)]/95 px-4 py-2.5 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
          <Link href="/" className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-[var(--ac-cyan300)] hover:bg-cyan-500/20">
            ← Görüntüleyici
          </Link>
          <Link href="/yardim" className="rounded-md border border-[var(--sl500)]/40 px-2.5 py-1 text-[11px] font-bold text-[var(--sl200)] hover:bg-[var(--sl500)]/10">
            Yardım / S.S.S.
          </Link>
          <Link href="/kiyaslama" className="rounded-md border border-violet-400/50 px-2.5 py-1 text-[11px] font-bold text-[var(--ac-violet200)] hover:bg-violet-500/20">
            Kıyaslama
          </Link>
          <span className="ml-auto font-mono text-[10px] text-[var(--sl500)]">
            {stats.sections} bölüm · {stats.steps} adım · {stats.images} görsel
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8" id="kilavuz">
        <h1 className="text-2xl font-black text-[var(--sl100)]">{GUIDE_INTRO.title}</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--sl300)]">{GUIDE_INTRO.lead}</p>
        <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 text-[12px] leading-relaxed text-[var(--ac-amber200)]">
          {GUIDE_INTRO.disclaimer}
        </p>
        {/* Akış şeması: adımların nasıl okunacağını gösteren özgün SVG */}
        <figure className="mt-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- statik kılavuz görseli; Pages dışa aktarımında next/image optimizasyonu kapalı */}
          <img
            src={guideImageSrc(GUIDE_INTRO.flowImage, base)}
            alt={GUIDE_INTRO.flowAlt}
            width={GUIDE_IMAGE_WIDTHS[GUIDE_INTRO.flowImage] ?? 960}
            className="w-full rounded-xl border border-[var(--t32)] bg-[var(--t05)]"
          />
          <figcaption className="mt-1 text-[10.5px] text-[var(--sl500)]">
            {GUIDE_INTRO.flowAlt} · {GUIDE_INTRO.versionNote}
          </figcaption>
        </figure>

        {process.env.NEXT_PUBLIC_STATIC_DEMO === "true" && (
          <p className="mt-2 rounded-lg border border-cyan-400/40 bg-cyan-400/10 p-2.5 text-[11.5px] text-[var(--ac-cyan200)]">{GUIDE_DEMO_NOTE}</p>
        )}

        {/* Ortam rozetleri: hangi adım nerede çalışır */}
        <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-[var(--ac-emerald200)]">
            {stats.web} adım web demosunda da yapılabilir
          </span>
          <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[var(--ac-amber200)]">
            {stats.partial} adım kısmî (sunucu/DB gerekir)
          </span>
          <span className="rounded-full border border-rose-400/40 bg-rose-400/10 px-2.5 py-1 text-[var(--ac-rose200)]">
            {stats.local} adım yalnız yerel/kurum kurulumunda
          </span>
        </div>

        {/* İçindekiler */}
        <nav aria-label="Resimli anlatım içindekiler" className="mt-6 rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-[var(--sl400)]">İçindekiler</h2>
          <ol className="mt-2 grid gap-1 sm:grid-cols-2">
            {GUIDE_SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${helpAnchor(s.id)}`} className="text-[12.5px] font-semibold text-[var(--ac-cyan400)] hover:underline">
                  {s.title}
                </a>
                <span className="ml-1 text-[11px] text-[var(--sl500)]">({s.steps.length} adım)</span>
              </li>
            ))}
          </ol>
        </nav>

        {GUIDE_SECTIONS.map((section) => (
          <section key={section.id} id={helpAnchor(section.id)} className="mt-8 scroll-mt-16">
            {/* Çapa: bağlamsal yardım bağlantıları (#bolum-…) buraya atlar */}
            <h2 className="text-lg font-black text-[var(--sl100)]">{section.title}</h2>
            <p className="mt-1 text-[12.5px] text-[var(--sl400)]">{section.goal}</p>

            <div className="mt-3 space-y-4">
              {section.steps.map((step, i) => (
                <article key={`${section.id}-${i}`} className="rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 font-mono text-[11px] font-black text-[var(--ac-cyan200)]">
                      {i + 1}
                    </span>
                    <h3 className="text-[13.5px] font-bold text-[var(--sl100)]">{step.title}</h3>
                    <span
                      className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                        step.web === "evet"
                          ? "border-emerald-400/40 bg-emerald-400/10 text-[var(--ac-emerald200)]"
                          : step.web === "kismi"
                            ? "border-amber-400/40 bg-amber-400/10 text-[var(--ac-amber200)]"
                            : "border-rose-400/40 bg-rose-400/10 text-[var(--ac-rose200)]"
                      }`}
                    >
                      {step.web === "evet" ? "WEB DEMOSUNDA DA" : step.web === "kismi" ? "KISMÎ (SUNUCU)" : "YALNIZ YEREL KURULUM"}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[12px] leading-relaxed sm:grid-cols-[7.5rem_1fr]">
                    <dt className="font-semibold text-[var(--sl500)]">Nerede</dt>
                    <dd className="text-[var(--sl200)]">{step.where}</dd>
                    <dt className="font-semibold text-[var(--sl500)]">Ne yapılır</dt>
                    <dd className="text-[var(--sl300)]">{step.what}</dd>
                    <dt className="font-semibold text-[var(--sl500)]">Ne olur</dt>
                    <dd className="text-[var(--ac-cyan200)]">{step.result}</dd>
                  </dl>
                  {step.image && (
                    <figure className="mt-3">
                      {/* eslint-disable-next-line @next/next/no-img-element -- statik kılavuz görseli; next/image optimizasyonu Pages dışa aktarımında kapalı */}
                      <img
                        src={guideImageSrc(step.image, base)}
                        alt={step.alt ?? step.title}
                        width={GUIDE_IMAGE_WIDTHS[step.image] ?? 1200}
                        loading="lazy"
                        className="w-full rounded-lg border border-[var(--t32)] bg-[var(--t05)]"
                      />
                      <figcaption className="mt-1 text-[10.5px] text-[var(--sl500)]">
                        {step.alt ?? step.title} · <code className="font-mono">docs/img/{step.image}</code>
                      </figcaption>
                    </figure>
                  )}
                </article>
              ))}
            </div>

            {section.note && (
              <p className="mt-2 rounded-lg border border-[var(--t32)] bg-[var(--t10)] p-2.5 text-[11.5px] leading-relaxed text-[var(--sl400)]">
                {section.note}
              </p>
            )}
          </section>
        ))}

        <footer className="mt-10 mb-6 rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4 text-[11.5px] leading-relaxed text-[var(--sl400)]">
          <p>
            Bu sayfa <code className="font-mono text-[var(--ac-cyan300)]">docs/GORSEL_ANLATIM.md</code> ile aynı içeriği gösterir; belge PDF olarak
            sürüm etiketinde yayımlanır. Görseller depodaki <code className="font-mono">docs/img/</code> dosyalarıyla birebir aynıdır ve
            <b> hasta verisi içermez</b>. Menü düğmelerinin birebir listesi:{" "}
            <Link href="/yardim" className="text-[var(--ac-cyan400)] hover:underline">
              Yardım / S.S.S.
            </Link>{" "}
            · <code className="font-mono">docs/MENU_KILAVUZU.md</code>.
          </p>
        </footer>
      </main>
    </div>
  );
}

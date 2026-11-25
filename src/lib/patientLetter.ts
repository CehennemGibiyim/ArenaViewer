/**
 * Hasta dostu sonuç mektubu (d-patient-letter).
 *
 * Radyoloğun **onayladığı rapor metninden** sade dilli bir özet üretir: dil
 * (TR/EN/DE) ve okuma düzeyi (sade/standart) seçilebilir. Mektup tanı koymaz,
 * tedavi önermez; "sonucunuzu değerlendirmek için hekiminize başvurun" ilkesiyle
 * yazılır. Şablon tabanlıdır (LLM yok), bu yüzden metin öngörülebilirdir; yine de
 * gönderilmeden önce hekim onayı gerekir.
 */

export const LETTER_LANGS = ["tr", "en", "de"] as const;
export type LetterLang = (typeof LETTER_LANGS)[number];

export const READING_LEVELS = ["sade", "standart"] as const;
export type ReadingLevel = (typeof READING_LEVELS)[number];

export const LANG_LABELS: Record<LetterLang, string> = { tr: "Türkçe", en: "English", de: "Deutsch" };

export interface LetterInput {
  patientName: string;
  studyDate: string;
  modality: string;
  bodyPart: string;
  /** Hekimin onayladığı bulgu metni. */
  findingsText: string;
  /** Hekimin izlenimi (tanı/olasılık). */
  impression: string;
  /** Hekimin önerisi (kontrol, ek tetkik…). */
  recommendation: string;
  institution: string;
  doctorName: string;
  doctorTitle: string;
  approved: boolean;
}

export interface PatientLetter {
  lang: LetterLang;
  level: ReadingLevel;
  /** Kâğıt başlığı */
  title: string;
  /** "Sayın …" satırı */
  greeting: string;
  /** Gövde paragrafları */
  paragraphs: string[];
  /** "Önemli" kutusu */
  important: string;
  /** Sıradaki adımlar */
  nextSteps: string;
  /** İletişim satırı */
  contact: string;
  /** Yasal/etik sorumluluk reddi */
  disclaimer: string;
  /** Onaysız rapor uyarısı (varsa) */
  draftWarning: string | null;
}

/**
 * Sadeleştirme sözlüğü: raporda geçen teknik terimi günlük karşılığıyla değiştirir.
 * Yalnız "sade" okuma düzeyinde uygulanır; ilk eşleşen ifade (uzun olan) kazanır.
 */
export const PLAIN_TR: [RegExp, string][] = [
  [/kontrastlan(ma|an)\b/gi, "boya tutan alan"],
  [/kontrast\b/gi, "boya (kontrast madde)"],
  [/nodül/gi, "küçük yumru (nodül)"],
  [/efüzyon/gi, "sıvı birikmesi"],
  [/opasite/gi, "beyazlık (gölge)"],
  [/konsolidasyon/gi, "akciğerde dolgunluk"],
  [/metastaz/gi, "yayılım"],
  [/malign/gi, "kötü huylu olabilecek"],
  [/benign/gi, "iyi huylu"],
  [/lezyon/gi, "alan (lezyon)"],
  [/intrakraniyal/gi, "kafa içi"],
  [/hepatomegali/gi, "karaciğer büyümesi"],
  [/kardiyomegali/gi, "kalp büyümesi"],
  [/inflamasyon/gi, "iltihap"],
  [/fraktür/gi, "kırık"],
  [/adyacent/gi, "komşu"],
];

/** Sadeleştirilmiş metin (TR). Diğer dillerde metin olduğu gibi kalır. */
export function plainify(text: string, lang: LetterLang, level: ReadingLevel): string {
  if (level !== "sade" || lang !== "tr") return text;
  let out = text;
  for (const [re, rep] of PLAIN_TR) out = out.replace(re, rep);
  return out;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Uzun metni cümle sınırından kısaltır (mektupta tam rapor yazılmaz). */
export function summarizeText(text: string, maxChars = 600): string {
  const t = clean(text);
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return `${(lastStop > maxChars * 0.4 ? cut.slice(0, lastStop + 1) : cut).trim()} …`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** ISO/görsel tarihi seçilen dilin biçimine çevirir (yyyy-mm-dd → gg.aa.yyyy). */
export function formatLetterDate(raw: string, lang: LetterLang): string {
  const s = clean(raw);
  const m = DATE_RE.exec(s);
  if (!m) return s;
  const [, y, mo, d] = m;
  if (lang === "en") return `${Number(mo)}/${Number(d)}/${y}`;
  return `${d}.${mo}.${y}`;
}

interface Strings {
  title: string;
  greeting: (name: string) => string;
  intro: (modality: string, body: string, date: string) => string;
  findingsHeading: string;
  impressionHeading: string;
  recommendationHeading: string;
  none: string;
  important: string;
  nextSteps: string;
  contact: (institution: string, doctor: string) => string;
  disclaimer: string;
  draft: string;
}

const TR: Strings = {
  title: "Görüntüleme sonucu — hasta özeti",
  greeting: (n) => `Sayın ${n},`,
  intro: (mod, body, date) => `${date} tarihinde yapılan ${mod}${body ? ` (${body})` : ""} görüntülemenizin sonucu aşağıda sade bir dille özetlenmiştir.`,
  findingsHeading: "Neler görüldü",
  impressionHeading: "Sonucun özeti",
  recommendationHeading: "Öneriler",
  none: "Bu bölüm için ek bilgi yazılmamış.",
  important: "Bu mektup, radyoloji uzmanının onayladığı raporun sadeleştirilmiş özetidir. Tanı koymaz; sonucunuzu değerlendirmek için hekiminize başvurun.",
  nextSteps: "Sonucunuzu, sizi yönlendiren hekimle görüşün. Acil bir şikâyetiniz olursa en yakın sağlık kuruluşuna başvurun.",
  contact: (inst, doc) => `${inst || "Kurum"}${doc ? ` · ${doc}` : ""} ile iletişime geçebilirsiniz.`,
  disclaimer: "Bu özet bilgilendirme amaçlıdır; tıbbi tanı, tedavi veya acil değerlendirme yerine geçmez.",
  draft: "Rapor henüz hekim tarafından onaylanmadı. Bu mektup TASLAK olup hastaya verilmemelidir.",
};

const EN: Strings = {
  title: "Imaging result — patient summary",
  greeting: (n) => `Dear ${n},`,
  intro: (mod, body, date) => `Below is a plain-language summary of your ${mod}${body ? ` (${body})` : ""} examination performed on ${date}.`,
  findingsHeading: "What was seen",
  impressionHeading: "Summary of the result",
  recommendationHeading: "Recommendations",
  none: "No additional information was entered for this section.",
  important: "This letter is a simplified summary of the report approved by the radiologist. It is not a diagnosis; please discuss the result with your physician.",
  nextSteps: "Discuss this result with the physician who referred you. In case of urgent symptoms, contact the nearest emergency department.",
  contact: (inst, doc) => `You may contact ${inst || "the institution"}${doc ? ` · ${doc}` : ""}.`,
  disclaimer: "This summary is for information only; it does not replace medical diagnosis, treatment or emergency assessment.",
  draft: "The report has not been approved by a physician yet. This letter is a DRAFT and must not be given to the patient.",
};

const DE: Strings = {
  title: "Befund — Patienteninformation",
  greeting: (n) => `Sehr geehrte/r ${n},`,
  intro: (mod, body, date) => `Nachfolgend finden Sie eine verständliche Zusammenfassung Ihrer ${mod}${body ? `-Untersuchung (${body})` : "-Untersuchung"} vom ${date}.`,
  findingsHeading: "Was wurde gesehen",
  impressionHeading: "Zusammenfassung des Befunds",
  recommendationHeading: "Empfehlungen",
  none: "Für diesen Abschnitt wurden keine zusätzlichen Angaben gemacht.",
  important: "Dieser Brief ist eine vereinfachte Zusammenfassung des vom Radiologen freigegebenen Befunds. Er ist keine Diagnose; besprechen Sie das Ergebnis mit Ihrem Arzt.",
  nextSteps: "Besprechen Sie das Ergebnis mit dem überweisenden Arzt. Bei akuten Beschwerden wenden Sie sich an die nächste Notaufnahme.",
  contact: (inst, doc) => `Sie können ${inst || "die Einrichtung"}${doc ? ` · ${doc}` : ""} kontaktieren.`,
  disclaimer: "Diese Zusammenfassung dient nur der Information; sie ersetzt keine medizinische Diagnose, Behandlung oder Notfallbeurteilung.",
  draft: "Der Befund wurde noch nicht ärztlich freigegeben. Dieser Brief ist ein ENTWURF und darf nicht an Patienten ausgegeben werden.",
};

const STRINGS: Record<LetterLang, Strings> = { tr: TR, en: EN, de: DE };

/**
 * Mektubu üretir. Boş bölümler atlanmaz; "ek bilgi yok" satırıyla gösterilir
 * (hasta boşluk görmez). Metin uzunluğu `maxChars` ile kısaltılır.
 */
export function buildPatientLetter(input: LetterInput, opts: { lang: LetterLang; level: ReadingLevel; includeFindings?: boolean; maxChars?: number }): PatientLetter {
  const lang = LETTER_LANGS.includes(opts.lang) ? opts.lang : "tr";
  const level: ReadingLevel = opts.level === "sade" ? "sade" : "standart";
  const T = STRINGS[lang];
  const maxChars = opts.maxChars ?? 600;
  const patientName = clean(input.patientName) || (lang === "en" ? "patient" : lang === "de" ? "Patient/in" : "hasta");
  const body = clean(input.bodyPart);
  const date = formatLetterDate(input.studyDate, lang);

  const paragraphs: string[] = [T.intro(clean(input.modality) || "—", body, date)];
  if (opts.includeFindings !== false) {
    const findings = summarizeText(plainify(clean(input.findingsText), lang, level), maxChars);
    paragraphs.push(`${T.findingsHeading}: ${findings || T.none}`);
  }
  const impression = summarizeText(plainify(clean(input.impression), lang, level), maxChars);
  paragraphs.push(`${T.impressionHeading}: ${impression || T.none}`);
  const rec = summarizeText(plainify(clean(input.recommendation), lang, level), maxChars);
  paragraphs.push(`${T.recommendationHeading}: ${rec || T.none}`);

  return {
    lang,
    level,
    title: T.title,
    greeting: T.greeting(patientName),
    paragraphs,
    important: T.important,
    nextSteps: T.nextSteps,
    contact: T.contact(clean(input.institution), [clean(input.doctorTitle), clean(input.doctorName)].filter(Boolean).join(" ")),
    disclaimer: T.disclaimer,
    draftWarning: input.approved ? null : T.draft,
  };
}

/** Mektubu düz metne çevirir (panoya kopyalama / e-posta gövdesi). */
export function letterToText(l: PatientLetter): string {
  return [
    l.title,
    l.greeting,
    "",
    ...l.paragraphs,
    "",
    l.nextSteps,
    l.contact,
    "",
    l.important,
    l.disclaimer,
    ...(l.draftWarning ? ["", `⚠ ${l.draftWarning}`] : []),
  ].join("\n");
}

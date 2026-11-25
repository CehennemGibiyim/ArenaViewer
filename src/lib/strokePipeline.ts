/**
 * İnme zaman çizelgesi / koddan kod çağrısı (code-stroke) hattı — a-stroke.
 *
 * Klinik gerçek: inme hastasında en kritik değişken "kapıdan iğneye/iç girişime
 * kadar geçen süre"dir. Bu modül süreç ölçümünü ve **triyaj bildirimini** yapar:
 *
 *   1. Zaman damgaları → kapı-iğne (DTN), kapı-görüntü (DTI), görüntü-karar,
 *      kapı-iç girişim (DTG) ve toplam süreler; hedeflerle karşılaştırma.
 *   2. ASPECTS + CTP (core/penumbra) özetini **tek satırlık triyaj metnine**
 *      çevirme; uygunluk penceresinde mi (0–4,5 saat tromboliz / 6–24 saat
 *      trombektomi değerlendirmesi) bilgisini ekleme.
 *   3. Koddan kod çağrısı için mükerrer kayıt koruması (aynı çalışma için tek
 *      bildirim) ve rol bazlı hedef listesi.
 *
 * Klinik karar aracı DEĞİLDİR: hedefler kılavuz önerisidir, hasta seçimi
 * radyolog/nörolog sorumluluğundadır. Hastaya ait kimlik bilgisi taşınmaz.
 */

import { aspectsScore, type AspectsResult } from "./stroke";
import { ctpSvdSummary, type CtpSvdSummary } from "./ctp";

/** Zaman damgası olayları (ISO 8601). Eksik olay `null`. */
export interface StrokeTimeline {
  /** Hastanın acile varışı */
  arrival: string | null;
  /** İlk görüntüleme (BT) başlangıcı */
  imaging: string | null;
  /** Raporlama/karar (radyolog yorumu tamamlandı) */
  interpretation: string | null;
  /** Trombolitik infüzyon başlangıcı (iğne) */
  thrombolysis: string | null;
  /** İç girişim (trombektomi) başlangıcı — kasık ponksiyonu */
  thrombectomy: string | null;
}

export const STROKE_TARGETS = {
  /** Kapı-görüntü hedefi (dk) */
  doorToImaging: 25,
  /** Kapı-iğne hedefi (dk) — kılavuz önerisi ≤60, iyi merkezlerde ≤45 */
  doorToNeedle: 60,
  /** Kapı-kasık (iç girişim) hedefi (dk) */
  doorToGroin: 90,
} as const;

export type StrokeGateKey = keyof StrokeTimeline;

export const GATE_LABELS: Record<StrokeGateKey, string> = {
  arrival: "Kapı (acil varış)",
  imaging: "Görüntüleme",
  interpretation: "Rapor/karar",
  thrombolysis: "İğne (tromboliz)",
  thrombectomy: "Kasık (trombektomi)",
};

export interface Interval {
  key: string;
  label: string;
  /** Dakika cinsinden süre; hesaplanamazsa null. */
  minutes: number | null;
  /** Kılavuz hedefi (dk) — yoksa null. */
  target: number | null;
  /** Hedef içinde mi; hedef/ölçüm yoksa null. */
  withinTarget: boolean | null;
}

const toMs = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const mins = (a: number | null, b: number | null): number | null => {
  if (a === null || b === null) return null;
  const d = (b - a) / 60000;
  // Negatif süre mantıksal hatadır (olay sırası yanlış); ölçüm verilmez.
  return d < 0 ? null : Math.round(d);
};

/**
 * Zaman damgalarından süreleri çıkarır. Negatif/ters sıralı olaylar `null`
 * döndürür (uydurma süre yok) ve `problems` listesinde raporlanır.
 */
export function strokeIntervals(tl: StrokeTimeline): { intervals: Interval[]; problems: string[]; totalMinutes: number | null } {
  const t = {
    arrival: toMs(tl.arrival),
    imaging: toMs(tl.imaging),
    interpretation: toMs(tl.interpretation),
    thrombolysis: toMs(tl.thrombolysis),
    thrombectomy: toMs(tl.thrombectomy),
  };
  const problems: string[] = [];
  const order: StrokeGateKey[] = ["arrival", "imaging", "interpretation", "thrombolysis", "thrombectomy"];
  const present = order.filter((k) => t[k] !== null);
  for (let i = 1; i < present.length; i++) {
    const prev = present[i - 1];
    const cur = present[i];
    if ((t[cur] as number) < (t[prev] as number)) {
      problems.push(`${GATE_LABELS[cur]} zamanı ${GATE_LABELS[prev]} zamanından önce görünüyor; bu süre hesaplanmadı.`);
    }
  }
  const mk = (key: string, label: string, a: number | null, b: number | null, target: number | null): Interval => {
    const minutes = mins(a, b);
    return { key, label, minutes, target, withinTarget: minutes === null || target === null ? null : minutes <= target };
  };
  const intervals: Interval[] = [
    mk("door-to-imaging", "Kapı → görüntü", t.arrival, t.imaging, STROKE_TARGETS.doorToImaging),
    mk("imaging-to-decision", "Görüntü → karar", t.imaging, t.interpretation, 20),
    mk("door-to-needle", "Kapı → iğne", t.arrival, t.thrombolysis, STROKE_TARGETS.doorToNeedle),
    mk("door-to-groin", "Kapı → kasık", t.arrival, t.thrombectomy, STROKE_TARGETS.doorToGroin),
    mk("symptom-to-groin", "Görüntü → kasık", t.imaging, t.thrombectomy, 65),
  ];
  const last = Math.max(...[t.thrombolysis, t.thrombectomy].filter((x): x is number => x !== null), 0) || null;
  const totalMinutes = last !== null ? mins(t.arrival, last) : null;
  return { intervals, problems, totalMinutes };
}

/** Hedefi aşan süreler (rapor/triyaj uyarısı için). */
export function missedTargets(intervals: Interval[]): Interval[] {
  return intervals.filter((i) => i.withinTarget === false);
}

/** Zaman çizelgesi metni (rapora/CSV'ye). */
export function timelineText(res: ReturnType<typeof strokeIntervals>): string {
  const rows = res.intervals
    .filter((i) => i.minutes !== null)
    .map((i) => `${i.label}: ${i.minutes} dk${i.target !== null ? ` (hedef ≤${i.target})` : ""}${i.withinTarget === false ? " — HEDEF AŞILDI" : ""}`);
  if (!rows.length) return "Zaman çizelgesi: ölçülebilir süre yok.";
  const out = [`Zaman çizelgesi: ${rows.join(" · ")}`];
  if (res.totalMinutes !== null) out.push(`Kapıdan tedaviye toplam: ${res.totalMinutes} dk`);
  for (const p of res.problems) out.push(`Uyarı: ${p}`);
  return out.join("\n");
}

// ─────────────── Triyaj / uygunluk penceresi ───────────────

export type StrokeWindow = "tromboliz-penceresi" | "trombektomi-penceresi" | "pencere-disi" | "belirsiz";

/** Semptom başlangıcından itibaren geçen dakika (bilinmiyorsa null). */
export function minutesSinceOnset(onsetIso: string | null, nowIso: string): number | null {
  const a = toMs(onsetIso);
  const b = toMs(nowIso);
  if (a === null || b === null) return null;
  const d = (b - a) / 60000;
  return d < 0 ? null : Math.round(d);
}

/**
 * Tedavi penceresi sınıflaması. Sınırlar kılavuz önerisidir ve **seçim ölçütü
 * değildir**: 0–270 dk tromboliz değerlendirmesi, 270–1440 dk seçilmiş
 * hastalarda trombektomi değerlendirmesi.
 */
export function strokeWindow(minutes: number | null): StrokeWindow {
  if (minutes === null) return "belirsiz";
  if (minutes <= 270) return "tromboliz-penceresi";
  if (minutes <= 1440) return "trombektomi-penceresi";
  return "pencere-disi";
}

export const WINDOW_LABEL: Record<StrokeWindow, string> = {
  "tromboliz-penceresi": "0–4,5 saat: tromboliz değerlendirmesi",
  "trombektomi-penceresi": "4,5–24 saat: seçilmiş hastada trombektomi değerlendirmesi (görüntüleme temelli)",
  "pencere-disi": "24 saatten sonra: rutin pencere dışı",
  belirsiz: "Semptom başlangıcı bilinmiyor",
};

export interface StrokeTriageInput {
  onset: string | null;
  now: string;
  aspectsAbnormal?: readonly string[];
  ctp?: CtpSvdSummary | null;
  /** Büyük damar oklüzyonu (BT anjiyo) — bilinmiyorsa null. */
  lvo?: boolean | null;
}

export interface StrokeTriage {
  window: StrokeWindow;
  windowLabel: string;
  minutesFromOnset: number | null;
  aspects: AspectsResult | null;
  /** CTP özeti varsa core/penumbra bölge sayıları. */
  coreRegions: number | null;
  penumbraRegions: number | null;
  mismatchRatio: number | null;
  /** Kısa, tek satırlık triyaj metni (bildirim/rapor için). */
  headline: string;
  /** Hekime gösterilecek uyarılar (sınır metinleriyle). */
  caveats: string[];
  severity: "kritik" | "yuksek" | "orta";
}

/**
 * Triyaj özeti: pencere + ASPECTS + CTP birleşir. Yalnızca **bilinen** veriden
 * sonuç çıkarır; eksik veri "normal" sayılmaz.
 */
export function strokeTriage(input: StrokeTriageInput): StrokeTriage {
  const minutes = minutesSinceOnset(input.onset, input.now);
  const win = strokeWindow(minutes);
  // Boş işaretleme "10 puan" demek DEĞİLDİR: hekim bölgeleri işaretlemediyse
  // ASPECTS bilinmiyor sayılır (uydurma normal skor üretilmez).
  const aspects = input.aspectsAbnormal && input.aspectsAbnormal.length > 0 ? aspectsScore(input.aspectsAbnormal) : null;
  const coreRegions = input.ctp ? input.ctp.coreIndices.length : null;
  const penumbraRegions = input.ctp ? input.ctp.penumbraIndices.length : null;
  const mismatchRatio = input.ctp ? input.ctp.mismatchRatio : null;

  const caveats: string[] = [];
  if (aspects && aspects.score <= 5) caveats.push(`ASPECTS ${aspects.score}: geniş alan tutulumu (≤5) — trombektomi yararı azalır.`);
  if (coreRegions !== null && penumbraRegions !== null) {
    if (coreRegions === 0 && penumbraRegions === 0) caveats.push("CTP: core/penumbra adayı yok — eşikler rölatiftir, hekim doğrulaması gerekir.");
    else if (mismatchRatio === null) caveats.push("CTP: core yok ama penumbra var (mismatch oranı hesaplanamaz).");
    else if (mismatchRatio < 1.2) caveats.push(`CTP mismatch oranı ${mismatchRatio.toFixed(2)} (<1,2): kurtarılabilir doku sınırlı olabilir.`);
  }
  if (input.lvo === true) caveats.push("Büyük damar oklüzyonu bildirildi — trombektomi merkezi ile iletişim.");
  if (win === "pencere-disi") caveats.push("Semptom başlangıcı 24 saati geçti: rutin pencerede değil.");
  if (win === "belirsiz") caveats.push("Semptom başlangıcı bilinmiyor: pencere 'uyanış inmesi' protokolüne göre ayrıca değerlendirilmeli.");

  // Öncelik: büyük damar oklüzyonu ya da core>0 → kritik; pencere içi → yüksek.
  const severity: StrokeTriage["severity"] =
    input.lvo === true || (coreRegions !== null && coreRegions > 0) ? "kritik" : win === "tromboliz-penceresi" || win === "trombektomi-penceresi" ? "yuksek" : "orta";

  const parts: string[] = ["İNME TRİYAJ"];
  if (minutes !== null) parts.push(`başlangıçtan ${minutes} dk`);
  parts.push(WINDOW_LABEL[win]);
  if (aspects) parts.push(`ASPECTS ${aspects.score}`);
  if (coreRegions !== null) parts.push(`core ${coreRegions} / penumbra ${penumbraRegions} bölge`);
  if (input.lvo !== null && input.lvo !== undefined) parts.push(input.lvo ? "BVO: var" : "BVO: yok");
  const headline = parts.join(" · ");

  return { window: win, windowLabel: WINDOW_LABEL[win], minutesFromOnset: minutes, aspects, coreRegions, penumbraRegions, mismatchRatio, headline, caveats, severity };
}

// ─────────────── Koddan kod çağrısı (bildirim) ───────────────

export interface CodeStrokeTarget {
  /** Kanal/kişi etiketi */
  role: string;
  /** `notifyChannels` kanal kimliği ya da boş (uygulama içi bildirim) */
  channel: string;
  /** İlk yanıt için süre (dk) */
  slaMinutes: number;
}

export const CODE_STROKE_TARGETS: CodeStrokeTarget[] = [
  { role: "İnme ekibi (nörolog)", channel: "", slaMinutes: 10 },
  { role: "Girişimsel radyoloji", channel: "", slaMinutes: 15 },
  { role: "Anestezi", channel: "", slaMinutes: 20 },
];

export interface CodeStrokeState {
  studyUid: string;
  /** Aynı çalışma için daha önce çağrı yapıldı mı */
  existing: { id: number; createdAt: string; acked: boolean } | null;
}

export interface CodeStrokeDecision {
  /** Yeni bildirim oluşturulsun mu (mükerrer koruma) */
  create: boolean;
  reason: string;
  message: string;
  severity: "kritik" | "yuksek";
}

/**
 * Mükerrer kayıt koruması: aynı çalışma için açık bir çağrı varsa yenisi
 * açılmaz (ekip zaten uyarıldı). Bildirim metni triyaj başlığını taşır.
 */
export function codeStrokeDecision(triage: StrokeTriage, state: CodeStrokeState): CodeStrokeDecision {
  const message = `KOD İNME — ${triage.headline}`;
  if (state.existing && !state.existing.acked) {
    return {
      create: false,
      reason: `Bu çalışma için açık bir inme çağrısı var (#${state.existing.id}); tekrar bildirim gönderilmedi.`,
      message,
      severity: triage.severity === "kritik" ? "kritik" : "yuksek",
    };
  }
  return {
    create: true,
    reason: state.existing ? `Önceki çağrı (#${state.existing.id}) yanıtlanmış; yeni çağrı açılıyor.` : "Bu çalışma için açık çağrı yok.",
    message,
    severity: triage.severity === "kritik" ? "kritik" : "yuksek",
  };
}

/** Bildirim metni (kanal başına aynı içerik, hasta kimliği yok). */
export function notificationBody(triage: StrokeTriage, studyUid: string): string {
  const lines = [
    triage.headline,
    `Çalışma: ${studyUid}`,
    ...triage.caveats.map((c) => `• ${c}`),
    "Bu bir ön triyaj bildirimidir; tanı ve tedavi kararı hekim değerlendirmesine tabidir.",
  ];
  return lines.join("\n");
}

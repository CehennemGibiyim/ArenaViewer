/**
 * RECIST 1.1 tamamlayıcıları (c-recist-full): hedef seçim/limit denetimi,
 * lenf nodu kısa eksen kuralı, non-hedef lezyon bileşeni ve genel yanıt.
 *
 * Neden ayrı: `recist.ts` yalnız TOPLAM çap değişimini hesaplar ve RESIST'in
 * "hedef seçimi, organ limitleri, lenf nodu, non-hedef, yeni lezyon" parçalarını
 * hekime bırakır. Burada mekanik kısımlar kural olarak uygulanır:
 *
 *  - Hedef lezyon: organ başına en fazla 2, toplam en fazla 5 (RECIST 1.1);
 *    her hedef ≥10 mm (lenf nodu için kısa eksen ≥15 mm).
 *  - Lenf nodu: ölçüm KISA eksenden yapılır ve toplama girer; <10 mm normal
 *    sayılır (hedef olamaz), 10–<15 mm hedef olarak izlenebilir.
 *  - Non-hedef: kayboldu / stabil / kesin ilerleme.
 *  - Genel yanıt: hedef + non-hedef + yeni lezyon bileşkesi (CR/PR/SD/PD).
 *
 * Klinik karar aracı değildir; ölçümler ve seçim hekim doğrulamasına tabidir.
 */
import { recist11, RECIST_LABELS, type RecistResponse, type RecistTrackLike } from "./recist";
import { lymphNodeCategory } from "./lesionTracking";

export const RECIST_LIMITS = { perOrgan: 2, total: 5, minTargetMm: 10, nodeTargetMm: 15 } as const;

export type OrganKey = string;

export interface CandidateLesion {
  id: string;
  label: string;
  /** Organ/bölge (limitler organ bazında) */
  organ: OrganKey;
  /** En uzun çap (lenf nodu için KISA eksen) */
  sizeMm: number | null;
  lymphNode?: boolean;
  /** Hekim hedef olarak işaretledi mi */
  selected: boolean;
}

export interface SelectionIssue {
  id: string;
  severity: "hata" | "uyarı";
  message: string;
}

export interface SelectionResult {
  targets: CandidateLesion[];
  issues: SelectionIssue[];
  /** Hedef sayısı (organ/limit denetimi sonrası geçerli) */
  targetCount: number;
  perOrgan: Record<string, number>;
}

/**
 * Hedef lezyon seçimini denetler. Seçim SİLİNMEZ (hekim kararı korunur); limit
 * aşımı ve ölçüt ihlalleri `issues` ile bildirilir, `targets` yalnız geçerli
 * lezyonları döndürür.
 */
export function validateTargets(all: CandidateLesion[]): SelectionResult {
  const issues: SelectionIssue[] = [];
  const selected = all.filter((l) => l.selected);
  const perOrgan: Record<string, number> = {};
  const valid: CandidateLesion[] = [];

  for (const l of selected) {
    const size = l.sizeMm;
    const min = l.lymphNode ? RECIST_LIMITS.nodeTargetMm : RECIST_LIMITS.minTargetMm;
    if (size === null || !Number.isFinite(size) || size <= 0) {
      issues.push({ id: l.id, severity: "hata", message: `${l.label}: ölçüm yok — hedef lezyon olamaz.` });
      continue;
    }
    if (size < min) {
      issues.push({
        id: l.id, severity: "hata",
        message: `${l.label}: ${size} mm < ${min} mm — ${l.lymphNode ? "lenf nodu hedefi kısa eksen ≥15 mm olmalı" : "hedef lezyon ≥10 mm olmalı"} (non-hedef olarak izlenebilir).`,
      });
      continue;
    }
    perOrgan[l.organ] = (perOrgan[l.organ] ?? 0) + 1;
    if (perOrgan[l.organ] > RECIST_LIMITS.perOrgan) {
      issues.push({ id: l.id, severity: "uyarı", message: `${l.label}: ${l.organ} için en fazla ${RECIST_LIMITS.perOrgan} hedef lezyon seçilebilir.` });
      continue;
    }
    if (valid.length >= RECIST_LIMITS.total) {
      issues.push({ id: l.id, severity: "uyarı", message: `${l.label}: toplam hedef lezyon sınırı ${RECIST_LIMITS.total} — bu lezyon toplama girmez.` });
      continue;
    }
    valid.push(l);
  }
  return { targets: valid, issues, targetCount: valid.length, perOrgan };
}

export type NonTargetResponse = "CR" | "non-CR/non-PD" | "PD" | "belirsiz";

/** Non-hedef lezyonların bileşke durumu. */
export function nonTargetResponse(statuses: NonTargetStatus[]): NonTargetResponse {
  if (!statuses.length) return "belirsiz";
  if (statuses.includes("artis")) return "PD";
  if (statuses.every((s) => s === "kayboldu")) return "CR";
  if (statuses.every((s) => s === "belirsiz")) return "belirsiz";
  return "non-CR/non-PD";
}

export type NonTargetStatus = "kalici" | "artis" | "kayboldu" | "belirsiz";

export interface OverallInput {
  target: RecistResponse;
  nonTarget: NonTargetResponse;
  newLesion: boolean;
}

export interface OverallResult {
  response: RecistResponse;
  label: string;
  reason: string;
}

/**
 * Genel yanıt (RECIST 1.1 tablo): yeni lezyon → PD her durumda; hedef CR +
 * non-hedef CR → CR; hedef veya non-hedef PD → PD; aksi halde hedef yanıtı
 * geçerlidir (non-hedef non-CR/non-PD PR'yi engellemez).
 */
export function overallResponse(i: OverallInput): OverallResult {
  if (i.newLesion) return { response: "PD", label: RECIST_LABELS.PD, reason: "Yeni lezyon → PD (hedef/non-hedef yanıttan bağımsız)." };
  if (i.nonTarget === "PD") return { response: "PD", label: RECIST_LABELS.PD, reason: "Non-hedef lezyonlarda kesin ilerleme → PD." };
  if (i.target === "CR" && i.nonTarget === "CR") return { response: "CR", label: RECIST_LABELS.CR, reason: "Hedef ve non-hedef lezyonların tümü kayboldu." };
  if (i.target === "CR" && i.nonTarget !== "CR") {
    return { response: "PR", label: RECIST_LABELS.PR, reason: "Hedefler kayboldu ancak non-hedef tam yanıt yok → PR." };
  }
  if (i.target === "NONE") return { response: "NONE", label: "Değerlendirilemedi", reason: "Hedef lezyon ölçümü yetersiz." };
  return { response: i.target, label: RECIST_LABELS[i.target], reason: "Hedef lezyon yanıtı geçerli (non-hedef PR'yi engellemez)." };
}

export interface FullRecistInput {
  tracks: RecistTrackLike[];
  candidates: CandidateLesion[];
  nonTargetStatuses: NonTargetStatus[];
  newLesion?: boolean;
  allDisappeared?: boolean;
}

export interface FullRecistResult {
  selection: SelectionResult;
  target: ReturnType<typeof recist11>;
  nonTarget: NonTargetResponse;
  overall: OverallResult;
  /** Rapor metni (hekim onayına tabidir) */
  text: string;
}

/** Tam RECIST 1.1 değerlendirmesi: seçim + hedef + non-hedef + genel yanıt. */
export function fullRecist(input: FullRecistInput): FullRecistResult {
  const selection = validateTargets(input.candidates);
  const targetIds = new Set(selection.targets.map((t) => t.id));
  const tracks = input.tracks.filter((t) => targetIds.size === 0 || targetIds.has(t.id));
  const target = recist11(tracks, { newLesion: input.newLesion, allDisappeared: input.allDisappeared });
  const nonTarget = nonTargetResponse(input.nonTargetStatuses);
  const overall = overallResponse({
    target: target?.response ?? "NONE",
    nonTarget,
    newLesion: input.newLesion === true,
  });
  const lines = [
    `Hedef lezyon: ${target ? `${target.responseLabel} (bazal ${target.baselineSumMm.toFixed(1)} mm → ${target.followUpSumMm.toFixed(1)} mm, ${target.deltaPct === null ? "-" : `${target.deltaPct.toFixed(1)} %`})` : "değerlendirilemedi (yeterli ölçüm yok)"}`,
    `Hedef seçimi: ${selection.targetCount}/${RECIST_LIMITS.total} lezyon${selection.issues.length ? ` · ${selection.issues.length} uyarı` : ""}`,
    `Non-hedef: ${nonTarget}`,
    `GENEL YANIT: ${overall.label} — ${overall.reason}`,
    "Ölçümler ve lezyon seçimi hekim doğrulamasına tabidir; bu bir klinik karar aracı değildir.",
  ];
  return { selection, target, nonTarget, overall, text: lines.join("\n") };
}

/** Lenf nodu seçim/ölçüm özeti (kısa eksen kuralı). */
export function lymphNodeSelection(cands: CandidateLesion[]): { id: string; label: string; category: string; target: boolean }[] {
  return cands
    .filter((c) => c.lymphNode)
    .map((c) => ({ id: c.id, label: c.label, category: lymphNodeCategory(c.sizeMm ?? null), target: c.selected && (c.sizeMm ?? 0) >= RECIST_LIMITS.nodeTargetMm }));
}

/**
 * Klinik doğrulama ve alt grup (demografik) performans izleme — t-validation.
 *
 * Amaç: bir modelin "genel doğruluğu" tek başına yeterli değildir; yaş/cinsiyet/
 * modalite gibi alt gruplarda performans düşüyorsa bu **yanlılık** işaretidir.
 * Bu modül ham (anonymous) etiketli olgulardan alt grup metrikleri, güven
 * aralıkları, sürüm karşılaştırması ve **kabul eşiği** değerlendirmesi üretir.
 *
 * Önemli: buradaki hesap, gerçek klinik doğrulama çalışmasının (protokol, etiket
 * bağımsızlığı, körleme, örneklem büyüklüğü) yerini **tutmaz**; o çalışmanın
 * ölçüm aracıdır. Eşik altı sonuç "yayına uygun değil" demektir.
 */

import { wilsonInterval, MIN_LABELS, type Interval } from "./confidenceInterval";

/** Tek bir etiketli olgu (hasta kimliği taşınmaz). */
export interface ValidationCase {
  caseId: string;
  /** Model sürümü (ör. "ich-v1.2"); sürüm bazlı karşılaştırma için. */
  modelVersion: string;
  /** Model pozitif dedi mi. */
  predicted: boolean;
  /** Referans (klinik gerçek): pozitif mi. */
  actual: boolean;
  /** Alt grup anahtarları: yaş bandı, cinsiyet, modalite... */
  groups: Record<string, string>;
}

export interface GroupMetric {
  group: string;
  value: string;
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  sensitivity: number | null;
  specificity: number | null;
  ppv: number | null;
  npv: number | null;
  /** Duyarlılık %95 Wilson aralığı. */
  sensitivityCi: Interval | null;
  /** Doğruluk (accuracy) ve aralığı. */
  accuracy: number | null;
  accuracyCi: Interval | null;
  /** n < MIN_LABELS ise metrikler **gösterge** niteliğinde; karar için yetersiz. */
  reliable: boolean;
}

/** Yaş bandı: 18 altı, 18–39, 40–59, 60–74, 75+. */
export function ageBand(age: number | null | undefined): string {
  if (age === null || age === undefined || !Number.isFinite(age) || age < 0) return "bilinmiyor";
  if (age < 18) return "<18";
  if (age < 40) return "18-39";
  if (age < 60) return "40-59";
  if (age < 75) return "60-74";
  return "75+";
}

/** DICOM yaş alanı ("067Y", "045D", "012M") → yıl; okunamazsa null. */
export function parseDicomAge(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(\d{1,3})\s*([YMD])\s*$/i.exec(raw);
  if (!m) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n < 150 ? Math.floor(n) : null;
  }
  const v = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "Y") return v;
  if (unit === "M") return Math.floor(v / 12);
  return Math.floor(v / 365);
}

/** Cinsiyet etiketini normalleştirir (DICOM M/F/O/U). */
export function normSex(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  if (s === "M" || s === "E" || s === "ERKEK") return "erkek";
  if (s === "F" || s === "K" || s === "KADIN") return "kadin";
  return "bilinmiyor";
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** Tek bir alt grup değeri için karışıklık matrisi ve metrikler. */
export function groupMetric(group: string, value: string, cases: ValidationCase[]): GroupMetric {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const c of cases) {
    if (c.predicted && c.actual) tp++;
    else if (c.predicted && !c.actual) fp++;
    else if (!c.predicted && !c.actual) tn++;
    else fn++;
  }
  const n = tp + fp + tn + fn;
  const sens = pct(tp, tp + fn);
  const spec = pct(tn, tn + fp);
  const correct = tp + tn;
  return {
    group, value, n, tp, fp, tn, fn,
    sensitivity: sens,
    specificity: spec,
    ppv: pct(tp, tp + fp),
    npv: pct(tn, tn + fn),
    sensitivityCi: tp + fn > 0 ? wilsonInterval(tp, tp + fn) : null,
    accuracy: pct(correct, n),
    accuracyCi: n > 0 ? wilsonInterval(correct, n) : null,
    reliable: n >= MIN_LABELS,
  };
}

/** Belirtilen alt grup boyutlarına göre tüm metrikler (sıralı: n azalan). */
export function subgroupMetrics(cases: ValidationCase[], groupKeys: string[]): GroupMetric[] {
  const out: GroupMetric[] = [];
  for (const key of groupKeys) {
    const vals = new Set<string>();
    for (const c of cases) vals.add(c.groups[key] ?? "bilinmiyor");
    for (const v of [...vals].sort((a, b) => a.localeCompare(b, "tr"))) {
      out.push(groupMetric(key, v, cases.filter((c) => (c.groups[key] ?? "bilinmiyor") === v)));
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group, "tr") || b.n - a.n);
}

export interface FairnessFinding {
  severity: "bilgi" | "uyari" | "kritik";
  group: string;
  message: string;
  /** En iyi ve en kötü duyarlılık arasındaki fark (yüzde puan). */
  gap?: number;
}

/** Kabul eşiği: klinik kullanım için asgari duyarlılık/özgüllük ve asgari n. */
export interface AcceptanceThreshold {
  minSensitivity: number;
  minSpecificity: number;
  minN: number;
  /** Alt gruplar arası izin verilen en büyük duyarlılık farkı (yüzde puan). */
  maxSensitivityGap: number;
}

export const DEFAULT_THRESHOLD: AcceptanceThreshold = {
  minSensitivity: 0.8,
  minSpecificity: 0.7,
  minN: 100,
  maxSensitivityGap: 0.1,
};

/**
 * Yanlılık taraması: her alt grup boyutunda en iyi/en kötü duyarlılık farkı
 * eşiği aşarsa uyarı; güvenilir n'e sahip gruplar arasında fark büyükse kritik.
 */
export function fairnessScan(metrics: GroupMetric[], threshold: AcceptanceThreshold = DEFAULT_THRESHOLD): FairnessFinding[] {
  const out: FairnessFinding[] = [];
  const byGroup = new Map<string, GroupMetric[]>();
  for (const m of metrics) {
    if (m.sensitivity === null) continue;
    const arr = byGroup.get(m.group) ?? [];
    arr.push(m);
    byGroup.set(m.group, arr);
  }
  for (const [group, arr] of byGroup) {
    const reliable = arr.filter((m) => m.reliable);
    const use = reliable.length >= 2 ? reliable : arr;
    const best = use.reduce((a, b) => ((b.sensitivity ?? 0) > (a.sensitivity ?? 0) ? b : a));
    const worst = use.reduce((a, b) => ((b.sensitivity ?? 0) < (a.sensitivity ?? 0) ? b : a));
    const gap = Math.round(((best.sensitivity ?? 0) - (worst.sensitivity ?? 0)) * 1000) / 1000;
    if (gap > threshold.maxSensitivityGap) {
      const severity: FairnessFinding["severity"] = reliable.length >= 2 ? "kritik" : "uyari";
      out.push({
        severity,
        group,
        gap,
        message:
          `${group}: en düşük duyarlılık ${worst.value} (%${Math.round((worst.sensitivity ?? 0) * 100)}), ` +
          `en yüksek ${best.value} (%${Math.round((best.sensitivity ?? 0) * 100)}) — fark ${Math.round(gap * 100)} puan` +
          (severity === "uyari" ? " (n yetersiz: gösterge)" : "") + ".",
      });
    } else if (arr.some((m) => !m.reliable)) {
      out.push({
        severity: "bilgi",
        group,
        gap,
        message: `${group}: n < ${MIN_LABELS} olan alt gruplar var; metrikler gösterge niteliğinde.`,
      });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "kritik" ? -1 : b.severity === "kritik" ? 1 : a.severity === "uyari" ? -1 : 1));
}

export interface AcceptanceResult {
  passed: boolean;
  checks: Array<{ name: string; value: string; ok: boolean; detail: string }>;
}

/** Model, klinik kullanım eşiğini geçiyor mu? */
export function acceptanceCheck(cases: ValidationCase[], threshold: AcceptanceThreshold = DEFAULT_THRESHOLD): AcceptanceResult {
  const overall = groupMetric("genel", "tümü", cases);
  const checks: AcceptanceResult["checks"] = [];
  checks.push({
    name: "Örneklem",
    value: `${overall.n}`,
    ok: overall.n >= threshold.minN,
    detail: `En az ${threshold.minN} etiketli olgu gerekir${overall.n < threshold.minN ? ` (eksik: ${threshold.minN - overall.n})` : ""}.`,
  });
  const sens = overall.sensitivity;
  checks.push({
    name: "Duyarlılık",
    value: sens === null ? "—" : `%${Math.round(sens * 100)}`,
    ok: sens !== null && sens >= threshold.minSensitivity,
    detail: `Eşik %${Math.round(threshold.minSensitivity * 100)}; %95 aralık ${overall.sensitivityCi ? `${Math.round(overall.sensitivityCi.lo * 100)}–${Math.round(overall.sensitivityCi.hi * 100)}` : "—"}.`,
  });
  const spec = overall.specificity;
  checks.push({
    name: "Özgüllük",
    value: spec === null ? "—" : `%${Math.round(spec * 100)}`,
    ok: spec !== null && spec >= threshold.minSpecificity,
    detail: `Eşik %${Math.round(threshold.minSpecificity * 100)}.`,
  });
  const met = subgroupMetrics(cases, ["yas", "cinsiyet"]);
  const fair = fairnessScan(met, threshold).filter((f) => f.severity === "kritik");
  checks.push({
    name: "Alt grup tutarlılığı",
    value: fair.length === 0 ? "uygun" : `${fair.length} kritik fark`,
    ok: fair.length === 0,
    detail: fair.length === 0 ? `Alt gruplar arası duyarlılık farkı ≤ ${Math.round(threshold.maxSensitivityGap * 100)} puan.` : fair.map((f) => f.message).join(" "),
  });
  return { passed: checks.every((c) => c.ok), checks };
}

/** Sürüm karşılaştırması: iki model sürümünün duyarlılık farkı (Wilson ile). */
export function compareVersions(
  cases: ValidationCase[],
  vA: string,
  vB: string,
): { a: GroupMetric; b: GroupMetric; deltaSens: number | null; overlap: boolean; note: string } {
  const a = groupMetric("sürüm", vA, cases.filter((c) => c.modelVersion === vA));
  const b = groupMetric("sürüm", vB, cases.filter((c) => c.modelVersion === vB));
  const deltaSens = a.sensitivity !== null && b.sensitivity !== null ? Math.round((b.sensitivity - a.sensitivity) * 1000) / 1000 : null;
  const overlap = !!(a.sensitivityCi && b.sensitivityCi && a.sensitivityCi.lo <= b.sensitivityCi.hi && b.sensitivityCi.lo <= a.sensitivityCi.hi);
  const note = !a.reliable || !b.reliable
    ? `Bir sürümde n < ${MIN_LABELS}; karşılaştırma gösterge niteliğinde.`
    : deltaSens === null
      ? "Sürümlerden birinde duyarlılık hesaplanamadı (pozitif olgu yok)."
      : overlap
        ? "Güven aralıkları örtüşüyor: sürümler arasında anlamlı fark gösterilemedi."
        : `Güven aralıkları örtüşmüyor: ${vB} ${deltaSens >= 0 ? "daha iyi" : "daha kötü"} (${deltaSens >= 0 ? "+" : ""}${Math.round(deltaSens * 100)} puan).`;
  return { a, b, deltaSens, overlap, note };
}

export interface ShadowPerformance {
  studied: number;
  reviewed: number;
  confirmed: number;
  /** Klinisyenin onayladığı gölge bulgu oranı (PPV vekili). */
  confirmRate: number | null;
  /** Klinisyen raporunda yer alıp AI'nın kaçırdığı bulgu sayısı (duyarlılık vekili). */
  missedByAi: number;
  note: string;
}

/**
 * Gölge mod izleme özeti: gölge kayıtları ile hekim etiketleri birleşir.
 * "Gölge" verisi tanım gereği **seçilmiş** örnektir (hekimin baktığı olgular);
 * bu yüzden duyarlılık vekili aşağı yönlü sapabilir — rapor bunu yazar.
 */
export function shadowPerformance(
  records: Array<{ studyUid: string; findingCount: number; reviewed: boolean; confirmed: number }>,
  missedByAi: number,
): ShadowPerformance {
  const studied = records.length;
  const reviewed = records.filter((r) => r.reviewed).length;
  const totalFindings = records.reduce((n, r) => n + r.findingCount, 0);
  const confirmed = records.reduce((n, r) => n + r.confirmed, 0);
  return {
    studied,
    reviewed,
    confirmed,
    confirmRate: totalFindings > 0 ? Math.round((confirmed / totalFindings) * 1000) / 1000 : null,
    missedByAi,
    note:
      studied === 0
        ? "Gölge kaydı yok; gölge mod kapalı olabilir."
        : `${reviewed}/${studied} gölge olgu hekim tarafından etiketlendi. Gölge verisi seçilmiş örnektir; ` +
          `duyarlılık/yanlılık kararı için kontrollü çalışma (ardışık, körlemesiz olmayan) gerekir.`,
  };
}

/** Doğrulama kaydının kimliği (hangi veri, hangi eşik, hangi sürüm). */
export function validationFingerprint(cases: ValidationCase[], threshold: AcceptanceThreshold = DEFAULT_THRESHOLD): string {
  const versions = [...new Set(cases.map((c) => c.modelVersion))].sort().join(",");
  const sorted = [...cases].map((c) => `${c.caseId}:${c.modelVersion}:${c.predicted ? 1 : 0}:${c.actual ? 1 : 0}`).sort().join("|");
  // Basit FNV-1a (kriptografik değil; kayıt anahtarı için yeterli).
  let h = 0x811c9dc5;
  for (const ch of `${versions}#${threshold.minSensitivity}#${threshold.minSpecificity}#${threshold.minN}#${sorted}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `vd-${h.toString(16).padStart(8, "0")}`;
}

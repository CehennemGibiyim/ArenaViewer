/**
 * Hekim geri bildirim döngüsü (a-feedback) — AI performans çekirdeği.
 *
 * Neden: Yönetim → AI performans panosu bugüne kadar yalnız **kesinliği (PPV)**
 * hesaplıyordu. Duyarlılık (AI'nın kaçırdığı bulgular), özgüllük ve yanlış pozitif
 * listesi yoktu — oysa PPV tek başına "model iyi mi" sorusunu yanıtlamaz:
 * her şeyi "bulgu var" diye işaretleyen bir model %100 duyarlılıkla %10 PPV alır.
 *
 * Bu modül, **hekim kararlarından** (onay/ret/düzenleme) ve **hekimin elle eklediği
 * "AI kaçırdı" bulgularından** bir doğruluk tablosu çıkarır. Saf hesap; DB/HTTP yok.
 *
 * ── Dürüst kapsam (bunu pano ve belgeler de yazar) ──────────────────────────
 * 1. **Referans standardı hekimin kendisidir.** "Doğru" = hekimin onayladığı bulgu.
 *    Altın standart (patoloji, takip, ikinci okuma) YOKTUR; bu yüzden ölçülen şey
 *    modelin klinik doğruluğu değil, **hekimle uyumudur**.
 * 2. **Özgüllük için gerçek negatif gerekir.** Negatifler (AI'nın aday üretmediği ve
 *    hekimin de bulgu yazmadığı çalışmalar) çoğu durumda kayıtlı değildir. Bu yüzden
 *    özgüllük yalnız "temiz çalışma" (`casesWithNoFinding`/`cleanStudies`) verildiğinde
 *    hesaplanır; verilmezse **null** döner — uydurulmaz.
 * 3. **Duyarlılık yalnız elle eklenen bulgu varsa anlamlıdır.** `missed` sayısı
 *    hekimin "AI kaçırdı" diye eklediği bulgulardır; hekim eklemeyi unutursa
 *    duyarlılık olduğundan **yüksek** görünür. Bu bir ölçüm yanlılığıdır, gizlenmez.
 * 4. **Örneklem içi metriktir**, dış doğrulama yerine geçmez; n küçükse güven aralığı
 *    geniştir (Wilson aralığı verilir, nokta tahmini tek başına gösterilmez).
 * 5. **Güven skoru kalibre değildir** (`confidenceKind: "heuristic"`); eşik önerisi
 *    bu yüzden "öneri"dir, otomatik uygulanmaz.
 */

/** Bir bulgu için hekim kararı (uygulamanın `FindingApprovalStatus` + yokluk). */
export type ReviewDecision = "onaylandi" | "reddedildi" | "duzenlendi" | "bekliyor";

/** Tek bir AI aday bulgusunun geri bildirim satırı. */
export interface FeedbackFinding {
  id: string;
  engine: string;
  category: string;
  label: string;
  /** Sağlayıcı: "AI adayı" ise false; hekimin elle eklediği (AI kaçırdı) ise true. */
  manual: boolean;
  /** 0–1 model skoru; skor yoksa null (kalibrasyon/eşik hesabından çıkar). */
  score: number | null;
  decision: ReviewDecision;
  /** Hekim gerekçesi (reddedilen/düzenlenen için) — yanlış pozitif listesinde gösterilir. */
  reason?: string;
  /** İzlenebilirlik: hangi çalışma/rapor. Hasta kimliği TAŞINMAZ. */
  studyRef?: string;
  slice?: number;
  at?: string;
}

/** Çalışma düzeyinde gerçek negatif bilgisi (özgüllük için). */
export interface CleanCase {
  engine: string;
  category: string;
  /** Bu çalışmada AI adayı yok VE hekim bulgu yazmadı. */
  clean: boolean;
}

/**
 * **Motor düzeyi** satır: duyarlılık/özgüllük burada hesaplanır.
 *
 * Neden motor düzeyi: hekimin elle eklediği "AI kaçırdı" bulgusu ve "temiz çalışma"
 * bilgisi hangi AI **kategorisine** ait olduğunu söylemez. Kategoriye zorla
 * dağıtmak uydurma olurdu; bu yüzden duyarlılık/özgüllük motor toplamında,
 * kesinlik (PPV) hem motor hem kategori düzeyinde verilir.
 */
export interface EngineRow {
  engine: string;
  /** AI'nın gösterdiği aday sayısı */
  shown: number;
  approved: number;
  rejected: number;
  edited: number;
  pending: number;
  /** Hekimin "AI kaçırdı" diye eklediği bulgu sayısı */
  missed: number;
  /** Karar verilmiş AI adayı (onay + düzenleme + ret); bekleyen hariç. */
  decidedAi: number;
  /**
   * Duyarlılık = (onaylanan + düzenlenen) / (onaylanan + düzenlenen + kaçırılan).
   * Düzenlenen bulgu "gerçek pozitif" sayılır: hekim bulgunun **varlığını** kabul edip
   * içeriğini düzeltmiştir. Bu bir varsayımdır ve belgede yazılıdır.
   */
  sensitivity: number | null;
  /** Özgüllük = gerçek negatif / (gerçek negatif + reddedilen). Temiz çalışma yoksa null. */
  specificity: number | null;
  /** Kesinlik = (onay + düzenleme) / (onay + düzenleme + ret). */
  ppv: number | null;
  /** Gerçek negatif sayısı (temiz çalışma verildiyse) */
  trueNegatives: number | null;
  /** Duyarlılık için %95 Wilson aralığı */
  sensitivityCI: [number, number] | null;
  ppvCI: [number, number] | null;
}

/** **Kategori düzeyi** satır: yalnız kesinlik (PPV) ve karar sayıları. */
export interface CategoryRow {
  engine: string;
  category: string;
  shown: number;
  approved: number;
  rejected: number;
  edited: number;
  pending: number;
  decidedAi: number;
  ppv: number | null;
  ppvCI: [number, number] | null;
}

export interface FalsePositive {
  engine: string;
  category: string;
  label: string;
  reason: string;
  slice: number | null;
  studyRef: string | null;
  at: string | null;
  score: number | null;
}

export interface MissedFinding {
  engine: string;
  category: string;
  label: string;
  slice: number | null;
  studyRef: string | null;
  at: string | null;
}

export interface ThresholdPoint {
  threshold: number;
  /** Bu eşikte tutulan aday / toplam aday (hekim onayı pozitif kabul) */
  recall: number | null;
  /** Bu eşikte tutulan adayların kesinliği */
  precision: number | null;
  kept: number;
  dropped: number;
}

export interface FeedbackReport {
  /** Motor düzeyi (duyarlılık/özgüllük burada) */
  engines: EngineRow[];
  /** Kategori düzeyi (kesinlik) */
  rows: CategoryRow[];
  falsePositives: FalsePositive[];
  missed: MissedFinding[];
  /** Karar verilen toplam (AI + elle) — örneklem büyüklüğü göstergesi */
  totals: {
    aiShown: number;
    decided: number;
    approved: number;
    rejected: number;
    edited: number;
    missed: number;
    cleanStudies: number;
    sensitivity: number | null;
    specificity: number | null;
    ppv: number | null;
  };
  /** Eşik önerisi (yalnız skoru olan AI adayları) */
  thresholdCurve: ThresholdPoint[];
  suggestedThreshold: number | null;
  suggestedThresholdWhy: string;
  warnings: string[];
  note: string;
}

export const FP_LIST_MAX = 50;
export const MISSED_LIST_MAX = 50;
export const THRESHOLD_GRID = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
/** Eşik önerisi için en az karar sayısı; altında öneri YAPILMAZ. */
export const THRESHOLD_MIN_DECIDED = 20;

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * Wilson %95 güven aralığı (n küçükken normal yaklaşımdan doğru).
 * p null ise null döner.
 */
export function wilson95(successes: number, n: number): [number, number] | null {
  if (!(n > 0) || successes < 0 || successes > n) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Hekim kararı metnini güvenli biçime indirger (log/kayıt enjeksiyonu yok). */
const clean = (s: unknown, max = 160) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const keyOf = (engine: string, category: string) => `${engine}|${category}`;

/**
 * Ham geri bildirim satırlarını motor/kategori bazında özetler.
 * `cleanCases` verilmezse özgüllük null (uydurulmaz).
 */
export function summarizeFeedback(findings: FeedbackFinding[], cleanCases: CleanCase[] = []): FeedbackReport {
  const cats = new Map<string, CategoryRow>();
  const catFor = (engine: string, category: string): CategoryRow => {
    const k = keyOf(engine, category);
    let r = cats.get(k);
    if (!r) {
      r = { engine, category, shown: 0, approved: 0, rejected: 0, edited: 0, pending: 0, decidedAi: 0, ppv: null, ppvCI: null };
      cats.set(k, r);
    }
    return r;
  };
  // Motor düzeyi ham sayaçlar (elle eklenen bulgu ve temiz çalışma buraya yazılır).
  const eng = new Map<string, { shown: number; approved: number; rejected: number; edited: number; pending: number; missed: number; tn: number; tnKnown: boolean }>();
  const engFor = (engine: string) => {
    let e = eng.get(engine);
    if (!e) {
      e = { shown: 0, approved: 0, rejected: 0, edited: 0, pending: 0, missed: 0, tn: 0, tnKnown: false };
      eng.set(engine, e);
    }
    return e;
  };

  const falsePositives: FalsePositive[] = [];
  const missed: MissedFinding[] = [];
  for (const c of cleanCases) {
    if (!c.clean) continue;
    const e = engFor(clean(c.engine, 60) || "?");
    e.tn++;
    e.tnKnown = true;
  }

  for (const f of findings) {
    const engine = clean(f.engine, 60) || "?";
    const category = clean(f.category, 80) || "?";
    const e = engFor(engine);
    if (f.manual) {
      // "AI kaçırdı" bulguları: shown'a SAYILMAZ, duyarlılığın paydasına girer.
      e.missed++;
      if (missed.length < MISSED_LIST_MAX) {
        missed.push({
          engine, category, label: clean(f.label, 120) || "(adsız bulgu)",
          slice: Number.isFinite(f.slice ?? NaN) ? (f.slice as number) : null,
          studyRef: f.studyRef ? clean(f.studyRef, 40) : null,
          at: f.at ? clean(f.at, 30) : null,
        });
      }
      continue;
    }
    const r = catFor(engine, category);
    r.shown++;
    e.shown++;
    switch (f.decision) {
      case "onaylandi":
        r.approved++; e.approved++;
        break;
      case "reddedildi":
        r.rejected++; e.rejected++;
        if (falsePositives.length < FP_LIST_MAX) {
          falsePositives.push({
            engine, category, label: clean(f.label, 120) || "(adsız bulgu)",
            reason: clean(f.reason, 200) || "(gerekçe girilmemiş)",
            slice: Number.isFinite(f.slice ?? NaN) ? (f.slice as number) : null,
            studyRef: f.studyRef ? clean(f.studyRef, 40) : null,
            at: f.at ? clean(f.at, 30) : null,
            score: typeof f.score === "number" && f.score >= 0 && f.score <= 1 ? f.score : null,
          });
        }
        break;
      case "duzenlendi":
        r.edited++; e.edited++;
        break;
      default:
        r.pending++; e.pending++;
        break;
    }
  }

  // Kategori: yalnız kesinlik.
  for (const r of cats.values()) {
    const tp = r.approved + r.edited;
    r.decidedAi = tp + r.rejected;
    r.ppv = ratio(tp, tp + r.rejected);
    r.ppvCI = r.ppv === null ? null : wilson95(tp, tp + r.rejected);
  }

  // Motor: kesinlik + duyarlılık + özgüllük.
  const engines: EngineRow[] = [...eng.entries()].map(([engine, e]) => {
    const tp = e.approved + e.edited;
    const decidedAi = tp + e.rejected;
    const sens = ratio(tp, tp + e.missed);
    return {
      engine,
      shown: e.shown, approved: e.approved, rejected: e.rejected, edited: e.edited, pending: e.pending,
      missed: e.missed, decidedAi,
      sensitivity: sens,
      sensitivityCI: sens === null ? null : wilson95(tp, tp + e.missed),
      ppv: ratio(tp, decidedAi),
      ppvCI: ratio(tp, decidedAi) === null ? null : wilson95(tp, decidedAi),
      trueNegatives: e.tnKnown ? e.tn : null,
      specificity: e.tnKnown ? ratio(e.tn, e.tn + e.rejected) : null,
    };
  });

  // Toplamlar (motor farkı gözetmeden)
  const sum = (f: (r: EngineRow) => number) => engines.reduce((s2, r) => s2 + f(r), 0);
  const tnTotal = engines.reduce((s2, r) => s2 + (r.trueNegatives ?? 0), 0);
  const tnKnown = engines.some((r) => r.trueNegatives !== null);
  const totals = {
    aiShown: sum((r) => r.shown),
    decided: sum((r) => r.decidedAi),
    approved: sum((r) => r.approved),
    rejected: sum((r) => r.rejected),
    edited: sum((r) => r.edited),
    missed: sum((r) => r.missed),
    cleanStudies: tnTotal,
    sensitivity: ratio(sum((r) => r.approved + r.edited), sum((r) => r.approved + r.edited + r.missed)),
    specificity: tnKnown ? ratio(tnTotal, tnTotal + sum((r) => r.rejected)) : null,
    ppv: ratio(sum((r) => r.approved + r.edited), sum((r) => r.approved + r.edited + r.rejected)),
  };

  // Eşik eğrisi: yalnız skoru olan, karar verilmiş AI adayları.
  const scored = findings.filter(
    (f) => !f.manual && typeof f.score === "number" && f.score >= 0 && f.score <= 1 &&
      (f.decision === "onaylandi" || f.decision === "duzenlendi" || f.decision === "reddedildi"),
  );
  const pos = scored.filter((f) => f.decision !== "reddedildi").length;
  const thresholdCurve: ThresholdPoint[] = THRESHOLD_GRID.map((threshold) => {
    const keptF = scored.filter((f) => (f.score as number) >= threshold);
    const kept = keptF.length;
    const keptPositive = keptF.filter((f) => f.decision !== "reddedildi").length;
    return {
      threshold,
      recall: ratio(keptPositive, pos),
      precision: ratio(keptPositive, kept),
      kept,
      dropped: scored.length - kept,
    };
  });

  // Öneri: en yüksek F1 (kesinlik+duyarlılık dengesi); yeterli örnek yoksa öneri yok.
  let suggestedThreshold: number | null = null;
  let why = `Eşik önerisi için en az ${THRESHOLD_MIN_DECIDED} karar verilmiş skorlu aday gerekir (şu an ${scored.length}).`;
  if (scored.length >= THRESHOLD_MIN_DECIDED) {
    // En yüksek F1; eşitlikte **daha düşük** eşik seçilir (daha çok gerçek pozitif korunur).
    // Eşitlik yüksek eşiğe kaysaydı, sınırda duran adaylar sessizce düşerdi.
    let best = -1;
    for (const p of thresholdCurve) {
      if (p.recall === null || p.precision === null || p.kept === 0) continue;
      const f1 = (2 * p.recall * p.precision) / (p.recall + p.precision);
      if (f1 > best + 1e-9) { best = f1; suggestedThreshold = p.threshold; }
    }
    why = suggestedThreshold === null
      ? "Skorlu aday yok; eşik önerilemedi."
      : `En yüksek F1 veren eşik (${scored.length} karar üzerinde). Bu bir ÖNERİDİR — ölçüt değişikliği klinik onay gerektirir; skor kalibre değildir.`;
  }

  const warnings: string[] = [];
  if (totals.missed === 0) warnings.push("Hiç 'AI kaçırdı' girişi yok: duyarlılık olduğundan yüksek görünür (hekim eklemeyi unutmuş olabilir).");
  if (totals.cleanStudies === 0) warnings.push("Temiz çalışma (gerçek negatif) verisi yok: özgüllük hesaplanamaz.");
  if (totals.decided > 0 && totals.decided < THRESHOLD_MIN_DECIDED) warnings.push(`Örneklem küçük (${totals.decided} karar): güven aralıkları geniş, sonuç genellenemez.`);

  return {
    engines: engines.sort((a, b) => b.decidedAi - a.decidedAi || a.engine.localeCompare(b.engine)),
    rows: [...cats.values()].sort((a, b) => b.decidedAi - a.decidedAi || a.engine.localeCompare(b.engine)),
    falsePositives: falsePositives.slice(0, FP_LIST_MAX),
    missed: missed.slice(0, MISSED_LIST_MAX),
    totals,
    thresholdCurve,
    suggestedThreshold,
    suggestedThresholdWhy: why,
    warnings,
    note:
      "Referans standardı hekimin kendi kararıdır (altın standart yok). Düzenlenen bulgu gerçek pozitif sayılır. " +
      "Duyarlılık/özgüllük motor düzeyinde hesaplanır (elle eklenen bulgu ve temiz çalışma kategoriye bağlanamaz). " +
      "Özgüllük yalnız temiz çalışma verisi verildiğinde hesaplanır. Bu tablo klinik doğrulama çalışmasının yerine geçmez.",
  };
}

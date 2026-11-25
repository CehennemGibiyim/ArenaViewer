/**
 * TID 1500 ölçüm raporu kaydı, kod defteri ve yapısal geri okuma — c-sr-tid1500.
 *
 * Mevcut `sr1500.ts` TID 1500 (Imaging Measurement Report) belgesini **üretir**.
 * Bu modül onu kurumsal bir ölçüm defterine dönüştürür:
 *
 *   1. **Kod eşleme** (`resolveCode`): RadLex/SNOMED CT/LOINC kodları yalnızca
 *      kurumun lisanslı sözlüğünde (JSON) varsa standart şemayla yazılır; sözlükte
 *      yoksa **uydurma kod üretilmez**, `99ATIKVIEWER` yerel koduna düşülür ve
 *      gerekçe kaydedilir. Bu, idrar/karaciğer gibi hazır bölgeler dışındaki
 *      kavramlarda yanlış SNOMED kodu yazılmasını engeller.
 *   2. **Belge → özet** (`measurementSummary`): izleme kimliği, değer+birim,
 *      kod şeması ve görüntü referansı; longitudinal izleme için anahtar
 *      (`trackingKey`) üretir.
 *   3. **Seri karşılaştırma** (`compareTracked`): aynı izleme kimliğinin iki
 *      çalışmadaki değerleri; eşik tabanlı büyüme/küçülme sınıflaması
 *      (`intervalChange` kurallarıyla aynı yönde, ama bağımsız test edilebilir).
 *   4. **Dışa aktarım**: CSV + FHIR Observation demeti (RadLex kodu → `coding`).
 *
 * Klinik karar aracı değildir; ölçümler hekim doğrulamasına tabidir.
 */

import { atikCode, CODES, UNITS, type Code, type Measurement, type Sr1500Input } from "./sr1500";

// ─────────────── Kod defteri ───────────────

export interface LexiconEntry {
  /** Aranan kavram (küçük harf, Türkçe karakterler korunur) */
  term: string;
  code: Code;
  /** Eşanlamlılar (örn. "nodül", "noduler lezyon") */
  synonyms?: string[];
}

export interface Lexicon {
  /** Sözlük sürümü (izlenebilirlik) */
  version: string;
  /** Lisans notu (kullanıcıya gösterilir; lisans kurumda) */
  license?: string;
  entries: LexiconEntry[];
}

export const EMPTY_LEXICON: Lexicon = { version: "yok", entries: [] };

const norm = (s: string) => s.trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");

/** Sözlük JSON'unu doğrular; bozuk girişler sessizce atlanır ve raporlanır. */
export function parseLexicon(raw: unknown): { lexicon: Lexicon; rejected: { index: number; reason: string }[] } {
  const rejected: { index: number; reason: string }[] = [];
  if (!raw || typeof raw !== "object") return { lexicon: EMPTY_LEXICON, rejected: [{ index: 0, reason: "Sözlük JSON nesnesi değil" }] };
  const o = raw as { version?: unknown; license?: unknown; entries?: unknown };
  const entries: LexiconEntry[] = [];
  if (!Array.isArray(o.entries)) return { lexicon: EMPTY_LEXICON, rejected: [{ index: 0, reason: "entries dizisi yok" }] };
  o.entries.forEach((e, i) => {
    const x = e as { term?: unknown; code?: { value?: unknown; scheme?: unknown; meaning?: unknown }; synonyms?: unknown };
    if (!x || typeof x.term !== "string" || !x.term.trim()) { rejected.push({ index: i, reason: "term boş" }); return; }
    const c = x.code ?? {};
    const scheme = String(c.scheme ?? "").toUpperCase();
    if (!["SCT", "RADLEX", "LN", "DCM", "UCUM", "SRT"].includes(scheme)) { rejected.push({ index: i, reason: `desteklenmeyen şema: ${scheme || "(boş)"}` }); return; }
    if (!c.value || typeof c.value !== "string") { rejected.push({ index: i, reason: "kod değeri yok" }); return; }
    // SNOMED CT/LOINC sayısal, RadLex "RID…" biçimindedir; biçim tutmuyorsa kabul edilmez.
    if (scheme === "SCT" && !/^\d{4,18}$/.test(c.value)) { rejected.push({ index: i, reason: "SCT kodu sayısal olmalı" }); return; }
    if (scheme === "RADLEX" && !/^RID\d+$/.test(c.value)) { rejected.push({ index: i, reason: "RadLex kodu RID### biçiminde olmalı" }); return; }
    entries.push({
      term: norm(x.term),
      code: { value: c.value, scheme, meaning: typeof c.meaning === "string" && c.meaning.trim() ? c.meaning.trim().slice(0, 64) : x.term.trim().slice(0, 64) },
      synonyms: Array.isArray(x.synonyms) ? x.synonyms.filter((s): s is string => typeof s === "string").map(norm) : undefined,
    });
  });
  return {
    lexicon: {
      version: typeof o.version === "string" && o.version.trim() ? o.version.trim().slice(0, 40) : "bilinmiyor",
      license: typeof o.license === "string" ? o.license.slice(0, 120) : undefined,
      entries,
    },
    rejected,
  };
}

export interface CodeResolution {
  code: Code;
  /** Standart sözlükten mi geldi */
  standard: boolean;
  /** Standart değilse neden (kullanıcıya gösterilir) */
  reason: string;
}

/**
 * Kavram → kod. Sözlükte yoksa **yerel** kod üretilir; standart kod asla
 * uydurulmaz. Hazır bölgeler (`SITES`) de sözlükten önce kontrol edilir.
 */
export function resolveCode(term: string, lexicon: Lexicon, sites: Record<string, Code> = {}): CodeResolution {
  const key = norm(term);
  if (!key) return { code: atikCode("BOS", "Boş kavram"), standard: false, reason: "Kavram boş" };
  const site = sites[key];
  if (site) return { code: site, standard: true, reason: "Hazır bölge kodu" };
  for (const e of lexicon.entries) {
    if (e.term === key || e.synonyms?.includes(key)) {
      return { code: e.code, standard: true, reason: `Sözlük ${lexicon.version}` };
    }
  }
  return {
    code: atikCode(key.toLocaleUpperCase("tr-TR").replace(/[^A-Z0-9]+/g, "_").slice(0, 16) || "KAVRAM", term.slice(0, 64)),
    standard: false,
    reason: lexicon.entries.length ? `Sözlükte yok (sürüm ${lexicon.version})` : "Kurum sözlüğü tanımlı değil",
  };
}

/** Kod şeması → okunur etiket (rapor/CSV). */
export const SCHEME_LABEL: Record<string, string> = {
  SCT: "SNOMED CT",
  RADLEX: "RadLex",
  LN: "LOINC",
  DCM: "DICOM",
  SRT: "SRT (eski DICOM)",
  UCUM: "UCUM",
  "99ATIKVIEWER": "Yerel kod",
};

export function codeText(c: Code): string {
  return `${SCHEME_LABEL[c.scheme] ?? c.scheme}:${c.value} — ${c.meaning}`;
}

/** Denetim/uyum raporu: standart kod sayısı ve yerel kod gerekçeleri. */
export interface CodingAudit {
  total: number;
  standard: number;
  local: number;
  /** Standart oranı (0–1); ölçüm yoksa null */
  standardRatio: number | null;
  localReasons: string[];
  lexiconVersion: string;
  note: string;
}

export function codingAudit(measurements: Measurement[], lexicon: Lexicon = EMPTY_LEXICON): CodingAudit {
  let standard = 0;
  const reasons = new Set<string>();
  for (const m of measurements) {
    for (const c of [m.finding, m.site].filter((x): x is Code => !!x)) {
      if (c.scheme === "99ATIKVIEWER") reasons.add(c.meaning);
      else standard++;
    }
  }
  const local = measurements.reduce((n, m) => n + [m.finding, m.site].filter((c) => c?.scheme === "99ATIKVIEWER").length, 0);
  const total = standard + local;
  return {
    total,
    standard,
    local,
    standardRatio: total > 0 ? Math.round((standard / total) * 1000) / 1000 : null,
    localReasons: [...reasons].sort((a, b) => a.localeCompare(b, "tr")),
    lexiconVersion: lexicon.version,
    note:
      local > 0
        ? `${local} kod standart sözlükte bulunamadı ve yerel şemayla yazıldı. Standart kod uydurulmadı; kurum lisanslı sözlüğünü yüklediğinde bu kodlar eşlenir.`
        : "Tüm kodlar standart şemalardan geliyor.",
  };
}

// ─────────────── Belge özeti ───────────────

export interface MeasurementSummary {
  trackingId: string;
  trackingUid: string;
  trackingKey: string;
  value: number;
  unit: string;
  /** UCUM kodu (varsa) */
  ucum: string;
  quantity: string;
  finding: string;
  findingScheme: string;
  site: string;
  image: string;
}

/**
 * İzleme anahtarı: `trackingUid` varsa o, yoksa bölge+bulgu+izleme kimliği.
 * Longitudinal eşleştirme bu anahtarla yapılır (hasta kimliği içermez).
 */
export function trackingKey(m: Pick<Measurement, "trackingId" | "trackingUid" | "finding" | "site">): string {
  if (m.trackingUid && m.trackingUid.trim()) return `uid:${m.trackingUid.trim()}`;
  const site = m.site?.value ?? "";
  return `id:${site}|${m.finding.value}|${m.trackingId.trim() || "?"}`;
}

export function measurementSummary(ms: Measurement[]): MeasurementSummary[] {
  return ms.map((m) => ({
    trackingId: m.trackingId,
    trackingUid: m.trackingUid ?? "",
    trackingKey: trackingKey(m),
    value: m.value,
    unit: m.unit,
    ucum: UNITS[m.unit]?.value ?? m.unit,
    quantity: m.quantity.meaning,
    finding: m.finding.meaning,
    findingScheme: m.finding.scheme,
    site: m.site?.meaning ?? "",
    image: m.image ? `${m.image.seriesUid}/${m.image.sopUid}` : "",
  }));
}

/** Belge düzeyinde denetim: hasta kimliği bütünlüğü, ölçüm sayısı, kodlar. */
export function documentChecks(input: Pick<Sr1500Input, "studyUid" | "patientId" | "measurements">): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!input.studyUid?.trim()) problems.push("Çalışma UID'si boş");
  if (!input.patientId?.trim()) problems.push("Hasta kimliği boş (anonim belgede beklenir, aksi halde eksik)");
  const seen = new Set<string>();
  for (const m of input.measurements) {
    if (!Number.isFinite(m.value)) problems.push(`${m.trackingId}: değer sayısal değil`);
    const k = trackingKey(m);
    if (seen.has(k)) problems.push(`${m.trackingId}: aynı izleme anahtarı birden çok kez kullanılmış (${k})`);
    seen.add(k);
  }
  return { ok: problems.length === 0, problems };
}

// ─────────────── Longitudinal karşılaştırma ───────────────

export type ChangeClass = "buyume" | "kuculme" | "stabil" | "yeni" | "kayboldu";

export interface TrackedChange {
  trackingKey: string;
  trackingId: string;
  previous: number | null;
  current: number | null;
  delta: number | null;
  /** Delta yüzdesi (önceki 0 ise null) */
  deltaPct: number | null;
  change: ChangeClass;
  note: string;
}

/** RECIST benzeri eşikler: ≥%20 ve ≥5 mm büyüme; ≥%30 küçülme. */
export const CHANGE_RULES = { growthPct: 0.2, growthAbs: 5, shrinkPct: 0.3 } as const;

function classify(prev: number | null, cur: number | null): { change: ChangeClass; note: string } {
  if (prev === null && cur !== null) return { change: "yeni", note: "Önceki çalışmada yok; yeni ölçüm." };
  if (prev !== null && cur === null) return { change: "kayboldu", note: "Önceki çalışmada vardı, bu çalışmada ölçülmedi." };
  if (prev === null || cur === null) return { change: "stabil", note: "Karşılaştırılabilir ölçüm yok." };
  const delta = cur - prev;
  const pct = prev > 0 ? delta / prev : null;
  if (pct !== null && pct >= CHANGE_RULES.growthPct && delta >= CHANGE_RULES.growthAbs) {
    return { change: "buyume", note: `Büyüme: ${prev} → ${cur} (${Math.round(pct * 100)}%, +${Math.round(delta * 10) / 10} mm).` };
  }
  if (pct !== null && pct <= -CHANGE_RULES.shrinkPct) {
    return { change: "kuculme", note: `Küçülme: ${prev} → ${cur} (${Math.round(pct * 100)}%).` };
  }
  return { change: "stabil", note: `Stabil: ${prev} → ${cur} (eşik altı).` };
}

/**
 * İki çalışmanın ölçümlerini izleme anahtarıyla eşleştirir. Eşleşmeyen anahtarlar
 * "yeni"/"kayboldu" olarak raporlanır — sessizce düşürülmez.
 */
export function compareTracked(previous: Measurement[], current: Measurement[]): TrackedChange[] {
  const prevMap = new Map(previous.map((m) => [trackingKey(m), m]));
  const curMap = new Map(current.map((m) => [trackingKey(m), m]));
  const keys = [...new Set([...prevMap.keys(), ...curMap.keys()])].sort((a, b) => a.localeCompare(b, "tr"));
  return keys.map((k) => {
    const p = prevMap.get(k) ?? null;
    const c = curMap.get(k) ?? null;
    const prevV = p ? p.value : null;
    const curV = c ? c.value : null;
    const { change, note } = classify(prevV, curV);
    const delta = prevV !== null && curV !== null ? Math.round((curV - prevV) * 10) / 10 : null;
    const deltaPct = prevV !== null && curV !== null && prevV > 0 ? Math.round(((curV - prevV) / prevV) * 1000) / 1000 : null;
    return { trackingKey: k, trackingId: (c ?? p)!.trackingId, previous: prevV, current: curV, delta, deltaPct, change, note };
  });
}

/** CSV (uzunlamasına izleme tablosu). */
export function trackedCsv(changes: TrackedChange[]): string {
  const head = ["İzleme", "Önceki", "Şimdiki", "Fark", "Fark %", "Sınıf", "Not"];
  const rows = changes.map((c) => [
    c.trackingId,
    c.previous === null ? "" : String(c.previous),
    c.current === null ? "" : String(c.current),
    c.delta === null ? "" : String(c.delta),
    c.deltaPct === null ? "" : String(Math.round(c.deltaPct * 100)),
    c.change,
    c.note.replace(/;/g, ","),
  ]);
  return [head, ...rows].map((r) => r.join(";")).join("\n");
}

// ─────────────── FHIR ───────────────

/**
 * Ölçüm → FHIR R4 Observation (basit, bağımsız). Kod yalnızca gerçek şemadan
 * geliyorsa `coding.system` yazılır; yerel kod kendi sisteminde kalır.
 */
export function toFhirObservations(ms: Measurement[], subject: { patientId: string; patientName: string }, studyUid: string): Record<string, unknown>[] {
  const SYSTEM: Record<string, string> = {
    SCT: "http://snomed.info/sct",
    RADLEX: "http://radlex.org",
    LN: "http://loinc.org",
    DCM: "http://dicom.nema.org/resources/ontology/DCM",
    "99ATIKVIEWER": "urn:atikviewer:local-code",
  };
  return ms.map((m) => ({
    resourceType: "Observation",
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging", display: "Imaging" }] }],
    code: {
      coding: [{ system: SYSTEM[m.quantity.scheme] ?? "urn:atikviewer:local-code", code: m.quantity.value, display: m.quantity.meaning }],
      text: m.quantity.meaning,
    },
    subject: { identifier: { value: subject.patientId }, display: subject.patientName },
    focus: [{ identifier: { system: "urn:dicom:uid", value: `urn:oid:${studyUid}` } }],
    valueQuantity: {
      value: m.value,
      unit: UNITS[m.unit]?.meaning ?? m.unit,
      system: "http://unitsofmeasure.org",
      code: UNITS[m.unit]?.value ?? m.unit,
    },
    bodySite: m.site ? { coding: [{ system: SYSTEM[m.site.scheme] ?? "urn:atikviewer:local-code", code: m.site.value, display: m.site.meaning }], text: m.site.meaning } : undefined,
    note: [{ text: `${m.trackingId} · ${m.finding.meaning} (${codeText(m.finding)})` }],
    extension: [{ url: "urn:atikviewer:tracking-uid", valueString: m.trackingUid ?? "" }],
  }));
}

export function fhirBundle(observations: Record<string, unknown>[]): Record<string, unknown> {
  return {
    resourceType: "Bundle",
    type: "collection",
    total: observations.length,
    entry: observations.map((r) => ({ resource: r })),
  };
}

/** Rapor satırı (TID 1500 özeti). */
export function sr1500Text(summary: MeasurementSummary[], audit: CodingAudit): string {
  if (!summary.length) return "TID 1500: yazılabilir sayısal ölçüm yok.";
  const lines = summary.map((s) => `${s.trackingId}: ${s.value} ${s.ucum}${s.site ? ` · ${s.site}` : ""} · ${s.finding} [${SCHEME_LABEL[s.findingScheme] ?? s.findingScheme}]`);
  return [`TID 1500 ölçüm raporu (${summary.length} ölçüm)`, ...lines, audit.note].join("\n");
}

/** Ölçüm → belge girdisi (kayıt ucu için varsayılan başlık). */
export function reportTitle(input: Pick<Sr1500Input, "studyModality" | "measurements">): string {
  const n = input.measurements.length;
  return `${input.studyModality ?? "Görüntüleme"} ölçümleri (${n}) · ${CODES.measurementReport.meaning}`;
}

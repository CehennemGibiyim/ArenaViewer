/**
 * Radyasyon dozu — DICOM RDSR (X-Ray Radiation Dose SR) okuma ve özetleme.
 *
 * Neden yeni bir modül: doz kaydı PACS'te zaten üretilir ama iş istasyonunda
 * görünmez. Bu modül RDSR ağacını **salt okur**, ışınlama olaylarını (irradiation
 * event) çıkarır ve CTDIvol / DLP değerlerini özetler.
 *
 * Dürüstlük sınırları (bilinçli tasarım):
 * - Yalnızca belge içinde **yazılı olan** değerler okunur; eksik değer tahmin
 *   edilmez, "eksik" olarak raporlanır.
 * - Etkin doz (mSv) DLP × bölge katsayısıyla **yaklaşık** hesaplanır. Bu bir
 *   dozimetri ölçümü değildir; ICRP 103 bölge katsayılarına dayanan kaba bir
 *   göstergedir.
 * - DRL (tanısal referans düzey) değerleri **örnektir** ve doğrulanmamıştır;
 *   kurum kendi DRL'sini girmelidir. Karşılaştırma "uygunluk" iddiası taşımaz.
 * - Kod eşlemesi DCM kodları + kavram adı (meaning) metniyle yapılır; eşleşmeyen
 *   öğeler yok sayılır ve uyarı listesine yazılır.
 */
import type { DicomSRDocument, SRNode } from "./types";

/** RDSR SOP Class UID (X-Ray Radiation Dose SR). */
export const SOP_RADIATION_DOSE_SR = "1.2.840.10008.5.1.4.1.1.88.67";
/** Radyasyon dozu şablonları (TID 10001/10002 ve CT varyantları). */
export const DOSE_TEMPLATE_IDS = ["10001", "10002", "10011", "10012", "10013", "10014", "10015", "10016"];

/** Yalnızca kesin bilinen DICOM SR kodları. */
export const DOSE_CODES = {
  procedureReported: { value: "121058", scheme: "DCM", meaning: "Procedure reported" },
  irradiationEvent: { value: "113701", scheme: "DCM", meaning: "Irradiation Event X-Ray Data" },
  ctdiVol: { value: "113733", scheme: "DCM", meaning: "CTDIvol" },
  dlp: { value: "113738", scheme: "DCM", meaning: "DLP" },
  meanCtdiVol: { value: "113830", scheme: "DCM", meaning: "Mean CTDIvol" },
} as const;

export interface DoseEvent {
  /** Belgedeki sıra (1 tabanlı) */
  index: number;
  protocol?: string;
  region?: string;
  ctdiVol?: number;
  dlp?: number;
  /** Bulunan diğer sayısal değerler (kavram adı → değer + birim) */
  extras: { name: string; value: number; unit: string }[];
}

export interface DoseReport {
  id: string;
  title: string;
  templateId?: string;
  sopInstanceUid?: string;
  procedure?: string;
  events: DoseEvent[];
  accumulated?: { meanCtdiVol?: number; dlp?: number };
  /** Belgede bulunamayan/atlanan bilgiler — sessizce yutulmaz. */
  warnings: string[];
}

export interface DoseSummary {
  eventCount: number;
  totalDlp?: number;
  meanCtdiVol?: number;
  maxCtdiVol?: number;
  /** DLP'si olmayan olay sayısı (toplam eksik olabilir) */
  missingDlp: number;
  /** CTDIvol'ü olmayan olay sayısı */
  missingCtdiVol: number;
  notes: string[];
}

export const EFFECTIVE_DOSE_REGIONS = [
  { id: "head", label: "Beyin / kafa", k: 0.0023 },
  { id: "neck", label: "Boyun", k: 0.0059 },
  { id: "chest", label: "Toraks", k: 0.014 },
  { id: "abdomen", label: "Abdomen", k: 0.015 },
  { id: "pelvis", label: "Pelvis", k: 0.015 },
  { id: "spine", label: "Omurga", k: 0.013 },
] as const;
export type EffectiveDoseRegion = (typeof EFFECTIVE_DOSE_REGIONS)[number]["id"];

export interface DrlEntry {
  region: EffectiveDoseRegion;
  ctdiVol?: number;
  dlp?: number;
  source?: string;
}

/**
 * ÖRNEK DRL — doğrulanmamış başlangıç değerleri. Arayüzde düzenlenebilir ve
 * "kurumsal DRL ile değiştirin" uyarısıyla gösterilir; klinik uygunluk ölçütü değildir.
 */
export const ORNEK_DRL: DrlEntry[] = [
  { region: "head", ctdiVol: 60, dlp: 1000, source: "örnek (doğrulanmamış)" },
  { region: "neck", ctdiVol: 40, dlp: 700, source: "örnek (doğrulanmamış)" },
  { region: "chest", ctdiVol: 15, dlp: 450, source: "örnek (doğrulanmamış)" },
  { region: "abdomen", ctdiVol: 20, dlp: 600, source: "örnek (doğrulanmamış)" },
  { region: "pelvis", ctdiVol: 20, dlp: 550, source: "örnek (doğrulanmamış)" },
  { region: "spine", ctdiVol: 30, dlp: 750, source: "örnek (doğrulanmamış)" },
];

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const meaning = (n: SRNode) => norm(n.conceptName?.meaning);
const codeOf = (n: SRNode) => n.conceptName?.code ?? "";

function walk(node: SRNode, visit: (n: SRNode, depth: number) => void, depth = 0) {
  visit(node, depth);
  for (const child of node.children ?? []) walk(child, visit, depth + 1);
}

function numMatches(n: SRNode, ...names: string[]) {
  if (n.valueType !== "NUM" || !n.numValue || !Number.isFinite(n.numValue.value)) return false;
  const m = meaning(n);
  if (!m) return false;
  // "mean ctdivol" ile "ctdivol" ayrımı: her çağrı kendi adını verir.
  return names.some((name) => m === name || m.startsWith(name) || m.includes(name));
}

/** DLP/CTDIvol gibi metrikleri bir alt ağaçtan toplar. */
function collectMetrics(node: SRNode) {
  let ctdiVol: number | undefined;
  let dlp: number | undefined;
  let meanCtdiVol: number | undefined;
  const extras: { name: string; value: number; unit: string }[] = [];
  walk(node, (n) => {
    if (n === node || n.valueType !== "NUM" || !n.numValue) return;
    const m = meaning(n);
    const value = n.numValue.value;
    if (!Number.isFinite(value)) return;
    if (m.includes("mean") && m.includes("ctdi")) {
      if (meanCtdiVol === undefined) meanCtdiVol = value;
      return;
    }
    if (m.includes("dlp") || m.includes("dose length product")) {
      if (dlp === undefined) dlp = value;
      return;
    }
    if (m.includes("ctdi")) {
      if (ctdiVol === undefined) ctdiVol = value;
      return;
    }
    const name = n.conceptName?.meaning || codeOf(n) || "sayısal değer";
    if (extras.length < 6) extras.push({ name, value, unit: n.numValue.unit || "" });
  });
  return { ctdiVol, dlp, meanCtdiVol, extras };
}

export interface ExtractOptions {
  /** Belge etiketi (dosya adı) — rapor kimliği ve başlığında kullanılır. */
  label?: string;
}

/**
 * Ayrıştırılmış DICOM SR ağacından doz raporu çıkarır. RDSR değilse ya da hiç
 * doz ölçümü yoksa `null` döner (çağıran kullanıcıya nedeni göstermelidir).
 */
export function extractDoseReport(doc: DicomSRDocument, opts: ExtractOptions = {}): DoseReport | null {
  const warnings: string[] = [];
  const events: DoseEvent[] = [];
  let procedure: string | undefined;
  let accumulated: DoseReport["accumulated"];

  walk(doc.root, (n) => {
    if (!procedure) {
      if (codeOf(n) === DOSE_CODES.procedureReported.value || meaning(n) === "procedure reported") {
        procedure = (n.textValue || n.codeValue?.meaning || "").trim() || undefined;
      }
    }
  });

  const eventNodes: SRNode[] = [];
  walk(doc.root, (n) => {
    if (n === doc.root) return;
    const isEvent = codeOf(n) === DOSE_CODES.irradiationEvent.value || meaning(n) === "irradiation event x-ray data";
    if (isEvent) eventNodes.push(n);
  });

  const regionFromText = (text: string | undefined) => (text ?? "").trim() || undefined;

  eventNodes.forEach((node, i) => {
    const metrics = collectMetrics(node);
    let protocol: string | undefined;
    let region: string | undefined;
    walk(node, (n) => {
      if (n === node) return;
      const m = meaning(n);
      if (!protocol && n.valueType === "TEXT" && (m.includes("protocol") || m.includes("acquisition"))) {
        protocol = regionFromText(n.textValue);
      }
      if (!protocol && n.valueType === "CODE" && m.includes("protocol")) {
        protocol = regionFromText(n.codeValue?.meaning);
      }
      if (!region && n.valueType === "CODE" && (m.includes("region") || m.includes("body part"))) {
        region = regionFromText(n.codeValue?.meaning);
      }
    });
    events.push({
      index: i + 1,
      protocol: protocol ?? regionFromText(procedure),
      region,
      ctdiVol: metrics.ctdiVol,
      dlp: metrics.dlp,
      extras: metrics.extras,
    });
  });

  // Bazı göndericiler tek bir "accumulated dose" konteyneri yazar.
  if (events.length === 0) {
    walk(doc.root, (n) => {
      if (n === doc.root || accumulated) return;
      if (!meaning(n).includes("accumulated")) return;
      const m = collectMetrics(n);
      if (m.meanCtdiVol !== undefined || m.dlp !== undefined) {
        accumulated = { meanCtdiVol: m.meanCtdiVol, dlp: m.dlp };
      }
    });
  }

  // Düz (eventsiz) belgeler: kökteki DLP/CTDIvol doğrudan alınır.
  if (events.length === 0 && !accumulated) {
    const flat = collectMetrics(doc.root);
    if (flat.dlp !== undefined || flat.ctdiVol !== undefined || flat.meanCtdiVol !== undefined) {
      accumulated = { meanCtdiVol: flat.meanCtdiVol ?? flat.ctdiVol, dlp: flat.dlp };
    }
  }

  const hasNumbers = events.some((e) => e.dlp !== undefined || e.ctdiVol !== undefined) ||
    accumulated?.dlp !== undefined || accumulated?.meanCtdiVol !== undefined;
  if (!hasNumbers) return null;

  if (events.length === 0) warnings.push("Işınlama olayı (113701) bulunamadı; yalnızca toplam/accumulated değerler okundu.");
  if (events.some((e) => e.dlp === undefined)) warnings.push("Bazı olaylarda DLP yok; toplam DLP eksik olabilir.");
  if (events.some((e) => e.ctdiVol === undefined)) warnings.push("Bazı olaylarda CTDIvol yok.");
  if (!procedure) warnings.push("Procedure reported (121058) bulunamadı; protokol adı dosya etiketinden geliyor.");
  if (!doc.templateId) warnings.push("Şablon kimliği (0040,DB00) yok; belge türü içerik kodlarından çıkarıldı.");

  return {
    id: `${opts.label ?? "rdsr"}-${doc.sopInstanceUid || doc.id}`,
    title: opts.label || doc.title || "Radyasyon dozu raporu",
    templateId: doc.templateId,
    sopInstanceUid: doc.sopInstanceUid,
    procedure,
    events,
    accumulated,
    warnings,
  };
}

/** Olayları (yoksa accumulated değerleri) tek bir özete indirger. */
export function summarizeDose(report: DoseReport): DoseSummary {
  const notes = [...report.warnings];
  if (report.events.length === 0) {
    const ctdi = report.accumulated?.meanCtdiVol;
    const dlp = report.accumulated?.dlp;
    notes.push("Olay bazlı değer yok; özet yalnızca toplam (accumulated) değerlerden.");
    return {
      eventCount: 0,
      totalDlp: dlp,
      meanCtdiVol: ctdi,
      maxCtdiVol: ctdi,
      missingDlp: 0,
      missingCtdiVol: 0,
      notes,
    };
  }
  const withDlp = report.events.filter((e) => e.dlp !== undefined);
  const withCtdi = report.events.filter((e) => e.ctdiVol !== undefined);
  const totalDlp = withDlp.length ? withDlp.reduce((s, e) => s + (e.dlp ?? 0), 0) : undefined;
  const meanCtdiVol = withCtdi.length ? withCtdi.reduce((s, e) => s + (e.ctdiVol ?? 0), 0) / withCtdi.length : undefined;
  const maxCtdiVol = withCtdi.length ? Math.max(...withCtdi.map((e) => e.ctdiVol ?? 0)) : undefined;
  const missingDlp = report.events.length - withDlp.length;
  const missingCtdiVol = report.events.length - withCtdi.length;
  if (missingDlp > 0) notes.push(`${missingDlp} olayda DLP yok; toplam DLP yalnızca DLP'si olan olayları kapsar.`);
  return { eventCount: report.events.length, totalDlp, meanCtdiVol, maxCtdiVol, missingDlp, missingCtdiVol, notes };
}

/** DLP × bölge katsayısı. Yaklaşık göstergedir; dozimetri ölçümü değildir. */
export function effectiveDoseMsv(dlp: number | undefined, region: EffectiveDoseRegion): number | undefined {
  if (dlp === undefined || !Number.isFinite(dlp) || dlp < 0) return undefined;
  const factor = EFFECTIVE_DOSE_REGIONS.find((r) => r.id === region)?.k;
  if (factor === undefined) return undefined;
  return dlp * factor;
}

export interface DrlResult {
  metric: "ctdiVol" | "dlp";
  value: number;
  drl: number;
  /** value / drl; 1 = DRL'ye eşit */
  ratio: number;
  level: "altinda" | "yakinda" | "ustunde";
}

/** Örneğe göre oran: ±%10 "yakında". Klinik uygunluk ölçütü değildir. */
export function compareToDrl(summary: DoseSummary, drl: Partial<Record<"ctdiVol" | "dlp", number>>): DrlResult[] {
  const out: DrlResult[] = [];
  const push = (metric: "ctdiVol" | "dlp", value: number | undefined, limit: number | undefined) => {
    if (value === undefined || limit === undefined || !Number.isFinite(limit) || limit <= 0) return;
    const ratio = value / limit;
    const level = ratio > 1.1 ? "ustunde" : ratio < 0.9 ? "altinda" : "yakinda";
    out.push({ metric, value, drl: limit, ratio, level });
  };
  push("ctdiVol", summary.meanCtdiVol, drl.ctdiVol);
  push("dlp", summary.totalDlp, drl.dlp);
  return out;
}

/** Rapor/panoya yapıştırılabilir düz metin özet. Klinik rapor değildir. */
export function doseSummaryText(report: DoseReport, summary: DoseSummary, opts: { region?: EffectiveDoseRegion; drl?: Partial<Record<"ctdiVol" | "dlp", number>> } = {}): string {
  const f = (v: number | undefined, digits = 1) => (v === undefined ? "—" : v.toFixed(digits));
  const lines: string[] = [
    `RADYASYON DOZU ÖZETİ (RDSR) — ${report.title}`,
    report.procedure ? `İşlem: ${report.procedure}` : "İşlem: belgede yazmıyor",
    `Işınlama olayı: ${summary.eventCount || "olay bazlı kayıt yok"}`,
    `Toplam DLP: ${f(summary.totalDlp)} mGy·cm${summary.missingDlp ? ` (${summary.missingDlp} olayda eksik)` : ""}`,
    `Ortalama CTDIvol: ${f(summary.meanCtdiVol, 2)} mGy · En yüksek: ${f(summary.maxCtdiVol, 2)} mGy`,
  ];
  if (opts.region) {
    const ed = effectiveDoseMsv(summary.totalDlp, opts.region);
    lines.push(`Yaklaşık etkin doz: ${ed === undefined ? "hesaplanamadı (DLP yok)" : `${ed.toFixed(2)} mSv`} — DLP × bölge katsayısı, ölçüm değildir.`);
  }
  if (opts.drl) {
    const cmp = compareToDrl(summary, opts.drl);
    if (cmp.length) {
      lines.push("ÖRNEK DRL karşılaştırması (kurumsal DRL ile değiştirin):");
      for (const c of cmp) {
        const label = c.metric === "dlp" ? "DLP" : "CTDIvol";
        lines.push(`  ${label}: ${c.value.toFixed(2)} / ${c.drl} → %${Math.round(c.ratio * 100)} (${c.level === "ustunde" ? "üstünde" : c.level === "altinda" ? "altında" : "yakınında"})`);
      }
    } else {
      lines.push("DRL karşılaştırması: değer veya DRL eksik.");
    }
  }
  if (report.events.length) {
    lines.push("Olaylar:");
    for (const e of report.events) {
      lines.push(`  ${e.index}. ${e.protocol ?? e.region ?? "protokol yok"} — CTDIvol ${e.ctdiVol === undefined ? "—" : e.ctdiVol.toFixed(2)} mGy, DLP ${e.dlp === undefined ? "—" : e.dlp.toFixed(1)}`);
    }
  }
  if (summary.notes.length) {
    lines.push("Notlar:");
    for (const n of summary.notes) lines.push(`  - ${n}`);
  }
  lines.push("UYARI: Bu özet bilgi amaçlıdır; dozimetri ölçümü veya klinik karar aracı değildir.");
  return lines.join("\n");
}

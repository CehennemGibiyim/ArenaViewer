/**
 * Model kayıt defteri yardımcıları (a-modelops).
 *
 * Kapsam: kayıt doğrulama, **deterministik A/B ataması** (aynı çalışma/oturum
 * tohumu her zaman aynı modele düşer), trafik tutarlılığı denetimi ve aşama
 * sayımı. Veritabanı/HTTP burada yoktur; API rotası ve panel aynı mantığı kullanır.
 *
 * SINIRLILIK: Bu modül modelin klinik performansını ölçmez (o `modelOps.ts`
 * kalibrasyon/PPV tarafındadır). A/B ataması çıkarım yoluna bağlanana kadar
 * yalnız dağıtım planıdır; hukuki/etiket değişikliği süreçleri kurumdadır.
 */

export type ModelStage = "aday" | "aktif" | "emekli";

export interface RegistryEntry {
  id?: number;
  name: string;
  version: string;
  modality: string;
  task: string;
  stage: ModelStage;
  /** 0–100 arası trafik payı (aynı görevdeki aktif modeller toplamı ≤ 100). */
  trafficPercent: number;
  fingerprint: string;
  notes: string;
  updatedAt?: string;
}

export const MODEL_STAGES: ModelStage[] = ["aday", "aktif", "emekli"];

const trim = (s: unknown) => (typeof s === "string" ? s.trim() : "");
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** Kayıt doğrulaması: zorunlu alanlar, trafik aralığı, uzunluk sınırları. */
export function validateEntry(e: Partial<RegistryEntry>): string[] {
  const issues: string[] = [];
  if (!trim(e.name)) issues.push("Model adı zorunlu.");
  else if (trim(e.name).length > 80) issues.push("Model adı en fazla 80 karakter.");
  if (!trim(e.version)) issues.push("Sürüm zorunlu.");
  else if (trim(e.version).length > 40) issues.push("Sürüm en fazla 40 karakter.");
  if (e.stage && !MODEL_STAGES.includes(e.stage)) issues.push("Aşama aday/aktif/emekli olmalı.");
  const pct = e.trafficPercent;
  if (pct === undefined || !Number.isFinite(pct)) issues.push("Trafik payı sayı olmalı.");
  else if (pct < 0 || pct > 100) issues.push("Trafik payı 0–100 arasında olmalı.");
  if (e.stage === "aktif" && Number.isFinite(pct) && pct === 0) issues.push("Aktif modelin trafik payı 0 olamaz (dağıtım yapılamaz).");
  if (trim(e.notes).length > 500) issues.push("Not en fazla 500 karakter.");
  return issues;
}

/** FNV-1a 32 bit — küçük, bağımlılıksız, deterministik tohum özeti. */
export function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Tohumun 0–99 kovası (A/B dağıtımı için). */
export function bucketOf(seed: string): number {
  return fnv1a(seed) % 100;
}

export interface Assignment {
  model: RegistryEntry | null;
  /** Tohumun kovası (0–99). */
  bucket: number;
  reason: string;
}

/**
 * Tohum (ör. çalışma UID'si) için model seçer.
 *
 * Aktif modeller görev süzgecinden geçer; trafik payları kümülatif bantlara
 * bölünür. Toplam pay < 100 ise kalan trafik **ilk** aktif modele düşer
 * (böylece dağıtım tamamlanmamışken istek sahipsiz kalmaz); toplam pay > 100
 * ise oranlar normalize edilir. Aktif model yoksa null döner.
 */
export function assignModel(entries: readonly RegistryEntry[], opts: { task?: string; seed: string }): Assignment {
  const bucket = bucketOf(opts.seed);
  const active = entries
    .filter((e) => e.stage === "aktif" && (!opts.task || e.task === opts.task))
    .map((e) => ({ ...e, trafficPercent: Number.isFinite(e.trafficPercent) ? clampPct(e.trafficPercent) : 0 }))
    .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  if (active.length === 0) {
    return { model: null, bucket, reason: opts.task ? `«${opts.task}» görevi için aktif model yok.` : "Aktif model yok." };
  }
  const total = active.reduce((n, e) => n + e.trafficPercent, 0);
  if (total <= 0) {
    if (active.length === 1) return { model: active[0], bucket, reason: "Tek aktif model; trafik payı tanımsız (0)." };
    return { model: null, bucket, reason: "Aktif modellerin trafik payı 0; A/B dağıtımı yapılamaz." };
  }
  // Eksik toplamda kalan payı ilk aktif model alır; böylece [0,100) bandı tamamen kaplanır.
  const shares = active.map((e) => e.trafficPercent);
  if (total < 100) shares[0] += 100 - total;
  const band = shares.reduce((n, v) => n + v, 0);
  const position = (fnv1a(opts.seed) % Math.max(1, Math.round(band * 100))) / 100; // [0, band)
  let acc = 0;
  let pick = active[0];
  for (let i = 0; i < active.length; i++) {
    if (shares[i] <= 0) continue;
    acc += shares[i];
    if (position < acc) { pick = active[i]; break; }
    pick = active[i];
  }
  const reason = total < 100
    ? `Toplam trafik %${total}; kalan %${100 - total} ilk aktif modele (${active[0].name}) düşer.`
    : total > 100
      ? `Toplam trafik %${total} (>100); oranlar normalize edilerek dağıtıldı.`
      : `Trafik %${total}; kova ${bucket}.`;
  return { model: pick, bucket, reason };
}

/** Kayıt defteri tutarlılık denetimi (aynı görevdeki aktif trafik toplamı vb.). */
export function registryIssues(entries: readonly RegistryEntry[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${trim(e.name).toLocaleLowerCase("tr-TR")}|${trim(e.version)}`;
    if (seen.has(key)) issues.push(`${e.name} ${e.version}: aynı ad + sürüm iki kez kayıtlı.`);
    seen.add(key);
    for (const i of validateEntry(e)) issues.push(`${e.name} ${e.version}: ${i}`);
  }
  const byTask = new Map<string, number>();
  for (const e of entries) {
    if (e.stage !== "aktif") continue;
    byTask.set(e.task, (byTask.get(e.task) ?? 0) + clampPct(e.trafficPercent));
  }
  for (const [task, total] of byTask) {
    if (total > 100) issues.push(`«${task || "görevsiz"}» görevinde aktif trafik toplamı %${total} — %100'ü aşıyor.`);
  }
  return issues;
}

/** Aşama bazlı sayım. */
export function stageSummary(entries: readonly RegistryEntry[]): Record<ModelStage, number> {
  const out: Record<ModelStage, number> = { aday: 0, aktif: 0, emekli: 0 };
  for (const e of entries) out[MODEL_STAGES.includes(e.stage) ? e.stage : "aday"]++;
  return out;
}

/** Denetim kaydı için aşama değişikliği açıklaması (önceki → yeni). */
export function stageChangeNote(prev: ModelStage | null, next: ModelStage): string {
  if (!prev) return `Kayıt oluşturuldu (${next}).`;
  if (prev === next) return "Aşama değişmedi.";
  return `Aşama ${prev} → ${next}.`;
}

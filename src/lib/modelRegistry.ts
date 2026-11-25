/**
 * Model kayıt defteri ve A/B dağıtımı (a-modelops).
 *
 * Kayıt defteri "hangi model sürümü hangi aşamada, ne kadar trafik alıyor"
 * sorusunu yanıtlar. Kararlar saf fonksiyonlarda tutulur (DB'den bağımsız):
 * kayıt doğrulama, trafik dağıtımı ve deterministik A/B ataması.
 *
 * Sınırlar:
 * - A/B ataması rastgele değil, konu kimliğinin karmasına bağlıdır: aynı hasta
 *   aynı model sürümünde kalır (değerlendirme tutarlılığı).
 * - Trafik yüzdeleri toplamı 100 değilse oranlanır; bu durum `normalized` ile
 *   bildirilir, sessizce düzeltilmiş gibi gösterilmez.
 * - Kayıt defteri model performansını KANITLAMAZ; yalnız hangi sürümün
 *   kullanıldığını ve kimin ne zaman değiştirdiğini izler (denetim kaydı ayrı).
 */

export const MODEL_STAGES = ["aday", "gölge", "aktif", "emekli"] as const;
export type ModelStage = (typeof MODEL_STAGES)[number];

export interface ModelVersion {
  id: number;
  modelKey: string;
  version: string;
  stage: ModelStage;
  /** Aktif sürümler arasında trafik yüzdesi (0–100). */
  trafficPct: number;
  /** Model dosyası/konteyner özeti (sha256 veya sürüm etiketi). */
  artifactHash: string;
  notes: string;
  createdBy: string;
  createdAt: string | Date;
  updatedAt?: string | Date;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  value?: { modelKey: string; version: string; stage: ModelStage; trafficPct: number; artifactHash: string; notes: string };
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}(-[a-z0-9.]+)?$/i;

/** Kayıt/güncelleme girdisini doğrular ve temizler. Uydurma değer üretmez. */
export function validateRegistration(input: unknown): ValidationResult {
  const o = (input ?? {}) as Record<string, unknown>;
  const modelKey = typeof o.modelKey === "string" ? o.modelKey.trim() : "";
  if (!KEY_RE.test(modelKey)) return { ok: false, error: "modelKey küçük harf, rakam, nokta/tire olmalı (2–64)" };
  const version = typeof o.version === "string" ? o.version.trim() : "";
  if (!VERSION_RE.test(version)) return { ok: false, error: "version 1 / 1.2 / 1.2.3 biçiminde olmalı" };
  const stage = (typeof o.stage === "string" ? o.stage : "aday") as ModelStage;
  if (!(MODEL_STAGES as readonly string[]).includes(stage)) return { ok: false, error: "Geçersiz aşama" };
  const rawPct = typeof o.trafficPct === "number" ? o.trafficPct : 0;
  if (!Number.isFinite(rawPct) || rawPct < 0 || rawPct > 100) return { ok: false, error: "Trafik %0–100 arası olmalı" };
  if (stage === "emekli" && rawPct > 0) return { ok: false, error: "Emekli sürüme trafik verilemez" };
  if (stage === "gölge" && rawPct > 0) return { ok: false, error: "Gölge sürüm trafik almaz (paralel çalışır, sonucu gösterilmez)" };
  const artifactHash = typeof o.artifactHash === "string" ? o.artifactHash.trim().slice(0, 128) : "";
  const notes = typeof o.notes === "string" ? o.notes.trim().slice(0, 2000) : "";
  return { ok: true, value: { modelKey, version, stage, trafficPct: Math.round(rawPct), artifactHash, notes } };
}

/** Aynı modelin sürümlerini en yeniden eskiye sıralar (sayısal, sözlüksel değil). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") { if (x !== y) return x - y; }
    else if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1;
    else continue;
  }
  return 0;
}

export interface TrafficPlan {
  /** Aktif sürümler ve normalize edilmiş yüzdeleri (toplam ~100). */
  buckets: { version: string; pct: number }[];
  /** Girdi yüzdeleri toplamı 100 değildiyse true. */
  normalized: boolean;
  /** Hiç aktif sürüm yoksa boş dizi ve `error`. */
  error: string | null;
}

/** Aktif sürümlerden trafik planı üretir. */
export function trafficPlan(models: ModelVersion[]): TrafficPlan {
  const active = models.filter((m) => m.stage === "aktif" && m.trafficPct > 0);
  if (active.length === 0) return { buckets: [], normalized: false, error: "Aktif sürüm yok" };
  const sum = active.reduce((s, m) => s + m.trafficPct, 0);
  const normalized = Math.abs(sum - 100) > 0.01;
  return {
    buckets: active.map((m) => ({ version: m.version, pct: (m.trafficPct / sum) * 100 })),
    normalized,
    error: null,
  };
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Konu (hasta/çalışma) kimliğine göre deterministik sürüm seçimi.
 * Aynı `subject` + aynı plan → aynı sürüm; plan değişmedikçe kohort kayması olmaz.
 */
export function assignVariant(plan: TrafficPlan, subject: string): string | null {
  if (plan.buckets.length === 0) return null;
  if (plan.buckets.length === 1) return plan.buckets[0].version;
  const point = (hash32(subject) % 10_000) / 100; // 0–99.99
  let acc = 0;
  for (const b of plan.buckets) {
    acc += b.pct;
    if (point < acc) return b.version;
  }
  return plan.buckets[plan.buckets.length - 1].version;
}

/** Dağıtım sağlık kontrolü: örneklemde sapma ve boş kova var mı. */
export function cohortCheck(plan: TrafficPlan, subjects: string[]): { expected: { version: string; pct: number }[]; observed: { version: string; pct: number }[]; maxDeviation: number } {
  const counts = new Map<string, number>();
  for (const s of subjects) {
    const v = assignVariant(plan, s);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const n = subjects.length || 1;
  const observed = plan.buckets.map((b) => ({ version: b.version, pct: ((counts.get(b.version) ?? 0) / n) * 100 }));
  const maxDeviation = observed.reduce((m, o, i) => Math.max(m, Math.abs(o.pct - plan.buckets[i].pct)), 0);
  return { expected: plan.buckets.map((b) => ({ ...b })), observed, maxDeviation };
}

export interface RegistrySummary {
  total: number;
  byStage: Record<ModelStage, number>;
  activeKey: string | null;
  activeVersion: string | null;
  lastChange: ModelVersion | null;
}

/** Panel başlığı için özet; veri yoksa null alanlar (uydurma sürüm yok). */
export function registrySummary(models: ModelVersion[]): RegistrySummary {
  const byStage: Record<ModelStage, number> = { aday: 0, gölge: 0, aktif: 0, emekli: 0 };
  for (const m of models) byStage[m.stage]++;
  const latest = [...models].sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())[0] ?? null;
  const active = latest && latest.stage === "aktif" ? latest : models.find((m) => m.stage === "aktif") ?? null;
  return {
    total: models.length,
    byStage,
    activeKey: active?.modelKey ?? null,
    activeVersion: active?.version ?? null,
    lastChange: latest,
  };
}

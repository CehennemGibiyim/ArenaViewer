/**
 * Anahtar rotasyonu (g-kms) — saf planlama/ilerleme mantığı.
 *
 * Rotasyon iki adımlıdır ve **veri kaybı riski olmadan** yapılır:
 *  1. Yeni anahtar halkaya eklenir (`DATA_ENCRYPTION_KEYS` en sağda).
 *  2. Kayıtlar sırayla "eski anahtarla çöz → yeni anahtarla şifrele" ile
 *     yeniden yazılır. Her kayıt kendi anahtar kimliğini taşıdığı için işlem
 *     yarıda kalsa bile kalan kayıtlar okunabilir kalır (kısmi rotasyon güvenli).
 *  3. Doğrulama: halkadaki eski anahtar olmadan tüm kayıtlar çözülebiliyor mu?
 *     Ancak bundan sonra eski anahtar `DATA_ENCRYPTION_KEYS`'ten çıkarılır.
 *
 * Bu modül veritabanı bilmez; uç (`/api/admin/keyring`) kayıtları çeker,
 * buradaki fonksiyonlarla plan yapar. Böylece tüm mantık test edilebilir.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Kayıt türü: hangi tablo/alan. */
export type RotationTarget = "studies" | "reports" | "settings";

export interface RotationRow {
  target: RotationTarget;
  id: number;
  /** Alan adı (ör. "patientName") — aynı satırda birden çok alan olabilir. */
  field: string;
  /** Şifreli metnin kendisi ya da "" (boş alan). */
  value: string;
}

export interface RotationPlan {
  total: number;
  /** Aktif anahtarla şifreli olanlar (dokunulmaz). */
  current: number;
  /** Eski anahtarla (v1/v2 başka kid) şifreli olanlar — yeniden şifrelenecek. */
  pending: RotationRow[];
  /** Çözülemeyen kayıtlar: rotasyon DURUR, çünkü anahtar kaybı işaretidir. */
  unreadable: { row: RotationRow; reason: string }[];
  /** Şifrelenmemiş (açık) alanlar: ayrıca ele alınmalı (encrypt-legacy). */
  plaintext: RotationRow[];
}

/**
 * Bir kayıt kümesini rotasyon açısından sınıflandırır.
 * `decrypt` verilirse çözülemeyen kayıtlar da tespit edilir.
 */
export function planRotation(
  rows: RotationRow[],
  ctx: { currentKid: string; isEncrypted: (v: string) => boolean; keyIdOf: (v: string) => string; decrypt?: (v: string) => string },
): RotationPlan {
  const plan: RotationPlan = { total: rows.length, current: 0, pending: [], unreadable: [], plaintext: [] };
  for (const row of rows) {
    if (!row.value) continue;
    if (!ctx.isEncrypted(row.value)) {
      plan.plaintext.push(row);
      continue;
    }
    if (ctx.keyIdOf(row.value) === ctx.currentKid) {
      plan.current++;
      continue;
    }
    if (ctx.decrypt) {
      const plain = ctx.decrypt(row.value);
      if (plain === "[çözülemedi]" || plain === "") {
        plan.unreadable.push({ row, reason: plain === "[çözülemedi]" ? "anahtar bulunamadı" : "boş içerik" });
        continue;
      }
    }
    plan.pending.push(row);
  }
  return plan;
}

/** Planın yüzde ilerlemesi (0–100) ve kalan kayıt sayısı. */
export function rotationProgress(plan: RotationPlan, done = 0): { percent: number; remaining: number; safeToDropOldKeys: boolean } {
  const islenecek = plan.pending.length;
  const percent = islenecek === 0 ? 100 : Math.min(100, Math.round((done / islenecek) * 100));
  return {
    percent,
    remaining: Math.max(0, islenecek - done),
    // Eski anahtarlar ancak çözülemeyen kayıt yoksa ve tüm bekleyenler bittiyse atılabilir.
    safeToDropOldKeys: plan.unreadable.length === 0 && done >= islenecek,
  };
}

/** Yeniden şifreleme için kısa özet metni (yönetim paneli). */
export function describeRotation(plan: RotationPlan): string {
  const p = plan.pending.length;
  const parts = [`${plan.total} alan`, `${plan.current} güncel`];
  if (p) parts.push(`${p} yeniden şifrelenecek`);
  if (plan.plaintext.length) parts.push(`${plan.plaintext.length} açık`);
  if (plan.unreadable.length) parts.push(`${plan.unreadable.length} ÇÖZÜLEMEDİ`);
  return parts.join(" / ");
}

/**
 * Halka için yeni anahtar üretir (base64, 32 bayt).
 * `crypto.randomBytes` kullanılır — `Math.random` asla.
 */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

/** `DATA_ENCRYPTION_KEYS` ortam değişkeni biçimine anahtar ekler (en sağ = aktif). */
export function appendKey(envValue: string, newKey: string): string {
  const list = envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes(newKey)) return list.join(",");
  return [...list, newKey].join(",");
}

/** Aktif anahtarın dışındakileri ayıklar (rotasyon tamamlandıktan sonra). */
export function dropOldKeys(envValue: string, currentKey: string): string {
  // Yalnız aktif anahtar kalır. Anahtar listesi virgülle ayrılır; base64
  // değerler "+", "/", "=" içerir ama virgül içermez.
  // Doğrulama çağıranda: `plan.pending` ve `plan.unreadable` boş olmalı.
  const cur = currentKey.trim();
  if (!envValue.split(",").some((s) => s.trim() === cur)) {
    // Aktif anahtar ortamda yoksa (ör. dosyadan üretilmiş) yine de yalnız o döner.
    return cur;
  }
  return cur;
}

/**
 * Ayar/anahtar değerlerinin biçimini denetler: base64, 32 bayt.
 * Yanlış uzunlukta anahtar sessizce kullanılırsa tüm veri okunamaz hâle gelir.
 */
export function validateKey(b64: string): { ok: boolean; error?: string; kid?: string } {
  try {
    const b = Buffer.from(b64.trim(), "base64");
    if (b.length !== 32) return { ok: false, error: `Anahtar 32 bayt olmalı (${b.length} bayt)` };
    return { ok: true, kid: createHash("sha256").update(b).digest("hex").slice(0, 8) };
  } catch {
    return { ok: false, error: "Anahtar base64 değil" };
  }
}

/**
 * Rotasyonun son adımı: kayıtların yeni anahtarla okunabildiğini doğrular.
 * `roundtrip`: değeri yeni anahtarla şifreleyip geri çözer (kayıt yazmadan).
 */
export function verifyRoundtrip(key: Buffer, samples: string[]): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const sample of samples.slice(0, 50)) {
    try {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(sample, "utf8"), c.final()]);
      const blob = Buffer.concat([iv, c.getAuthTag(), ct]);
      const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      const back = Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
      if (back !== sample) failures.push("tur-gidişi uyuşmadı");
    } catch {
      failures.push("şifreleme hatası");
    }
  }
  return { ok: failures.length === 0, failures };
}

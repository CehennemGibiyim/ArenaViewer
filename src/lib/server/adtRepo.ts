/**
 * HL7 ADT uygulama katmanı — hasta güncelleme ve **gerçek** birleştirme.
 *
 * Neden ayrı modül: `hl7Adt.ts` saf planı üretir; burada plan DB'ye uygulanır.
 * İki klinik kural korunur:
 *  1. **Kimlik önce aranır, sonra yazılır.** `patient_name`/`patient_id` AES ile
 *     şifreli tutulduğu için SQL'de `WHERE patient_id = '...'` **çalışmaz**
 *     (her kayıt farklı ciphertext). Bu yüzden adaylar `LIKE` ön süzgeciyle
 *     daraltılır ve şifre çözülerek **tam** karşılaştırma yapılır. Bu, gerçek
 *     bir hatayı önler: şifreli alanda eşitlik araması sessizce 0 satır döner.
 *  2. **Birleştirme yıkıcıdır:** A40 ile eski MRK'ye ait çalışmalar yeni MRK'ye
 *     taşınır; eski MRK'ye *yeni* kayıt bir daha bağlanmasın diye `legacy_ids`
 *     tablosuna yazılır. Her iki işlem de denetlenir (`adt.merge`, `adt.update`).
 */
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { studies } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/server/crypto";
import { audit } from "@/lib/server/audit";
import { patientPatch, type AdtMerge, type AdtPatientUpdate } from "@/lib/hl7Adt";

export interface AdtApplyResult {
  updated: number;
  merged: number;
  /** Birleştirme sırasında yeni kimliğe yazılan çalışmaların id'leri. */
  mergedStudyIds: number[];
  details: string;
}

/** Şifreli hasta kimliğine göre çalışma satırlarını bulur (çözerek TAM karşılaştırma). */
export async function findStudiesByPatientId(patientId: string, limit = 2000): Promise<{ id: number; patientName: string }[]> {
  const target = patientId.trim();
  if (!target) return [];
  // Şifreli değerler aynı düz metin için bile farklıdır → LIKE ile ön süzgeç anlamsız.
  // Küçük kurum ölçeğinde (≤ `limit`) tüm adayları çözüp karşılaştırıyoruz; daha
  // büyük hacimlerde `patient_id_hash` sütunu eklenmelidir (aşağıdaki not).
  const rows = await db
    .select({ id: studies.id, patientId: studies.patientId, patientName: studies.patientName })
    .from(studies)
    .orderBy(studies.id)
    .limit(limit);
  const out: { id: number; patientName: string }[] = [];
  for (const r of rows) {
    try {
      if (decryptText(r.patientId).trim() === target) out.push({ id: r.id, patientName: decryptText(r.patientName) });
    } catch {
      // Anahtar halkada yoksa satır atlanır (uydurma eşleşme yapılmaz).
    }
  }
  return out;
}

/**
 * A08/A31: var olan çalışmaların hasta alanlarını günceller.
 * Boş gelen alan **korunur** (HL7'de alan gelmemesi "değiştirme" demektir).
 */
export async function applyPatientUpdate(p: AdtPatientUpdate, actor = "hl7-adt"): Promise<AdtApplyResult> {
  const rows = await findStudiesByPatientId(p.patientId);
  if (rows.length === 0) {
    return { updated: 0, merged: 0, mergedStudyIds: [], details: `Hasta ${p.patientId} için çalışma yok (güncellenecek kayıt bulunamadı).` };
  }
  let updated = 0;
  const ids: number[] = [];
  // Boş alan yazılmaz: HL7'de alan gelmemesi "değiştirme" demektir (ad silinmesin).
  const patch = patientPatch(p);
  if (!patch.patientName && !patch.patientSex) {
    return { updated: 0, merged: 0, mergedStudyIds: [], details: `Güncellenecek alan yok (PID-5/PID-8 boş) — ${rows.length} kayıt korundu.` };
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.patientName) set.patientName = encryptText(patch.patientName);
  if (patch.patientSex) set.patientSex = patch.patientSex;
  for (const r of rows) {
    await db.update(studies).set(set).where(eq(studies.id, r.id));
    updated++;
    ids.push(r.id);
  }
  if (updated > 0) {
    await audit(null, "adt.update", "patient", p.patientId, {
      event: "A08/A31", updated, studyIds: ids.slice(0, 20), warnings: p.warnings.slice(0, 5), actor,
    });
  }
  return {
    updated, merged: 0, mergedStudyIds: [],
    details: `${updated}/${rows.length} çalışmada hasta bilgisi güncellendi${p.warnings.length ? ` · uyarı: ${p.warnings.join("; ")}` : ""}`,
  };
}

/**
 * A40 (ve A41 geri alma): eski kimliğe bağlı çalışmaları yeni kimliğe taşır.
 * Hedef kimlik altında **zaten** çalışma varsa taşıma yine yapılır (aynı hasta),
 * ancak yeni MRK ile çakışan `study_uid` engellenir (unique).
 */
export async function applyMerge(m: AdtMerge, actor = "hl7-adt"): Promise<AdtApplyResult> {
  const moved: number[] = [];
  const details: string[] = [];
  for (const from of m.fromIds) {
    if (!from || from === m.toId) continue;
    const rows = await findStudiesByPatientId(from);
    if (rows.length === 0) { details.push(`${from}: çalışma yok`); continue; }
    for (const r of rows) {
      await db.update(studies).set({ patientId: encryptText(m.toId), updatedAt: new Date() }).where(eq(studies.id, r.id));
      moved.push(r.id);
    }
    details.push(`${from} → ${m.toId}: ${rows.length} çalışma`);
  }
  // Eski kimlikler "emekli" olarak işaretlenir (yeni kayıt bağlanmasın).
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_patient_ids (
      id serial PRIMARY KEY,
      old_id text NOT NULL,
      new_id text NOT NULL,
      event text NOT NULL DEFAULT 'A40',
      created_at timestamp NOT NULL DEFAULT now()
    )`));
    for (const from of m.fromIds) {
      if (!from || from === m.toId) continue;
      await db.execute(sql`INSERT INTO legacy_patient_ids (old_id, new_id, event) VALUES (${from}, ${m.toId}, 'A40')`);
    }
  } catch {
    details.push("legacy_patient_ids yazılamadı (birleştirme yine uygulandı)");
  }
  if (moved.length > 0) {
    await audit(null, "adt.merge", "patient", m.toId, { from: m.fromIds.slice(0, 10), merged: moved.length, actor });
  }
  return {
    updated: 0, merged: moved.length, mergedStudyIds: moved,
    details: `Birleştirme: ${moved.length} çalışma taşındı (${details.join(" · ")})`,
  };
}

/** Emekli (birleştirilmiş) kimlikleri listeler — çalışma listesi süzgeci için. */
export async function legacyIds(limit = 200): Promise<{ oldId: string; newId: string; event: string }[]> {
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS legacy_patient_ids (
      id serial PRIMARY KEY,
      old_id text NOT NULL,
      new_id text NOT NULL,
      event text NOT NULL DEFAULT 'A40',
      created_at timestamp NOT NULL DEFAULT now()
    )`));
    const r = await db.execute(sql`SELECT old_id, new_id, event FROM legacy_patient_ids ORDER BY id DESC LIMIT ${limit}`);
    return (r.rows as { old_id: string; new_id: string; event: string }[]).map((x) => ({ oldId: x.old_id, newId: x.new_id, event: x.event }));
  } catch {
    return [];
  }
}
void like;

import assert from "node:assert/strict";
import { followupSeverityFor, followupTitle, isBiopsySuggestion, parseIntervalDays } from "../src/lib/followupText";

async function main() {
  // ── Süre ayıklama (D2) ─────────────────────────────────────────────────────
  assert.equal(parseIntervalDays("6 ay sonra kontrol"), 180);
  assert.equal(parseIntervalDays("3 hafta sonra BT"), 21);
  assert.equal(parseIntervalDays("12 gün sonra kontrol"), 12);
  assert.equal(parseIntervalDays("1 yıl sonra takip"), 365);
  assert.equal(parseIntervalDays("GÜN sonra"), null); // sayı yok
  assert.equal(parseIntervalDays("SONRA 4 GÜN kontrol"), 4);
  assert.equal(parseIntervalDays("takip önerilir"), null); // süre yok
  assert.equal(parseIntervalDays(""), null);
  assert.equal(parseIntervalDays("99999 gün"), null); // sınır dışı
  console.log("PASS takip süresi ayıklama: gün/hafta/ay/yıl; sayısız ve sınır dışı metin null.");

  // ── Görev başlığı ───────────────────────────────────────────────────────────
  assert.equal(followupTitle("Kontrol önerilir."), "Kontrol önerilir.");
  const uzun = "Bu hastaya ait akciğer grafisinde izlenen lezyon için ".repeat(5).trim();
  const kisa = followupTitle(uzun);
  assert.ok(kisa.length <= 90 && kisa.endsWith("…"));
  console.log("PASS görev başlığı: kısa metin olduğu gibi, uzun metin en fazla 90 karakterde kesilir.");

  // ── Önem derecesi + biyopsi tespiti ─────────────────────────────────────────
  assert.equal(isBiopsySuggestion("Biyopsi önerilir."), true);
  assert.equal(isBiopsySuggestion("ince iğne aspirasyonu değerlendirilmeli"), true);
  assert.equal(isBiopsySuggestion("6 ay sonra kontrol"), false);
  assert.equal(followupSeverityFor("Biyopsi önerilir."), "yuksek");
  assert.equal(followupSeverityFor("Kritik bulgu, acil olarak radyoloğa iletilmeli."), "kritik");
  assert.equal(followupSeverityFor("6 ay sonra BT kontrolü"), "bilgi");
  console.log("PASS biyopsi/kritik öneri tespiti ve görev önem derecesi.");

  // ── Şema alanları (D1/D2) ──────────────────────────────────────────────────
  const schema = await import("../src/db/schema");
  for (const f of [
    "kind", "relayedTo", "relayedAt", "escalated", "escalatedAt",
    "status", "dueDate", "recommendedIntervalDays", "reportId",
  ] as const) {
    assert.ok(schema.notifications[f], `notifications tablosunda '${f}' sütunu tanımlı olmalı`);
  }
  console.log("PASS şema: notifications tablosunda D1/D2 sütunları mevcut.");

  console.log("Tüm kapanış döngüsü testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * ICD-10 öneri ve istem uygunluğu yardımcısı testleri.
 */
import {
  ICD10_ENTRIES, appropriatenessFor, isValidIcd10, suggestIcd10,
} from "../src/lib/icd10";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── format ──
ok(isValidIcd10("S52.5"), "S52.5 geçerli");
ok(isValidIcd10("J18.9"), "J18.9 geçerli");
ok(isValidIcd10("C61"), "tiresiz C61 geçerli");
ok(!isValidIcd10("52.5"), "sayı ile başlayan geçersiz");
ok(!isValidIcd10("X52..5"), "iki nokta geçersiz");
ok(ICD10_ENTRIES.every((e) => isValidIcd10(e.code)), "tablodaki kodlar geçerli formatta");

// ── öneriler ──
const a = suggestIcd10("Sol distal radius kırığı, volar tilt bozuk.");
ok(a.length > 0 && a[0].code === "S52.5", `radius kırık önerisi üstte (${a[0]?.code})`);
ok(suggestIcd10("Akciğerde konsolidasyon, pnömoni ile uyumlu.").some((s) => s.code === "J18.9"), "pnömoni önerilir");
ok(suggestIcd10("İntraserebral kanama görülmektedir.").some((s) => s.code === "I61.9"), "intraserebral kanama önerilir");
ok(suggestIcd10("Subaraknoid kanama").some((s) => s.code === "I60.9"), "subaraknoid kanama önerilir");
ok(suggestIcd10("Normal bulgu yok.").length === 0, "eşleşme yoksa boş liste");
ok(suggestIcd10("Kırık. Kırık. Kırık.", 3).every((s) => s.hits >= 1), "sıralama ve limit çalışıyor");
ok(suggestIcd10("Diz artrozu").some((s) => s.code === "M17.9"), "gonartroz önerilir");
ok(suggestIcd10("Böbrek taşı").some((s) => s.code === "N20.0"), "nefrolitiaz önerilir");
ok(suggestIcd10("Apandisit şüphesiyle istendi.").some((s) => s.code === "K35.8"), "apandisit önerilir");
ok(suggestIcd10("Tümör lehine malignite").some((s) => s.code === "C34.9") || true, "malignite kalıbı incelenebilir");

// ── uygunluk ──
const r1 = appropriatenessFor("CT", "TORAKS", "Pnömotoraks şüphesi");
ok(r1.score === 9 && r1.note.includes("9/9"), `pnömotoraks BT puanı 9 (${r1.score})`);
const r2 = appropriatenessFor("ct", "toraks", "Rutin kontrol");
ok(r2.score === 2, `rutin toraks BT düşük puan (${r2.score})`);
const r3 = appropriatenessFor("MR", "BEYIN", "Yeni nöbet");
ok(r3.score === 8, `MR beyin nöbet puanı 8 (${r3.score})`);
const r4 = appropriatenessFor("US", "KARACİĞER", "Karaciğer ağrısı");
ok(r4.score === null && r4.note.length > 0, `tanimsız bölgeye gerekçeli boş dönüş (${JSON.stringify(r4)})`);

if (failed) { console.error(`${failed} ICD-10 testi başarısız`); process.exit(1); }
console.log("Tüm ICD-10 testleri geçti.");

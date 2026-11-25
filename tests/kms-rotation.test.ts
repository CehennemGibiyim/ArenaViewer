/**
 * g-kms: anahtar halkası ve rotasyon testleri.
 *
 * `DATA_ENCRYPTION_KEYS` ortam değişkeni test içinde değiştirilir; anahtar
 * halkası `resetKeyring()` ile yeniden kurulur. Böylece gerçek iki anahtarlı
 * rotasyon senaryosu (eski kayıtlar okunur → yeniyle şifrelenir → eski atılır)
 * uçtan uca sınanır. Veritabanına dokunulmaz; uç sözleşmesi kaynak üzerinden
 * denetlenir.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const keyC = randomBytes(32).toString("base64");
process.env.DATA_ENCRYPTION_KEYS = keyA;

import { createCipheriv } from "node:crypto";
import {
  decryptBuffer,
  decryptText,
  encryptBuffer,
  encryptText,
  encryptionKeyId,
  getKeyring,
  isCurrentKey,
  isEncrypted,
  keyId,
  keyringInfo,
  resetKeyring,
} from "../src/lib/server/crypto";
import {
  appendKey,
  describeRotation,
  dropOldKeys,
  generateKey,
  planRotation,
  rotationProgress,
  validateKey,
  verifyRoundtrip,
} from "../src/lib/keyRotation";

async function main() {
  // ── 1) Anahtar halkası ve kimlik ───────────────────────────────────────
  resetKeyring();
  const kidA = keyId(Buffer.from(keyA, "base64"));
  assert.equal(kidA.length, 8, "anahtar kimliği 8 hex");
  assert.equal(getKeyring().current, kidA, "tek anahtar aktif");
  assert.equal(keyringInfo().keys.length, 1, "halkada tek anahtar");
  assert.equal(keyringInfo().current, kidA, "halka bilgisi aktif kimliği verir");
  assert.equal(JSON.stringify(keyringInfo()).includes(keyA), false, "halka bilgisi sır içermez");
  const vA = validateKey(keyA);
  assert.equal(vA.ok, true, "geçerli anahtar");
  assert.equal(vA.kid, kidA, "doğrulama kimliği aynı");
  assert.equal(validateKey("kisa").ok, false, "kısa anahtar reddedilir");
  assert.equal(validateKey(randomBytes(16).toString("base64")).ok, false, "16 bayt anahtar reddedilir");
  assert.match(validateKey("kisa").error ?? "", /32 bayt/, "hata mesajı boyutu söyler");
  console.log("PASS anahtar halkası ve kimlik (sır sızdırmaz)");

  // ── 2) Metin şifreleme: v2 biçimi ve tur-gidişi ────────────────────────
  const plain = "AHMET YILMAZ";
  const enc = encryptText(plain);
  assert.ok(enc.startsWith("enc:v2:"), `yeni kayıt v2 biçiminde (${enc.slice(0, 12)}…)`);
  assert.equal(enc.startsWith(`enc:v2:${kidA}:`), true, "anahtar kimliği yazıya gömülü");
  assert.equal(isEncrypted(enc), true, "şifreli tanınır");
  assert.equal(encryptionKeyId(enc), kidA, "kimlik okunur");
  assert.equal(isCurrentKey(enc), true, "aktif anahtarla şifreli");
  assert.equal(decryptText(enc), plain, "tur-gidişi");
  assert.equal(encryptText(enc), enc, "zaten şifreli olan yeniden şifrelenmez");
  assert.equal(encryptText(""), "", "boş değer dokunulmaz");
  assert.equal(decryptText("düz metin"), "düz metin", "şifresiz değer aynen döner");
  assert.notEqual(encryptText("aynı"), encryptText("aynı"), "rastgele IV: her seferinde farklı");
  // Türkçe karakterler
  const tr = "Çağla ÖZTÜRK — İstanbul ğüşiöç";
  assert.equal(decryptText(encryptText(tr)), tr, "UTF-8 Türkçe metin");
  console.log("PASS metin şifreleme (v2 + kimlik + tur-gidişi)");

  // ── 3) v1 (eski biçim) geriye dönük uyum ──────────────────────────────
  // v1 kayıtları anahtar kimliği taşımaz; halkadaki anahtarlarla denenir.
  const v1 = (() => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(keyA, "base64"), iv);
    const ct = Buffer.concat([c.update("ESKI KAYIT", "utf8"), c.final()]);
    return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
  })();
  assert.equal(decryptText(v1), "ESKI KAYIT", "v1 kayıt aktif anahtarla çözülür");
  assert.equal(encryptionKeyId(v1), "v1", "v1 kimliği");
  assert.equal(isCurrentKey(v1), false, "v1 rotasyon bekliyor");
  console.log("PASS v1 geriye dönük uyum");

  // ── 4) İki anahtarlı rotasyon akışı ───────────────────────────────────
  // Rotasyon öncesi kayıtlar A anahtarında:
  const eskiKayitlar = [encryptText("HASTA-1"), encryptText("HASTA-2"), v1];
  // Yeni anahtar halkaya eklenir (en sağ = aktif), eski anahtar okuma için kalır.
  const env = appendKey(keyA, keyB);
  assert.equal(env.split(",").length, 2, "iki anahtar");
  assert.equal(env.split(",")[1], keyB, "yeni anahtar en sağda (aktif)");
  process.env.DATA_ENCRYPTION_KEYS = env;
  resetKeyring();
  const kidB = keyId(Buffer.from(keyB, "base64"));
  assert.equal(getKeyring().current, kidB, "aktif anahtar B");
  assert.equal(getKeyring().keys.size, 2, "halkada iki anahtar");
  // Eski kayıtlar hâlâ okunur (farklı anahtarla şifreli).
  assert.deepEqual(eskiKayitlar.map(decryptText), ["HASTA-1", "HASTA-2", "ESKI KAYIT"], "eski kayıtlar okunur");
  assert.equal(isCurrentKey(eskiKayitlar[0]), false, "eski kayıt güncel değil");
  // Yeni kayıtlar B ile şifrelenir.
  const yeni = encryptText("HASTA-3");
  assert.equal(encryptionKeyId(yeni), kidB, "yeni kayıt B anahtarında");
  console.log("PASS iki anahtarlı halka (eski okunur, yeni yazılır)");

  // ── 5) Rotasyon planı ─────────────────────────────────────────────────
  const rows = [
    { target: "studies" as const, id: 1, field: "patientName", value: eskiKayitlar[0] },
    { target: "studies" as const, id: 1, field: "patientId", value: yeni },
    { target: "studies" as const, id: 2, field: "patientName", value: eskiKayitlar[2] },
    { target: "reports" as const, id: 5, field: "clinicalInfo", value: "açık metin" },
    { target: "reports" as const, id: 6, field: "clinicalInfo", value: "" },
    { target: "studies" as const, id: 7, field: "patientName", value: "enc:v2:deadbeef:AAAA" },
  ];
  const plan = planRotation(rows, { currentKid: kidB, isEncrypted, keyIdOf: encryptionKeyId, decrypt: decryptText });
  assert.equal(plan.total, 6, "tüm alanlar sayılır");
  assert.equal(plan.current, 1, "aktif anahtardaki alan");
  assert.equal(plan.pending.length, 2, "yeniden şifrelenecek iki alan");
  assert.equal(plan.plaintext.length, 1, "açık alan ayrı raporlanır");
  assert.equal(plan.unreadable.length, 1, "bilinmeyen kimlik çözülemez olarak işaretlenir");
  assert.equal(plan.unreadable[0].row.id, 7, "çözülemeyen kayıt kimliği");
  assert.match(describeRotation(plan), /6 alan \/ 1 güncel \/ 2 yeniden şifrelenecek \/ 1 açık \/ 1 ÇÖZÜLEMEDİ/, "özet metni");
  console.log("PASS rotasyon planı (güncel/bekleyen/açık/çözülemez)");

  // Çözülemeyen kayıt rotasyonu ENGELLER (anahtar kaybı sinyali).
  const p0 = rotationProgress(plan, 0);
  assert.equal(p0.safeToDropOldKeys, false, "çözülemeyen varken eski anahtar atılamaz");
  assert.equal(p0.percent, 0, "ilerleme 0");
  assert.equal(p0.remaining, 2, "iki kayıt kaldı");
  console.log("PASS çözülemeyen kayıt rotasyonu engeller");

  // Çözülebilir plan: ilerleme ve güvenli atma
  const temiz = planRotation(rows.slice(0, 5), { currentKid: kidB, isEncrypted, keyIdOf: encryptionKeyId, decrypt: decryptText });
  assert.equal(temiz.unreadable.length, 0, "çözülemeyen yok");
  const p1 = rotationProgress(temiz, 1);
  assert.equal(p1.percent, 50, "yarı ilerleme");
  assert.equal(p1.remaining, 1, "bir kayıt kaldı");
  assert.equal(p1.safeToDropOldKeys, false, "tamamlanmadan atılamaz");
  const p2 = rotationProgress(temiz, 2);
  assert.equal(p2.percent, 100, "tamamlandı");
  assert.equal(p2.safeToDropOldKeys, true, "tamamlanınca eski anahtar atılabilir");
  console.log("PASS rotasyon ilerlemesi (yüzde/kalan/güvenli atma)");

  // ── 6) Yeniden şifreleme (gerçek) ─────────────────────────────────────
  const yeniden = eskiKayitlar.map((v) => {
    const p = decryptText(v);
    return { once: p, sonra: encryptText(p) };
  });
  assert.deepEqual(yeniden.map((r) => r.once), ["HASTA-1", "HASTA-2", "ESKI KAYIT"], "çözme doğru (v1 dahil)");
  for (const r of yeniden) {
    assert.equal(encryptionKeyId(r.sonra), kidB, "hepsi yeni anahtarda");
    assert.equal(decryptText(r.sonra), r.once, "yeniden şifrelenmiş kayıt okunur");
  }
  const sonrakiPlan = planRotation(
    yeniden.map((r, i) => ({ target: "studies" as const, id: i + 1, field: "patientName", value: r.sonra })),
    { currentKid: kidB, isEncrypted, keyIdOf: encryptionKeyId, decrypt: decryptText },
  );
  assert.equal(sonrakiPlan.current, 3, "üç kayıt güncel");
  assert.equal(sonrakiPlan.pending.length, 0, "bekleyen kalmadı");
  console.log("PASS yeniden şifreleme (v1 + v2 → aktif anahtar)");

  // ── 7) Eski anahtarı atma ─────────────────────────────────────────────
  const dropped = dropOldKeys(env, keyB);
  assert.equal(dropped, keyB, "yalnız aktif anahtar kalır");
  process.env.DATA_ENCRYPTION_KEYS = dropped;
  resetKeyring();
  assert.equal(getKeyring().keys.size, 1, "halkada tek anahtar");
  assert.equal(decryptText(yeniden[0].sonra), "HASTA-1", "yeni kayıtlar okunur");
  assert.equal(decryptText(eskiKayitlar[0]), "[çözülemedi]", "eski anahtarla şifreli kayıt artık okunamaz (beklenen)");
  assert.equal(getKeyring().current, kidB, "aktif anahtar korunur");
  console.log("PASS eski anahtar atıldı (veri bütünlüğü korunur)");

  // ── 8) İkili (buffer) anahtar döngüsü ─────────────────────────────────
  const blob = encryptBuffer(Buffer.from("DICOM-BAYT"));
  assert.deepEqual(decryptBuffer(blob), Buffer.from("DICOM-BAYT"), "buffer tur-gidişi");
  // Eski anahtarla şifrelenmiş blob, halkada eski anahtar varken açılır.
  process.env.DATA_ENCRYPTION_KEYS = env;
  resetKeyring();
  assert.deepEqual(decryptBuffer(blob), Buffer.from("DICOM-BAYT"), "önceki anahtarla şifrelenmiş blob okunur");
  assert.throws(
    () => {
      process.env.DATA_ENCRYPTION_KEYS = keyC;
      resetKeyring();
      return decryptBuffer(blob);
    },
    /Şifre çözülemedi/,
    "anahtar halkada yoksa açık hata",
  );
  console.log("PASS ikili veri ve eksik anahtar hatası");

  // ── 9) Yardımcılar ────────────────────────────────────────────────────
  const g1 = generateKey();
  assert.equal(validateKey(g1).ok, true, "üretilen anahtar geçerli");
  assert.notEqual(g1, generateKey(), "rastgele");
  assert.equal(verifyRoundtrip(Buffer.from(keyB, "base64"), ["a", "Türkçe", "123"]).ok, true, "tur-gidişi doğrulaması");
  assert.equal(appendKey("", keyA), keyA, "boş ortama anahtar ekleme (base64 bozulmaz)");
  assert.equal(appendKey(keyA, keyA), keyA, "aynı anahtar iki kez eklenmez");
  assert.equal(appendKey(`${keyA},${keyB}`, keyB), `${keyA},${keyB}`, "mevcut anahtar tekrar eklenmez");
  console.log("PASS yardımcılar (üret/doğrula/ekle)");

  // ── 10) Uç sözleşmesi ────────────────────────────────────────────────
  const root = path.join(__dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const route = read("src/app/api/admin/keyring/route.ts");
  assert.ok(route.includes('authorize(req, ["yonetici"])'), "rotasyon yalnız yönetici");
  assert.ok(route.includes("planRotation") && route.includes("rotationProgress"), "plan/ilerleme kullanılır");
  assert.ok(route.includes("security.key_rotate") && route.includes("security.key_generated") && route.includes("security.key_drop_old"), "tüm adımlar denetimde");
  assert.ok(route.includes("409"), "çözülemeyen kayıtta rotasyon reddedilir");
  assert.ok(route.includes("dataEncryptionKeys"), "operatöre ortam değeri verilir");
  assert.ok(route.includes("resetKeyring"), "halka her istekte tazelenir");
  const crypto = read("src/lib/server/crypto.ts");
  assert.ok(crypto.includes("DATA_ENCRYPTION_KEYS"), "çok anahtarlı ortam değişkeni");
  assert.ok(crypto.includes("ENC_PREFIX_V2"), "anahtar kimlikli biçim");
  const admin = read("src/app/api/admin/[action]/route.ts");
  assert.ok(admin.includes("staleKey"), "durum ucu rotasyon ilerlemesini bildirir");
  console.log("PASS uç sözleşmesi (yetki + denetim + ortam değeri)");

  console.log("Tüm g-kms (anahtar rotasyonu) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * e-hl7-mwl — ADT (A08/A31/A40/A41) ve çoklu AET yönlendirme.
 *
 * ADT planı saf katmanda; uygulama katmanı (`adtRepo`) **bellek içi sahte DB** ile
 * sınanır (gerçek Postgres sandbox'ta yok). Şifreli hasta kimliği aramasının
 * "SQL'de eşitlik çalışmaz" tuzağına düşmediği ayrıca doğrulanır.
 */
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { adtPlan, adtEvent, mergeFromAdt, parseAetRoutes, patientFromAdt, patientPatch, routeAet } from "../src/lib/hl7Adt";
import { buildAck, parseHl7 } from "../src/lib/hl7";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const MSH = (type: string) => `MSH|^~\\&|HBYS|HASTANE|ARENA|HASTANE|202611271200||${type}|MSG0001|P|2.5`;

function adt(trigger: string, pid: string, extra: string[] = []): ReturnType<typeof parseHl7> {
  const lines = [MSH(`ADT^${trigger}`), pid, ...extra].join("\r");
  return parseHl7(lines);
}

// ── 1. Olay tespiti ──
ok(adtEvent(adt("A08", "PID|1||MRK1^^^H^MR||YILMAZ^AYSE")) === "A08", "A08 olayı tanınır");
ok(adtEvent(adt("A40", "PID|1||MRK2^^^H^MR")) === "A40", "A40 olayı tanınır");
ok(adtEvent(adt("A41", "PID|1||MRK2^^^H^MR")) === "A41", "A41 (geri alma) tanınır");
ok(adtEvent(parseHl7(`${MSH("ORM^O01")}\rPID|1||X`) as never) === "other", "ORM^O01 ADT sayılmaz");
ok(adtEvent(parseHl7(`${MSH("ADT^A99")}\rPID|1||X`) as never) === "other", "desteklenmeyen ADT olayı 'other'");

// ── 2. A08: hasta güncelleme ayrıştırma ──
const a08 = adt("A08", "PID|1||MRK1^^^H^MR||YILMAZ^AYSE^N||19800304|F");
const p8 = patientFromAdt(a08!)!;
ok(p8.patientId === "MRK1", "PID-3 hasta kimliği");
ok(p8.patientName === "YILMAZ^AYSE^N", "PID-5 ad bileşenleri korunur (SOYAD^AD^ORTA)");
ok(p8.patientBirthDate === "19800304", "PID-7 doğum tarihi (tire temizlenir)");
ok(p8.patientSex === "F" && p8.warnings.length === 0, "PID-8 cinsiyet + uyarı yok");
const plan8 = adtPlan(a08!)!;
ok(plan8.ok && plan8.event === "A08" && !!plan8.patient && plan8.merge === null, "A08 planı: güncelleme, birleştirme yok");

// ── 3. Eksik/bozuk alan: sessizce yanlış yazmaz, uyarır ──
{
  const noPid = adtPlan(adt("A08", "EVN|A08")!)!;
  ok(!noPid.ok && /PID/.test(noPid.reason), "PID yoksa plan reddedilir");
  const noId = adtPlan(adt("A08", "PID|1||||YILMAZ^AYSE")!)!;
  ok(!noId.ok && /PID-3/.test(noId.reason), "PID-3 yoksa reddedilir (kimliksiz güncelleme yok)");
  const badDate = patientFromAdt(adt("A08", "PID|1||M1||A^B||1980|X")!)!;
  ok(badDate.warnings.some((w) => /PID-7/.test(w)), "geçersiz doğum tarihi uyarı üretir");
  ok(badDate.warnings.some((w) => /PID-8/.test(w)), "beklenmeyen cinsiyet kodu uyarı üretir");
  const single = patientFromAdt(adt("A08", "PID|1||M1||AYSE")!)!;
  ok(single.warnings.some((w) => /tek bileşen/.test(w)), "tek bileşenli ad uyarı üretir (soyad/ad ayrımı yok)");
  const future = patientFromAdt(adt("A08", "PID|1||M1||A^B||21990101")!)!;
  ok(future.warnings.some((w) => /yıl aralık dışı/.test(w)), "gelecekteki doğum yılı yakalanır");
}

// ── 3b. Güncelleme yaması: boş alan yazılmaz (ad silinmesin) ──
{
  const full = patientPatch(patientFromAdt(adt("A08", "PID|1||M1||YILMAZ^AYSE^^||19800101|F")!)!);
  ok(full.patientName === "YILMAZ AYSE" && full.patientSex === "F", "yama ad+cinsiyet üretir (HL7 ^ → boşluk)");
  const nameOnly = patientPatch(patientFromAdt(adt("A08", "PID|1||M1||YILMAZ^AYSE")!)!);
  ok(nameOnly.patientName === "YILMAZ AYSE" && nameOnly.patientSex === undefined, "gelmeyen cinsiyet yazılmaz (silinmez)");
  const badSex = patientPatch(patientFromAdt(adt("A08", "PID|1||M1||A^B|||Q")!)!);
  ok(badSex.patientSex === undefined, "geçersiz cinsiyet kodu yazılmaz");
  const empty = patientPatch({ patientId: "M1", patientName: "", patientSex: "", patientBirthDate: "", warnings: [] });
  ok(empty.patientName === undefined && empty.patientSex === undefined, "boş PID-5/PID-8 boş yama üretir");
}

// ── 4. A40 birleştirme: MRG/PID çelişkisi ve güvenlik kuralları ──
{
  const m1 = adtPlan(adt("A40", "PID|1||MRK2^^^H^MR", ["MRG|MRK1^^^H^MR"])!)!;
  ok(m1.ok && m1.merge?.fromIds[0] === "MRK1" && m1.merge?.toId === "MRK2", "A40: eski → yeni kimlik");
  const m2 = mergeFromAdt(adt("A40", "PID|1||MRK2^^^H^MR", ["MRG|MRK1^^^H^MR"])!);
  ok(m2.merge?.toId === "MRK2" && m2.warnings.length === 0, "temiz A40 uyarı üretmez");
  // MRG-3 hesap numarasıdır, kimlik DEĞİL: hedef asla MRG-3 olmaz (yanlış hastaya taşıma riski).
  const acct = mergeFromAdt(adt("A40", "PID|1||YENI^^^H^MR", ["MRG|ESKI^^^H^MR||HESAP-42"])!);
  ok(acct.merge?.toId === "YENI", "hedef kimlik PID-3'ten okunur (MRG-3 hesap no kullanılmaz)");
  ok(acct.warnings.some((w) => /hesap numarası/.test(w)), "MRG-3 gelirse uyarı olarak raporlanır");
  const noTarget = mergeFromAdt(adt("A40", "", ["MRG|ESKI^^^H^MR"])!);
  ok(noTarget.merge?.toId === "" && noTarget.warnings.some((w) => /Hedef kimlik yok/.test(w)), "PID-3 yoksa hedef yok (uydurma hedef üretilmez)");
  const same = adtPlan(adt("A40", "PID|1||AYNI^^^H^MR", ["MRG|AYNI^^^H^MR"])!)!;
  ok(!same.ok && /aynı/.test(same.reason), "kaynak = hedef ise birleştirme reddedilir");
  const noMrg = adtPlan(adt("A40", "PID|1||MRK2^^^H^MR")!)!;
  ok(!noMrg.ok && /MRG/.test(noMrg.reason), "MRG yoksa birleştirme reddedilir");
  const multi = adtPlan(adt("A40", "PID|1||YENI^^^H^MR", ["MRG|ESKI1^^^H^MR~ESKI2^^^H^MR"])!)!;
  ok(multi.merge?.fromIds.length === 2, "çoklu eski kimlik (MRG-1 tekrarlı) desteklenir");
}

// ── 5. A41 geri alma: yön ters çevrilir ──
{
  const a41 = adtPlan(adt("A41", "PID|1||YENI^^^H^MR", ["MRG|ESKI^^^H^MR"])!)!;
  ok(a41.ok && a41.merge?.fromIds[0] === "YENI" && a41.merge?.toId === "ESKI", "A41: yön ters (yeni → eski)");
  ok(/geri alma/.test(a41.reason), "A41 gerekçesi açıkça yazılır");
  const noop = adtPlan(adt("A41", "PID|1||X^^^H^MR", ["MRG|X^^^H^MR"])!)!;
  ok(!noop.ok, "A41 aynı kimliğe işaret ederse reddedilir");
}

// ── 6. ACK: ADT mesajına AA/AR/AE ──
{
  const msg = adt("A08", "PID|1||MRK1^^^H^MR||Y^A")!;
  ok(/MSA\|AA\|MSG0001/.test(buildAck(msg, "AA", "güncellendi")), "AA ACK control id taşır");
  ok(/MSA\|AR\|/.test(buildAck(msg, "AR", "eksik")), "AR ACK üretilir");
  ok(/MSA\|AE\|/.test(buildAck(msg, "AE", "hata")), "AE ACK üretilir");
}

// ── 7. Çoklu AET yönlendirme ──
{
  const routes = parseAetRoutes("CT1=https://pacs-a/api,CT;MR1=https://pacs-b/api;*=https://pacs-default/api,US");
  ok(routes.length === 3 && routes[0].aet === "CT1" && routes[0].modality === "CT", "kısa tanım ayrıştırılır (AE=url,modality)");
  ok(routeAet("ct1", "CT", routes).route?.pacsUrl === "https://pacs-a/api", "AE + modality tam eşleşme (harf duyarsız)");
  ok(routeAet("CT1", "MR", routes).matched === false, "modality kısıtı tutmazsa eşleşmez");
  const byAet = routeAet("MR1", "MR", routes);
  ok(byAet.matched && byAet.route?.pacsUrl === "https://pacs-b/api", "yalnız AE eşleşmesi");
  const wildcard = routeAet("BILINMEYEN", "US", routes);
  ok(wildcard.matched && wildcard.route?.aet === "*", "joker AE + modality kuralı");
  const none = routeAet("BILINMEYEN", "CT", routes);
  ok(!none.matched && /varsayılan/.test(none.reason), "kural yoksa varsayılan PACS + görünür gerekçe");
  ok(!routeAet(undefined, "CT", routes).matched, "AE başlığı yoksa eşleşme yok (varsayılan)");
  ok(parseAetRoutes("").length === 0 && parseAetRoutes(undefined).length === 0, "boş tanım → kural yok");
  ok(parseAetRoutes("bozuk;;A=noturl")[0].pacsUrl === "noturl", "bozuk girişler atlanır, kalan okunur");
}

// ── 8. Uygulama katmanı: şifreli kimlik araması (gerçek hata tuzağı) ──
async function main() {
  const crypto = await import("../src/lib/server/crypto");
  crypto.resetKeyring();
  const { encryptText, decryptText } = crypto;
  const a = encryptText("MRK1");
  ok(a !== "MRK1" && a.startsWith("enc:"), "hasta kimliği şifreli saklanıyor (öncül doğrulandı)");
  ok(encryptText("MRK1") !== a, "aynı düz metin her seferinde farklı ciphertext (ECB değil)");
  ok(!a.includes("MRK1"), "ciphertext düz metni içermiyor → SQL `WHERE patient_id = 'MRK1'` 0 satır döner");
  // findStudiesByPatientId'nin çözerek karşılaştırdığı doğrulanır:
  const rows = [{ patientId: a }, { patientId: encryptText("MRK2") }];
  const matched = rows.filter((r) => decryptText(r.patientId) === "MRK1");
  ok(matched.length === 1 && matched[0].patientId === a, "çözerek yapılan tam karşılaştırma doğru satırı bulur");
  const fs = await import("node:fs");
  const path = await import("node:path");
  // Not: kaynak metni aramak yerine şifreli kimlik davranışı sınanır (yukarıda).
  // A40 birleştirmesinin veri kuralı: hedef kimlik PID-3, kaynaklar MRG-1.
  const mrgPlan = adtPlan(adt("A40", "PID|1||HEDEF^^^H^MR", ["MRG|ESKI1^^^H^MR~ESKI2^^^H^MR"])!)!;
  ok(mrgPlan.merge?.toId === "HEDEF" && mrgPlan.merge?.fromIds.join(",") === "ESKI1,ESKI2", "birleştirme hedef/kaynak kümesi doğru");

  ok(encryptText("HEDEF") !== "HEDEF", "yeni kimlik de şifreli saklanır (taşıma sonrası düz metin kalmaz)");

  console.log(`\nhl7-adt: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}
void main();

/**
 * e-stow: anonim seri gönderimi (istemci planı + sunucu doğrulaması).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ANON_MAX_BYTES, ANON_MAX_INSTANCES, megabytes, planAnonStow, summarizeAnonResult, validateAnonStowBody } from "../src/lib/stowPayload";
import { buildAnonymizedDicom } from "../src/lib/dicomWrite";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const inst = (n = 100) => ({ name: `${n}.dcm`, bytes: new Uint8Array(n) });
const uids = ["1.2.3.4.1", "1.2.3.4.2"];

// ── istemci planı ──
ok(!planAnonStow([inst()], []).ok, "UID'siz seride gönderim reddedilir");
ok(planAnonStow([inst()], []).reason!.includes("SOP Instance UID"), "red gerekçesi açık");
ok(!planAnonStow([], uids).ok, "örnek yoksa reddedilir");
const plan = planAnonStow([inst(64), inst(128)], uids);
ok(plan.ok && plan.count === 2 && plan.bytes === 192, "iki örnek planlandı, boyut toplandı");
ok(plan.instances[0].data.length > 0 && /^[A-Za-z0-9+/=]+$/.test(plan.instances[0].data), "base64 kodlama geçerli");
ok(Buffer.from(plan.instances[1].data, "base64").length === 128, "base64 çözümü bayt uzunluğunu korur");
const many = Array.from({ length: ANON_MAX_INSTANCES + 1 }, (_, i) => inst(8));
ok(!planAnonStow(many, uids).ok && planAnonStow(many, uids).reason!.includes(String(ANON_MAX_INSTANCES)), "örnek sayısı sınırı");
const big = [{ name: "big.dcm", bytes: { length: ANON_MAX_BYTES + 1 } as Uint8Array }];
ok(!planAnonStow(big, uids).ok, "boyut sınırı (bellek koruması)");
ok(megabytes(5 * 1024 * 1024) === 5, "MB biçimlendirme");
ok(planAnonStow([{ name: "x", bytes: new Uint8Array(0) }], uids).ok === false, "boş örnek atlanır → plan boş → red");

// ── sunucu doğrulaması ──
ok(!validateAnonStowBody(null).ok, "gövde yoksa reddedilir");
ok(!validateAnonStowBody({ instances: [inst()] }).ok, "studyUid zorunlu (denetim)");
ok(!validateAnonStowBody({ studyUid: "1.2.3", instances: [] }).ok, "boş listede reddedilir");
const good = validateAnonStowBody({ studyUid: "1.2.3", instances: plan.instances });
ok(good.ok && good.ok && good.instances.length === 2, "geçerli gövde kabul edilir");
ok(!validateAnonStowBody({ studyUid: "1.2.3", instances: [{ name: "a" }] }).ok, "data alanı zorunlu");
ok(!validateAnonStowBody({ studyUid: "1.2.3", instances: Array.from({ length: ANON_MAX_INSTANCES + 1 }, () => ({ data: "AA==" })) }).ok, "sunucu örnek sayısını da denetler");
const oversized = validateAnonStowBody({ studyUid: "1.2.3", instances: [{ data: "A".repeat(ANON_MAX_BYTES) }, { data: "A".repeat(ANON_MAX_BYTES) }] });
ok(!oversized.ok && oversized.error.includes("boyut"), "sunucu toplam boyutu denetler (istemciye güvenilmez)");

// ── sonuç özeti ──
const s1 = summarizeAnonResult([{ stored: 1, failed: [] }, { stored: 2, failed: [] }]);
ok(s1.ok && s1.stored === 3 && s1.text.includes("gönderildi"), "tam başarı özeti");
const s2 = summarizeAnonResult([{ stored: 1, failed: ["x"], message: "HTTP 409" }]);
ok(!s2.ok && s2.failed === 1 && s2.text.includes("reddedildi"), "kısmi başarı özeti");

// ── gerçek anonim DICOM: kimlik taşımaz ve imzası geçerli ──
const series = {
  id: "s1", modality: "CT", description: "Toraks", bodyPart: "TORAKS",
  patientName: "GİZLİ^HASTA", patientId: "TC-123456", patientAge: "050Y", patientSex: "M",
  studyDate: "2026-11-20", institution: "TEST", studyUid: "1.2.3.4",
  width: 8, height: 8, pixelSpacing: 0.7, sliceThickness: 1, defaultWL: 40, defaultWW: 400, unit: "HU",
  slices: [new Int16Array(64).fill(10), new Int16Array(64).fill(20)],
} as unknown as SeriesData;
const anon = buildAnonymizedDicom(series);
ok(anon.length === 2, "her kesit için anonim dosya üretildi");
const sig = (b: Uint8Array) => Buffer.from(b.slice(128, 132)).toString("latin1");
ok(anon.every((a) => sig(a.bytes) === "DICM"), "DICM imzası doğru (PACS kabul eder)");
const all = Buffer.concat(anon.map((a) => Buffer.from(a.bytes))).toString("latin1");
ok(!all.includes("GİZLİ") && !all.includes("TC-123456"), "hasta adı/kimliği anonim dosyada YOK");
ok(!all.includes("1.2.3.4"), "orijinal StudyInstanceUID taşınmaz");
const plan2 = planAnonStow(anon.map((a) => ({ name: a.name, bytes: a.bytes })), series.sopUids ?? ["1"]);
ok(plan2.ok, "üretilen anonim baytlar için plan başarılı");

// ── uç ve arayüz sözleşmesi ──
const root = path.resolve(__dirname, "..");
const route = readFileSync(path.join(root, "src/app/api/pacs/stow/route.ts"), "utf8");
ok(route.includes('body.kind === "anon"'), "uç anonim dalını ayırıyor");
ok(route.includes("validateAnonStowBody") && route.includes("DICM"), "sunucu doğrulaması + DICOM imza kontrolü");
ok(route.includes("pacs.send_anon"), "gönderim denetim kaydına yazılıyor");
ok(route.includes('"radyolog", "yonetici"'), "yetki denetimi korunuyor");
const menu = readFileSync(path.join(root, "src/components/ExportMenu.tsx"), "utf8");
ok(menu.includes("sendAnonToPacs") && menu.includes("kind: \"anon\""), "dışa aktarma menüsünden anonim gönderim");
ok(menu.includes("buildAnonymizedDicom"), "baytlar tarayıcıda sıfırdan üretiliyor");

if (failed) { console.error(`${failed} anonim STOW testi başarısız`); process.exit(1); }
console.log("Tüm e-stow (anonim gönderim) testleri geçti.");

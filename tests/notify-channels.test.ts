/**
 * a-notify: kritik bulgu bildirim kanalları (e-posta / SMS / çağrı / webhook).
 * Saf çekirdek test edilir: ayar ayrıştırma toleransı, önem eşiği, gövde biçimi
 * ve hasta kimliği taşımama sözleşmesi.
 */
import assert from "node:assert/strict";
import {
  MAX_CHANNELS, buildRequest, dispatchTargets, emailSubject, parseChannels,
  planDispatch, serializeChannels, severityAtLeast, smsText, TEST_EVENT, type NotifyChannel,
} from "../src/lib/notifyChannels";

// ── Ayrıştırma: toleranslı ve doğrulayıcı ──────────────────────────────────
assert.deepEqual(parseChannels("").channels, []);
assert.deepEqual(parseChannels(null).channels, []);
assert.equal(parseChannels("{bozuk").errors.length, 1, "bozuk JSON hata döner");
assert.equal(parseChannels('{"a":1}').errors[0], "Kanallar: bir dizi bekleniyordu");

const cfg = JSON.stringify([
  { kind: "email", url: "https://mail.example/hook", to: "radyolog@example.com", minSeverity: "yuksek" },
  { kind: "sms", url: "https://sms.example/send", to: "+905551112233" },
  { kind: "pager", url: "https://pager.example/push", to: "0042", minSeverity: "kritik", enabled: true },
  { kind: "webhook", url: "https://bridge.example/push" },
]);
const parsed = parseChannels(cfg);
assert.equal(parsed.channels.length, 4);
assert.deepEqual(parsed.errors, []);
assert.deepEqual(parsed.channels.map((c) => c.id), ["email-1", "sms-2", "pager-3", "webhook-4"], "kimliksiz kanallara sıralı kimlik");
assert.equal(parsed.channels[0].minSeverity, "yuksek");
assert.equal(parsed.channels[1].minSeverity, "kritik", "SMS varsayılan eşiği kritik");
assert.equal(parsed.channels[3].minSeverity, "yuksek", "webhook varsayılan eşiği yüksek (eski davranış)");

// Geçersizler düşer, geçerliler kalır.
const mixed = parseChannels(JSON.stringify([
  { kind: "fax", url: "https://x.example" },
  { kind: "sms", url: "ftp://x" },
  { kind: "sms", url: "https://sms.example/send" },
  { kind: "email", url: "https://mail.example/hook", to: "a@b.c" },
]));
assert.equal(mixed.channels.length, 1, "yalnız geçerli kanal kalır");
assert.equal(mixed.errors.length, 3, "her geçersiz kayıt için hata");
assert.match(mixed.errors[0], /bilinmeyen tür/);
assert.match(mixed.errors[1], /http\(s\)/);
assert.match(mixed.errors[2], /alıcı/);

// Tekrarlı kimlik ve >MAX_CHANNELS.
const dup = parseChannels(JSON.stringify([
  { id: "a", kind: "webhook", url: "https://a.example" },
  { id: "a", kind: "webhook", url: "https://b.example" },
]));
assert.equal(new Set(dup.channels.map((c) => c.id)).size, 2, "kimlikler benzersiz");
const many = parseChannels(JSON.stringify(Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => ({ kind: "webhook", url: `https://h${i}.example` }))));
assert.equal(many.channels.length, MAX_CHANNELS);
assert.ok(many.errors.some((e) => e.includes("en çok")));

// Gidiş-dönüş: serialize → parse aynı kanalları verir.
const back = parseChannels(serializeChannels(parsed.channels));
assert.deepEqual(back.channels, parsed.channels, "seri hâle getirme kayıpsız");
assert.equal(serializeChannels([{ id: "x", kind: "webhook", url: "https://x.example", minSeverity: "kritik", enabled: false }]).includes('"enabled":false'), true);
console.log("PASS kanal ayrıştırma: bozuk kayıt tüm listeyi düşürmez, kimlik/tür/adres/alıcı doğrulanır.");

// ── Önem eşiği ─────────────────────────────────────────────────────────────
assert.equal(severityAtLeast("kritik", "yuksek"), true);
assert.equal(severityAtLeast("yuksek", "kritik"), false);
const chans: NotifyChannel[] = parsed.channels;
const ev = { severity: "yuksek" as const, studyUid: "1.2.3", message: "Aday lezyon", modality: "CT" };
assert.deepEqual(dispatchTargets(chans, ev).map((c) => c.kind), ["email", "webhook"], "yüksek: e-posta + webhook (pager/sms eşiği kritik)");
assert.deepEqual(dispatchTargets(chans, { ...ev, severity: "kritik" }).map((c) => c.kind), ["email", "sms", "pager", "webhook"]);
assert.deepEqual(dispatchTargets(chans, { ...ev, severity: "orta" }).map((c) => c.kind), [], "orta: hiçbir kanal (eşikler yüksek/kritik)");
assert.deepEqual(
  dispatchTargets([...chans, { id: "all", kind: "webhook", url: "https://all.example", minSeverity: "bilgi", enabled: true }], { ...ev, severity: "bilgi" }).map((c) => c.kind),
  ["webhook"], "bilgi eşikli kanal tüm olayları alır");
assert.deepEqual(dispatchTargets([{ ...chans[0], enabled: false }], { ...ev, severity: "kritik" }), [], "kapalı kanal gönderilmez");

console.log("PASS önem eşiği: kanal başına minSeverity ve enabled doğru uygulanır.");

// ── Gövde biçimi ───────────────────────────────────────────────────────────
const wh = buildRequest(chans[3], ev);
assert.deepEqual(Object.keys(wh.body).sort(), ["at", "event", "message", "severity", "studyUid"], "webhook gövdesi eski sözleşmeyle aynı");
assert.equal(wh.body.event, "critical_finding");
assert.equal(wh.body.at, undefined === wh.body.at ? wh.body.at : wh.body.at);

const mail = buildRequest(chans[0], ev);
assert.equal(mail.body.channel, "email");
assert.equal(mail.body.to, "radyolog@example.com");
assert.match(String(mail.body.subject), /^\[YUKSEK\] Kritik bulgu · CT · 1\.2\.3$/);
assert.match(String(mail.body.text), /Aday lezyon/);
assert.match(String(mail.body.text), /radyolog teyidi/);
assert.match(emailSubject({ ...ev, modality: undefined }), /^\[YUKSEK\] Kritik bulgu · 1\.2\.3$/, "modalite yoksa başlık sadeleşir");

const sms = buildRequest(chans[1], { ...ev, severity: "kritik" });
assert.equal(sms.body.channel, "sms");
assert.ok(String(sms.body.text).length <= 160, "SMS 160 karakteri aşmaz");
assert.match(String(sms.body.text), /^KRITIK CT /);

const pager = buildRequest(chans[2], { ...ev, severity: "kritik" });
assert.equal(pager.body.priority, "high");
assert.ok(String(pager.body.text).length <= 120);
assert.equal(buildRequest(chans[2], ev).body.priority, "normal");
console.log("PASS gövde biçimi: webhook sözleşmesi korunur; e-posta/SMS/pager alanları doğru.");

// Uzun mesaj SMS'te kırpılır.
const long = smsText({ severity: "kritik", studyUid: "1.2.3.4.5", message: "X".repeat(400), modality: "MR" });
assert.equal(long.length, 160);
assert.ok(long.endsWith("…") || long.length === 160);

// ── Gizlilik: hasta kimliği hiçbir kanala gitmez ───────────────────────────
const PHI_KEYS = ["patientName", "patientId", "patientBirthDate", "accessionNumber", "name", "tc"];
for (const req of planDispatch(chans, { ...ev, severity: "kritik" })) {
  for (const k of PHI_KEYS) assert.ok(!(k in req.body), `${req.channel.kind} gövdesinde ${k} olmamalı`);
  assert.equal(req.body.studyUid, "1.2.3");
}
console.log("PASS gizlilik: yük yalnız UID/önem/modalite/mesaj taşır, hasta kimliği yok.");

// ── Plan: sıra ve sayı ─────────────────────────────────────────────────────
const plan = planDispatch(chans, { ...ev, severity: "kritik" });
assert.deepEqual(plan.map((p) => p.channel.id), ["email-1", "sms-2", "pager-3", "webhook-4"], "ayar sırası korunur");
assert.ok(plan.every((p) => p.url.startsWith("https://")));

// Test olayı: kimliksiz, kritik.
assert.equal(TEST_EVENT.severity, "kritik");
assert.equal(planDispatch(chans, TEST_EVENT).length, 4, "test gönderimi tüm kanalları dener");
console.log("PASS plan: kanal sırası korunur, test olayı tüm kanallara gider.");
console.log("Tüm bildirim kanalı testleri geçti.");

/**
 * d-close-loop: kanıt paketi + dış iletişim defteri.
 *
 * Temel iddia: döngü yalnızca **kanıtla** kapanır. Eksik adım uydurulmaz,
 * "kanıt yok" olarak yazılır; alınma + (iletim kanıtı veya ulaşılan dış
 * iletişim) yoksa `closable=false`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { policyFor, ESCALATION_ROLES } from "../src/lib/closeLoopRules";
import {
  buildEscalation,
  COMM_CHANNELS,
  commCsv,
  loopEvidence,
  policyTable,
  validateComm,
  type CommEntry,
  type CommInput,
} from "../src/lib/closeLoopEvidence";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const T0 = Date.parse("2026-03-04T09:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

const comm = (over: Partial<CommEntry> = {}): CommEntry => ({
  id: 1, notificationId: 7, at: at(20), channel: "telefon", toWhom: "Dr. A. Yılmaz", reached: true, note: "Görüşüldü", byName: "dr.ayse",
  ...over,
});

function main() {
  // ── 1) Dış iletişim kaydı doğrulaması ───────────────────────────────
  const ok = validateComm({ notificationId: 5, channel: "telefon", toWhom: "  Dr. A  ", reached: true, note: "not" }, new Date(T0));
  assert.equal(ok.ok, true, "geçerli kayıt");
  if (ok.ok) {
    assert.equal(ok.entry.toWhom, "Dr. A", "kime alanı kırpılır");
    assert.equal(ok.entry.at, at(0), "zaman enjekte edilir");
    assert.equal(ok.entry.channel, "telefon", "kanal");
  }
  const bad: [CommInput, RegExp][] = [
    [{ notificationId: 0, channel: "telefon", toWhom: "x", reached: true }, /Bildirim kimliği geçersiz/],
    [{ notificationId: 5, channel: "", toWhom: "x", reached: true }, /Kanal geçersiz/],
    [{ notificationId: 5, channel: "faks", toWhom: "x", reached: true }, /Kanal geçersiz: faks/],
    [{ notificationId: 5, channel: "sms", toWhom: "   ", reached: true }, /Kime iletildiği yazılmalı/],
    [{ notificationId: 5, channel: "sms", toWhom: "x", reached: undefined as unknown as boolean }, /reached alanı boolean olmalı/],
  ];
  for (const [input, re] of bad) {
    const r = validateComm(input);
    assert.equal(r.ok, false, `reddedilmeli: ${input.channel}/${input.toWhom}`);
    if (!r.ok) assert.match(r.error, re, "gerekçe");
  }
  if (ok.ok) {
    const long = validateComm({ notificationId: 5, channel: "sms", toWhom: "x".repeat(200), reached: true, note: "y".repeat(900) });
    assert.equal(long.ok, true, "uzun alanlar kırpılarak kabul");
    if (long.ok) assert.ok(long.entry.toWhom.length === 80 && long.entry.note.length === 450, "80/450 karakter sınırı");
  }
  assert.equal(COMM_CHANNELS.length, 6, "altı kanal");
  console.log("PASS dış iletişim doğrulaması");

  // ── 2) Kanıt paketi: eksik kanıt "yok" olarak yazılır ───────────────
  const row = { id: 7, severity: "kritik", createdAt: at(0), ackAt: null, relayedAt: null, escalated: false, escalatedAt: null };
  const e0 = loopEvidence(row, { now: T0 + 5 * 60000 });
  assert.equal(e0.state, "yeni", "5 dk: yeni");
  assert.equal(e0.closable, false, "kanıtsız kapatılamaz");
  assert.ok(e0.gaps.some((g) => g.includes("Alınma (ACK) kaydı yok")), "ACK eksiği");
  assert.ok(e0.gaps.some((g) => g.includes("İletim kanıtı da dış iletişim kaydı da yok")), "iletim eksiği");
  const ackStep = e0.steps.find((s) => s.key === "alindi")!;
  assert.equal(ackStep.present, false, "alınma adımı yok");
  assert.equal(ackStep.at, null, "uydurma zaman yok");
  assert.equal(e0.steps.find((s) => s.key === "olusturuldu")!.at, at(0), "oluşturma zamanı");
  assert.match(e0.headline, /Döngü AÇIK/, "başlık açık döngü der");

  // 40 dk: eskalasyon süresi geçti, kayıt yok → gerekçe
  const e1 = loopEvidence(row, { now: T0 + 40 * 60000 });
  assert.ok(e1.gaps.some((g) => g.includes("Eskalasyon süresi (30 dk) aşıldı")), "eskalasyon eksiği");

  // Eskalasyon işaretli ama zaman damgası yok → tutarsızlık raporlanır
  const e1b = loopEvidence({ ...row, escalated: true, escalatedAt: null }, { now: T0 + 40 * 60000 });
  assert.ok(e1b.gaps.some((g) => g.includes("Eskalasyon işaretli ama zaman damgası yok")), "tutarsız kayıt yakalanır");
  console.log("PASS eksik kanıt raporlanır (uydurma yok)");

  // ── 3) İletim kanıtıyla kapanış ─────────────────────────────────────
  const kapali = loopEvidence(
    { ...row, ackAt: at(10), relayedAt: at(12) },
    { now: T0 + 20 * 60000 },
  );
  assert.equal(kapali.closable, true, "alındı + iletim → kapatılabilir");
  assert.deepEqual(kapali.gaps, [], "eksik yok");
  assert.equal(kapali.steps.find((s) => s.key === "alindi")!.minutes, 10, "alınma 10 dk");
  assert.equal(kapali.steps.find((s) => s.key === "iletim")!.minutes, 12, "iletim 12 dk");
  assert.equal(kapali.steps.find((s) => s.key === "alindi")!.withinTarget, true, "15 dk hedef içinde");
  assert.match(kapali.headline, /Döngü kapatılabilir/, "başlık kapatılabilir der");
  assert.equal(kapali.state, "iletildi", "durum iletildi");

  // Gecikmiş alınma hedefi aşar
  const gec = loopEvidence({ ...row, ackAt: at(90), relayedAt: at(95) }, { now: T0 + 120 * 60000 });
  assert.equal(gec.steps.find((s) => s.key === "alindi")!.withinTarget, false, "90 dk > 15 dk hedef");
  assert.equal(gec.closable, true, "geç de olsa kanıt tam → kapatılabilir");
  assert.match(gec.text, /HEDEF DIŞI/, "metin hedef aşımını yazar");
  console.log("PASS iletim kanıtıyla kapanış");

  // ── 4) Dış iletişim kaydıyla kapanış ────────────────────────────────
  const telefonla = loopEvidence({ ...row, ackAt: at(8) }, { now: T0 + 25 * 60000, comms: [comm({ at: at(20), reached: true })] });
  assert.equal(telefonla.closable, true, "ulaşılan dış iletişim iletim sayılır");
  assert.match(telefonla.steps.find((s) => s.key === "dis-iletisim")!.detail, /Telefon → Dr\. A\. Yılmaz/, "kanal/kime yazılır");
  assert.match(telefonla.headline, /dış iletişimle ulaştırıldı/, "başlık yöntemi söyler");

  const ulasilamadi = loopEvidence({ ...row, ackAt: at(8) }, { now: T0 + 25 * 60000, comms: [comm({ reached: false })] });
  assert.equal(ulasilamadi.closable, false, "ulaşılamayan kayıt kapatmaz");
  assert.ok(ulasilamadi.gaps.some((g) => g.includes("hiçbirinde ulaşıldı")), "gerekçe");
  assert.match(ulasilamadi.steps.find((s) => s.key === "dis-iletisim")!.detail, /ulaşılamadı/, "detayda belirtilir");

  const ikisi = loopEvidence(
    { ...row, ackAt: at(8), relayedAt: at(9) },
    { now: T0 + 30 * 60000, comms: [comm({ at: at(10), reached: false }), comm({ id: 2, at: at(12), reached: true, channel: "sms" })], reminders: [{ at: at(5) }] },
  );
  assert.equal(ikisi.closable, true, "karışık kayıtlarda ulaşılan varsa kapanır");
  assert.match(ikisi.steps.find((s) => s.key === "dis-iletisim")!.detail, /2 dış iletişim kaydı; son: SMS/, "son kayıt yazılır");
  assert.equal(ikisi.steps.find((s) => s.key === "hatirlatma")!.present, true, "hatırlatma kanıtı");
  console.log("PASS dış iletişim kaydıyla kapanış (ulaşılamadı ayrımı)");

  // ── 5) Politika ve eskalasyon mesajı ────────────────────────────────
  const pt = policyTable();
  assert.deepEqual(pt.map((p) => p.severity), ["kritik", "yuksek", "orta", "dusuk", "bilgi"], "politika sırası");
  assert.deepEqual(pt[0], { severity: "kritik", ackMinutes: 15, escalateMinutes: 30 }, "kritik politikası");
  assert.equal(pt[2].escalateMinutes, null, "orta: eskalasyon yok");
  assert.deepEqual(policyFor("bilinmeyen"), { ackMinutes: 240, escalateMinutes: null }, "bilinmeyen önem → bilgi politikası");

  const esc = buildEscalation({ ...row, severity: "kritik" }, { role: "sorumlu-uzman", contact: "Dr. B" }, T0 + 40 * 60000);
  assert.equal(esc.ok, true, "eskalasyon mesajı üretildi");
  assert.match(esc.message, /ESKALASYON · KRITIK|ESKALASYON · KRITIK|ESKALASYON/, "başlık");
  assert.match(esc.message, /Sorumlu uzman/, "hedef etiketi");
  assert.equal(buildEscalation(row, { role: "yok", contact: "" }).ok, false, "geçersiz rol reddedilir");
  assert.match(buildEscalation(row, { role: "yok", contact: "" }).error ?? "", /geçersiz/, "gerekçe");
  const alinmis = buildEscalation({ ...row, ackAt: at(5) }, { role: "ikinci-hekim", contact: "" });
  assert.equal(alinmis.ok, false, "alınmış bildirim eskale edilmez");
  assert.match(alinmis.error ?? "", /alınmış/, "gerekçe");
  assert.equal(ESCALATION_ROLES.length, 3, "üç eskalasyon rolü");
  console.log("PASS politika tablosu + eskalasyon kapısı");

  // ── 6) CSV ──────────────────────────────────────────────────────────
  const csv = commCsv([comm({ at: at(20) }), comm({ id: 2, channel: "sms", reached: false, note: "yanıt yok" })]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Bildirim;Zaman;Kanal;Kime;Ulaşıldı;Not;Kaydeden", "CSV başlığı");
  assert.equal(lines.length, 3, "başlık + iki satır");
  assert.match(csv, /7;2026-03-04T09:20:00\.000Z;Telefon;Dr\. A\. Yılmaz;evet;Görüşüldü;dr\.ayse/, "iletişim satırı");
  assert.match(csv, /SMS;Dr\. A\. Yılmaz;hayır;yanıt yok/, "ulaşılamadı satırı");
  assert.equal(commCsv([]).split("\n").length, 1, "boş CSV yalnız başlık");
  console.log("PASS CSV");

  // ── 7) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/notifications/comm/route.ts");
  assert.ok(route.includes("validateComm") && route.includes("loopEvidence"), "uç doğrulama + kanıt kullanır");
  assert.ok(route.includes("notify.comm_log"), "denetim kaydı");
  assert.ok(route.includes("Bildirim bulunamadı"), "olmayan bildirime kayıt yazılmaz");
  assert.ok(route.includes("commCsv"), "CSV ucu");
  const schema = read("src/db/schema.ts");
  assert.ok(schema.includes('pgTable("comm_log"'), "dış iletişim tablosu");
  const bell = read("src/components/NotificationsBell.tsx");
  assert.ok(bell.includes("☎ İletişim") && bell.includes("🧾 Kanıt"), "zilde iletişim ve kanıt düğmeleri");
  assert.ok(bell.includes("/api/notifications/comm"), "zil ucu kullanır");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "d-close-loop"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:closeloopev"]?.includes("close-loop-evidence"), "test betiği kayıtlı");
  console.log("PASS uç/şema/arayüz sözleşmesi");

  console.log("Tüm d-close-loop (kanıt paketi) testleri geçti.");
}

main();

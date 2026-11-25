/**
 * d-close-loop: süre eşikleri, eskalasyon ve hatırlatma kuralları.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ESCALATION_ROLES, escalationMessage, loopAuditDetails, loopStatus, policyFor, shouldRemind } from "../src/lib/closeLoopRules";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const T0 = new Date("2026-11-23T08:00:00.000Z").getTime();
const min = (n: number) => T0 + n * 60000;
const row = (over: Partial<Parameters<typeof loopStatus>[0]> = {}) =>
  ({ id: 1, severity: "kritik", createdAt: new Date(T0), ...over });

// ── politika ──
ok(policyFor("kritik").ackMinutes === 15 && policyFor("kritik").escalateMinutes === 30, "kritik: 15 dk ack / 30 dk eskalasyon");
ok(policyFor("yuksek").ackMinutes === 60 && policyFor("yuksek").escalateMinutes === 120, "yüksek: 60/120 dk");
ok(policyFor("bilgi").escalateMinutes === null, "bilgi düzeyinde eskalasyon yok");
ok(policyFor("bilinmeyen").ackMinutes === 240, "bilinmeyen önem derecesi güvenli varsayılana düşer");

// ── durum geçişleri ──
const yeni = loopStatus(row(), min(5));
ok(yeni.state === "yeni" && yeni.dueInMinutes === 10 && !yeni.remind, "5 dk: yeni, hatırlatma yok, kalan 10 dk");
const gec = loopStatus(row(), min(20));
ok(gec.state === "gecikmis" && gec.remind, "20 dk: gecikmiş + hatırlatma");
const esk = loopStatus(row(), min(31));
ok(esk.state === "eskalasyon-gerekli" && esk.label.includes("ESKALASYON") === false && esk.remind, "31 dk: eskalasyon gerekli");
const yuksek = loopStatus(row({ severity: "yuksek" }), min(31));
ok(yuksek.state === "yeni", "yüksek önemde 31 dk hâlâ normal");
const esk2 = loopStatus(row({ severity: "yuksek" }), min(121));
ok(esk2.state === "eskalasyon-gerekli", "yüksek önemde 121 dk eskalasyon");

// ── alındı / iletim kanıtı ──
const alinmis = loopStatus(row({ ackAt: new Date(min(10)) }), min(400));
ok(alinmis.state === "alinmis" && !alinmis.remind, "alındı → hatırlatma kesilir");
ok(alinmis.label.includes("iletim kanıtı yok"), "iletim kanıtı yokluğu görünür");
const iletildi = loopStatus(row({ ackAt: new Date(min(10)), relayedAt: new Date(min(11)) }), min(400));
ok(iletildi.state === "iletildi", "alındı + iletildi → döngü kapandı");
const eskale = loopStatus(row({ escalated: true, escalatedAt: new Date(min(31)) }), min(45));
ok(eskale.state === "eskale-edildi" && eskale.remind, "eskale edildi ama alınmadı → hatırlatmaya devam");

// ── sınırlar ve bozuk veri ──
ok(loopStatus(row(), min(15)).state === "gecikmis", "tam 15 dk sınırda gecikmiş sayılır");
ok(loopStatus(row(), min(30)).state === "eskalasyon-gerekli", "tam 30 dk sınırda eskalasyon");
ok(loopStatus(row({ createdAt: "bozuk" }), min(5)).ageMinutes === 0, "bozuk tarih → güvenli (0 dk)");
const future = loopStatus(row(), T0 - 60000);
ok(future.ageMinutes === 0, "gelecek tarih negatif yaş üretmez");

// ── hatırlatma sıklığı ──
ok(shouldRemind(row(), gec, null, min(20)), "ilk hatırlatma hemen");
ok(!shouldRemind(row(), gec, new Date(min(10)), min(20)), "10 dk önce hatırlatıldıysa tekrar edilmez");
ok(shouldRemind(row(), gec, new Date(min(1)), min(20)), "15 dk sonra yeniden hatırlatma");
ok(!shouldRemind(row(), yeni, null, min(5)), "hatırlatma gerekmeyen satırda üretim yok");

// ── mesaj ve denetim ──
const target = { role: "ikinci-hekim", contact: "Dr. A. Yılmaz" };
const msg = escalationMessage(row(), esk, target);
ok(msg.includes("#1") && msg.includes("31 dk") && msg.includes("İkinci hekim") && msg.includes("Dr. A. Yılmaz"), "eskalasyon mesajı kim/süre/hedef içerir");
ok(msg.includes("alınmadı"), "mesaj eylem ister");
const aud = loopAuditDetails(row(), esk);
ok(aud.state === "eskalasyon-gerekli" && aud.escalateMinutesPolicy === 30 && aud.relayed === false, "denetim özeti SIEM için sayısal alanlar taşır");
ok(ESCALATION_ROLES.length === 3 && ESCALATION_ROLES.some((r) => r.id === "kurum-nobet"), "eskalasyon rolleri tanımlı (kurum nöbeti dahil)");

// ── entegrasyon: sunucu ucu ve zil ──
const root = path.resolve(__dirname, "..");
const srv = readFileSync(path.join(root, "src/lib/server/closeLoop.ts"), "utf8");
ok(srv.includes("sweepCloseLoop") && srv.includes("notify.escalate"), "sunucu taraması eskalasyonu denetim kaydına yazıyor");
ok(srv.includes("relayedTo: `eskalasyon:"), "eskalasyon hedefi iletilen kanıtı olarak yazılıyor");
const api = readFileSync(path.join(root, "src/app/api/notifications/route.ts"), "utf8");
ok(api.includes('b.action === "sweep"') && api.includes("notify.sweep"), "toplu tarama ucu var ve denetime yazıyor");
ok(api.includes('sp.get("escalation")'), "gecikmiş bildirimler listelenebiliyor");
ok(api.includes("loopState"), "satırlarda süre durumu dönüyor");
const bell = readFileSync(path.join(root, "src/components/NotificationsBell.tsx"), "utf8");
ok(bell.includes("Süre taraması") && bell.includes("sweep"), "bildirim zilinde tarama düğmesi");
ok(bell.includes("loopLabel") && bell.includes("eskalasyon:"), "süre etiketi ve hedef seçimi arayüzde");

if (failed) { console.error(`${failed} kapanış döngüsü testi başarısız`); process.exit(1); }
console.log("Tüm d-close-loop (süre + eskalasyon) testleri geçti.");

/**
 * Masaüstü bildirimi köprüsü (a-notify) testleri.
 * Notification API tarayıcıda olduğundan burada küreselini taklit ederek
 * davranışı (izin yoksa sessiz geçiş, etiket, tek tekçil gönderim) doğrularız.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

type PermissionState = "granted" | "denied" | "default";
const sent: { title: string; opts?: NotificationOptions }[] = [];
const g = globalThis as Record<string, unknown>;

function mockNotification(permission: PermissionState) {
  sent.length = 0;
  g.Notification = class {
    static permission: PermissionState = permission;
    static requestPermission = async () => permission;
    constructor(title: string, opts?: NotificationOptions) {
      sent.push({ title, opts });
      void title; void opts;
    }
  };
}
function unmock() { delete g.Notification; }

async function main() {
const { notificationsSupported, notifyPermission, requestNotifyPermission, sendLocalNotification, notifyCriticalFinding } = await import("../src/lib/notify");

// ── destek yok ──
unmock();
ok(notificationsSupported() === false, "Notification yokken destek false");
ok(notifyPermission() === "desteklenmiyor", "izin durumu desteklenmiyor");
ok((await requestNotifyPermission()) === "desteklenmiyor", "izin istemi sessiz döner");
ok(sendLocalNotification({ title: "x" }) === false, "destek yokken gönderim false");
ok((await notifyCriticalFinding({ label: "Kütle" })) === false, "kritik bildirim desteksizde false");

// ── izin verildi ──
mockNotification("granted");
ok(notificationsSupported(), "Notification var");
ok(notifyPermission() === "granted", "izin granted");
ok(sendLocalNotification({ title: "T1", body: "B1", tag: "t1" }), "gönderim true");
ok(sent.length === 1 && sent[0].title === "T1" && sent[0].opts?.body === "B1", "başlık/gövde iletiliyor");
ok(sent[0].opts?.tag === "t1", "etiket korunuyor (üst üste yığılma önlenir)");
ok(await notifyCriticalFinding({ label: "Pnomoni adayı", location: "Toraks" }), "kritik bildirimi true");
ok(sent.length === 2 && sent[1].title.includes("Pnomoni"), "kritik bulgu başlığı taşıyor");
ok(sent[1].opts?.body?.includes("Toraks") ?? false, "konum gövdede");

// ── izin reddedildi ──
mockNotification("denied");
ok(sendLocalNotification({ title: "T" }) === false, "reddedildi ise gönderim olmaz");
ok((await notifyCriticalFinding({ label: "X" })) === false, "reddedildi ise kritik bildirim de olmaz");
ok(sent.length === 0, "hiçbir bildirim eklenmedi");

// ── default: izin istenir; sonuca göre ──
mockNotification("granted"); // requestPermission granted'a çevirecek şekilde ayarlanmadıysa sabit kalır
// basitlik: default durumda requestPermission çağrıldığını ve granted dönerse gönderildiğini kontrol et
sent.length = 0;
g.Notification = class {
  static permission: PermissionState = "default";
  static requestPermission = async () => { (this as unknown as { permission: PermissionState }).permission = "granted"; return "granted"; };
  constructor(title: string, opts?: NotificationOptions) { sent.push({ title, opts }); }
};
ok((await notifyCriticalFinding({ label: "Atelektazi adayı" })) === true, "default→granted akışında bildirim gidiyor");
ok(sent.length === 1, "tek bildirim üretildi (yığılma yok)");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const ws = readFileSync(path.join(root, "src/components/Workstation.tsx"), "utf8");
ok(ws.includes('from "@/lib/notify"') && ws.includes("notifyCriticalFinding"), "analiz sonunda masaüstü bildirimi çağrılıyor");
const gap = readFileSync(path.join(root, "src/lib/gapAnalysis.ts"), "utf8");
ok(gap.includes('"a-notify"'), "dağılım tablosunda kayıtlı");

if (failed) { console.error(`${failed} bildirim testi başarısız`); process.exit(1); }
console.log("Tüm bildirim (a-notify) testleri geçti.");

}
main().catch((e) => { console.error(e); process.exit(1); });

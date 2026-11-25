/**
 * a-notify: çok kanallı kritik bulgu bildirimi testleri.
 *
 * Kanal zinciri (önem düzeyine göre), geçici/kalıcı hata ayrımı ve geri
 * çekilmeli yeniden deneme, zaman aşımı, idempotency ve hiçbir kanal
 * yapılandırılmadığında dürüst mesaj sınanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ATTEMPT_TIMEOUT_MS,
  channelStatus,
  channelsFor,
  channelsFromEnv,
  deliverCritical,
  idempotencyKey,
  MAX_ATTEMPTS,
  payloadFor,
  retryable,
  sendToChannel,
  type ChannelConfig,
  type NotificationPayload,
} from "../src/lib/notifyChannels";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const cfg = (kind: ChannelConfig["kind"], url = "https://ornek.test/hook", targets: string[] = []): ChannelConfig => ({
  kind, enabled: true, url, targets,
});

const P: NotificationPayload = {
  event: "critical_finding",
  severity: "kritik",
  studyUid: "1.2.3",
  message: "BT · Beyin: epidural hematom (Kesit 12) — aday bulgu, radyolog teyidi gerekir",
  notificationId: 42,
  at: "2026-03-01T10:00:00.000Z",
};

async function main() {
  // ── 1) Kanal seçimi önem düzeyine göre ──────────────────────────────
  const all = [cfg("sms"), cfg("webhook"), cfg("push"), cfg("email")];
  assert.deepEqual(channelsFor("kritik", all).map((c) => c.kind), ["webhook", "email", "sms", "push"], "kritik → tümü, sabit sıra");
  assert.deepEqual(channelsFor("yuksek", all).map((c) => c.kind), ["webhook", "email", "sms"], "yüksek → push hariç");
  assert.deepEqual(channelsFor("orta", all).map((c) => c.kind), ["webhook", "email"], "orta → webhook + e-posta");
  assert.deepEqual(channelsFor("dusuk", all).map((c) => c.kind), ["webhook", "email"], "düşük → webhook + e-posta");
  const yarim = [{ ...cfg("sms"), enabled: false }, cfg("webhook"), { ...cfg("email"), url: "" }];
  assert.deepEqual(channelsFor("kritik", yarim).map((c) => c.kind), ["webhook"], "etkin olmayan kanallar atlanır");
  assert.deepEqual(channelsFor("kritik", []), [], "kanal yoksa boş");
  console.log("PASS kanal zinciri (önem → kanal kümesi)");

  // ── 2) Ortam yapılandırması ─────────────────────────────────────────
  const env = channelsFromEnv({
    CRITICAL_WEBHOOK_URL: "https://hook.test/x",
    NOTIFY_EMAIL_URL: "https://mail.test/send",
    NOTIFY_EMAIL_TO: "a@x.test, b@x.test",
    NOTIFY_SMS_URL: "https://sms.test/send",
    NOTIFY_SMS_TO: "",
    NOTIFY_PUSH_URL: "https://push.test/send",
    NOTIFY_PUSH_TO: "cihaz-1 cihaz-2",
  });
  const by = (k: string) => env.find((c) => c.kind === k)!;
  assert.equal(by("webhook").enabled, true, "webhook etkin");
  assert.equal(by("email").enabled, true, "e-posta etkin (URL + alıcı)");
  assert.deepEqual(by("email").targets, ["a@x.test", "b@x.test"], "virgülle ayrılmış alıcılar");
  assert.equal(by("sms").enabled, false, "alıcı yoksa SMS kapalı");
  assert.deepEqual(by("push").targets, ["cihaz-1", "cihaz-2"], "boşlukla ayrılmış cihazlar");
  assert.equal(channelsFromEnv({}).every((c) => !c.enabled), true, "boş ortamda hiçbiri etkin değil");
  console.log("PASS ortam yapılandırması (sır koda gömülmez)");

  // ── 3) Gövde biçimleri ──────────────────────────────────────────────
  const mail = payloadFor("email", P) as { subject: string; text: string; channel: string };
  assert.match(mail.subject, /^\[KRİTİK\] Kritik bulgu/, "e-posta konusu önem içerir");
  assert.equal(mail.text, P.message, "e-posta gövdesi mesaj");
  // Test mesajı 160'ı aşmıyor; kırpmayı uzun mesajla sına.
  const uzun = payloadFor("sms", { ...P, message: "Uzun mesaj ".repeat(30) }) as { text: string };
  assert.ok(uzun.text.length <= 160 && uzun.text.length > 150, `SMS 160 karakteri aşmaz (${uzun.text.length})`);
  assert.ok(uzun.text.endsWith("…"), "kırpma işaretlenir");
  const sms = payloadFor("sms", P) as { text: string; sender: string };
  assert.equal(sms.sender, "RADYOLOJI", "gönderen adı (SMS başlığı ASCII — operatör uyumu)");
  const kisa = payloadFor("sms", { ...P, message: "Kısa mesaj" }) as { text: string };
  assert.equal(kisa.text, "Kısa mesaj", "kısa mesaj kırpılmaz");
  const push = payloadFor("push", P) as { title: string; body: string };
  assert.match(push.title, /Kritik bulgu \(KRİTİK\)/, "push başlığı (Türkçe büyük harf)");
  assert.ok(push.body.length <= 200, "push gövdesi kısa");
  const hook = payloadFor("webhook", P) as { event: string; channel: string };
  assert.equal(hook.event, "critical_finding", "webhook olay adı");
  assert.equal(hook.channel, "webhook", "kanal alanı");
  console.log("PASS gövde biçimleri (SMS kırpma, push başlığı)");

  // ── 4) Hata sınıflandırma ve yeniden deneme ─────────────────────────
  const sent: string[] = [];
  const okTransport = async (url: string) => { sent.push(url); return { ok: true, status: 200 }; };
  const r1 = await (sendToChannel(cfg("webhook"), P, { transport: okTransport, sleep: () => Promise.resolve() }));
  assert.equal(r1.status, "gonderildi", "başarılı gönderim");
  assert.equal(r1.httpStatus, 200, "HTTP kodu kaydedilir");
  assert.equal(sent.length, 1, "tek deneme");
  assert.equal(retryable("gecici-hata"), true, "geçici hata yeniden denenir");
  assert.equal(retryable("kalici-hata"), false, "kalıcı hata denenmez");
  assert.equal(r1.channel, "webhook", "kanal etiketi");

  // 4xx → kalıcı, tek deneme
  let calls4 = 0;
  const r4 = await (sendToChannel(cfg("sms"), P, {
    transport: async () => { calls4++; return { ok: false, status: 400 }; },
    sleep: () => Promise.resolve(),
  }));
  assert.equal(r4.status, "kalici-hata", "400 kalıcı hata");
  assert.equal(calls4, 1, "4xx yeniden denenmez");

  // 503 → geçici, MAX_ATTEMPTS kez
  let calls5 = 0;
  const beklemeler: number[] = [];
  const r5 = await (sendToChannel(cfg("email"), P, {
    transport: async () => { calls5++; return { ok: false, status: 503 }; },
    sleep: (ms) => { beklemeler.push(ms); return Promise.resolve(); },
  }));
  assert.equal(r5.status, "gecici-hata", "503 geçici");
  assert.equal(calls5, MAX_ATTEMPTS, `${MAX_ATTEMPTS} deneme yapılır (${calls5})`);
  assert.deepEqual(beklemeler, [200, 800], "geri çekilmeli bekleme (200 → 800 ms)");

  // 5. denemede başarı → gonderildi
  let n = 0;
  const sonunda = await (sendToChannel(cfg("push"), P, {
    transport: async () => { n++; return n < 3 ? { ok: false, status: 502 } : { ok: true, status: 200 }; },
    sleep: () => Promise.resolve(),
  }));
  assert.equal(sonunda.status, "gonderildi", "gecici hata sonrası başarı");
  assert.equal(n, 3, "üçüncü denemede iletildi");

  // Ağ hatası → geçici
  const ag = await (sendToChannel(cfg("webhook"), P, {
    transport: async () => { throw new Error("ECONNREFUSED"); },
    sleep: () => Promise.resolve(),
  }));
  assert.equal(ag.status, "gecici-hata", "ağ hatası geçici sayılır");
  assert.match(ag.error ?? "", /ECONNREFUSED/, "hata metni saklanır");

  // Zaman aşımı → geçici + okunur metin
  const zaman = await (sendToChannel(cfg("webhook"), P, {
    transport: async () => { throw new Error("The operation was aborted due to timeout"); },
    sleep: () => Promise.resolve(),
  }));
  assert.equal(zaman.status, "gecici-hata", "zaman aşımı geçici");
  assert.equal(zaman.error, "zaman aşımı", "okunur hata metni");

  // Devre dışı kanal hiç denenmez
  let hic = 0;
  const kapali = await (sendToChannel({ ...cfg("sms"), enabled: false }, P, { transport: async () => { hic++; return { ok: true, status: 200 }; } }));
  assert.equal(kapali.status, "atlandi", "kapalı kanal atlanır");
  assert.equal(hic, 0, "istek gitmez");
  console.log("PASS hata sınıflandırma (4xx kalıcı, 5xx/429/ağ geçici, geri çekilme)");

  // ── 5) Idempotency ──────────────────────────────────────────────────
  assert.equal(idempotencyKey(P), "notify-42", "bildirim kimliği varsa sabit anahtar");
  const h1 = idempotencyKey({ ...P, notificationId: null });
  const h2 = idempotencyKey({ ...P, notificationId: null });
  assert.equal(h1, h2, "içerik aynıysa anahtar aynı");
  assert.match(h1, /^notify-h[0-9a-f]+$/, "içerik özetinden anahtar");
  assert.notEqual(h1, idempotencyKey({ ...P, notificationId: null, message: "başka mesaj" }), "mesaj değişince anahtar değişir");
  assert.notEqual(idempotencyKey(P), idempotencyKey({ ...P, notificationId: 43 }), "kimlik farklıysa anahtar farklı");

  const basliklar: string[] = [];
  await (deliverCritical(P, [cfg("webhook")], {
    transport: async (_u, init) => { basliklar.push(init.headers["Idempotency-Key"]); return { ok: true, status: 200 }; },
    sleep: () => Promise.resolve(),
  }));
  assert.deepEqual(basliklar, ["notify-42"], "istek başlığında idempotency anahtarı");

  // Daha önce gönderilmiş kanal atlanır
  const atlanan = await (deliverCritical(P, [cfg("webhook"), cfg("sms")], {
    transport: async () => ({ ok: true, status: 200 }),
    sleep: () => Promise.resolve(),
    alreadySent: ["webhook"],
  }));
  assert.deepEqual(atlanan.sent, ["sms"], "gönderilmiş kanal tekrar gönderilmez");
  console.log("PASS idempotency (tekrar gönderim engellenir)");

  // ── 6) Toplu teslimat ve dürüst özet ────────────────────────────────
  const karisik = await (deliverCritical(P, [cfg("webhook", "https://hook.test/a"), cfg("email", "https://mail.test/send"), cfg("sms", "https://sms.test/send")], {
    transport: async (url) => {
      if (url.includes("mail")) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    },
    sleep: () => Promise.resolve(),
  }));
  assert.deepEqual(karisik.sent.sort(), ["sms", "webhook"], "başarılı kanallar");
  assert.deepEqual(karisik.failed, ["email"], "başarısız kanal raporlanır");
  assert.match(karisik.displayText, /İletildi: webhook, SMS/, "kullanıcı metni");
  assert.match(karisik.displayText, /başarısız: e-posta/, "başarısızlık gizlenmez");
  assert.match(karisik.auditText, /webhook:gonderildi\(200\)/, "denetim özeti kanal başına");
  assert.equal(karisik.noneConfigured, false, "kanal var");

  const bos = await (deliverCritical(P, []));
  assert.equal(bos.noneConfigured, true, "kanal yok işaretlenir");
  assert.match(bos.displayText, /yalnız uygulama içi/, "dürüst mesaj");
  assert.deepEqual(bos.attempts, [], "deneme yok");
  // Önem düzeyi SMS seçmiyorsa kanal seçilmediği söylenir (yapılandırılmamış demek yanlış olur)
  const dusuk = await (deliverCritical({ ...P, severity: "dusuk" }, [cfg("sms")]));
  assert.equal(dusuk.noneConfigured, false, "kanal yapılandırılmış");
  assert.match(dusuk.displayText, /Bu önem düzeyi için dış kanal seçilmedi/, "önem düzeyi açıklanır");
  assert.deepEqual(channelStatus([cfg("sms"), { ...cfg("email"), enabled: false }]).map((c) => c.enabled), [true, false], "kanal durumu");
  assert.equal(ATTEMPT_TIMEOUT_MS, 8000, "zaman aşımı 8 sn");
  console.log("PASS toplu teslimat (kısmi başarı + dürüst özet)");

  // ── 7) Sunucu ve arayüz sözleşmesi ──────────────────────────────────
  const repo = read("src/lib/server/notifyDelivery.ts");
  assert.ok(repo.includes("CREATE TABLE IF NOT EXISTS notify_delivery"), "tablo çalışma anında hazırlanır");
  assert.ok(repo.includes("dedupe_key"), "idempotency anahtarı saklanır");
  assert.ok(repo.includes("alreadyDelivered"), "tekrar gönderim sorgusu");
  assert.match(repo, /status = 'gonderildi'/, "yalnız başarılı gönderim tekrar sayılmaz");
  const analyze = read("src/app/api/analyze/route.ts");
  assert.ok(analyze.includes("deliverAndRecord"), "analiz ucu çok kanallı teslimat kullanır");
  assert.ok(analyze.includes("channels: delivery.auditText"), "kanal kanıtı denetime yazılır");
  const route = read("src/app/api/notifications/route.ts");
  assert.ok(route.includes("deliverAndRecord"), "eskalasyon dış kanala iletilir");
  assert.ok(route.includes("channelHealth"), "kanal sağlığı ucu");
  assert.ok(route.includes("idempotency"), "yorumda idempotency kuralı belgeli");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("Çok kanallı") || admin.includes("çok kanallı"), "yönetimde çok kanallı kart");
  assert.ok(admin.includes("/api/notifications?delivery=1"), "kanal durumu panelden okunur");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "a-notify"[\s\S]{0,2400}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:notifych"]?.includes("notify-channels"), "test betiği kayıtlı");
  assert.ok(pkg.scripts["test"]?.includes("test:notifych"), "zincire eklenmiş");
  console.log("PASS sunucu ve arayüz sözleşmesi");

  console.log("Tüm a-notify (çok kanallı bildirim) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * w-audit: SIEM teslimat hattı (outbox) testleri — DB'siz.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  afterAttempt, DELIVERY_BATCH, dueForDelivery, MAX_DELIVERY_ATTEMPTS,
  retryDelayMs, siemConfigured, signatureHeader,
} from "../src/lib/server/auditDelivery";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── yeniden deneme politikası ──
ok(retryDelayMs(0) === 30_000, "ilk gecikme 30 sn");
ok(retryDelayMs(1) === 60_000, "ikinci gecikme 2×");
ok(retryDelayMs(20) === 3_600_000, "gecikme 1 saatte doygunlaşır");
ok(retryDelayMs(-5) === 30_000, "negatif deneme güvenli");

const t0 = new Date("2026-11-23T10:00:00.000Z");
ok(dueForDelivery({ status: "bekliyor", attempts: 0 }, null), "hiç denenmemiş satır hemen gönderilir");
ok(!dueForDelivery({ status: "bekliyor", attempts: 1 }, t0, t0.getTime() + 5_000), "yeni denenen satır bekleme süresinde atlanır");
ok(dueForDelivery({ status: "denendi", attempts: 1 }, t0, t0.getTime() + 61_000), "süre dolunca yeniden denenir");
ok(!dueForDelivery({ status: "gonderildi", attempts: 1 }, null), "gönderilmiş satır tekrar gönderilmez");
ok(!dueForDelivery({ status: "vazgecildi", attempts: 9 }, null), "vazgeçilen satır gönderilmez");

// ── deneme sonucu ──
const a1 = afterAttempt({ attempts: 0 }, false, "ECONNREFUSED");
ok(a1.status === "denendi" && a1.attempts === 1 && a1.lastError === "ECONNREFUSED", "başarısızlık: durum denendi, deneme arttı");
const a2 = afterAttempt({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }, false, "x");
ok(a2.status === "vazgecildi", "son denemede vazgeçildi (satır silinmez, görünür kalır)");
ok(afterAttempt({ attempts: 3 }, false, "hata".repeat(400)).lastError.length === 500, "hata metni 500 karakterle sınırlanır");
const a3 = afterAttempt({ attempts: 5 }, true);
ok(a3.status === "gonderildi" && a3.lastError === "", "başarı: gonderildi, hata temizlenir");

// ── imza ──
const secret = "s3cr3t";
const body = JSON.stringify({ source: "ArenaViewer", cef: "CEF:0|..." });
const sig = signatureHeader(createHmac("sha256", secret).update(body).digest("hex"));
ok(/^sha256=[0-9a-f]{64}$/.test(sig), "imza başlığı sha256=<hex64>");
ok(signatureHeader(createHmac("sha256", secret).update(body + "x").digest("hex")) !== sig, "gövde değişirse imza değişir (oynama saptanır)");
ok(createHmac("sha256", "baska").update(body).digest("hex") !== sig.slice(7), "farklı sırla imza tutmaz");

// ── yapılandırma ──
ok(siemConfigured({ AUDIT_SIEM_URL: "https://siem.local/ingest" }), "url varsa etkin");
ok(!siemConfigured({}), "url yoksa kapalı (kuyruk birikir)");
ok(DELIVERY_BATCH >= 100 && DELIVERY_BATCH <= 1000, "tur başına toplu gönderim makul");

// ── entegrasyon iddiaları (kaynak düzeyi) ──
const root = path.resolve(__dirname, "..");
const audit = readFileSync(path.join(root, "src/lib/server/audit.ts"), "utf8");
ok(audit.includes("enqueueDelivery(tx") && audit.includes("inserted[0]?.id"), "denetim satırıyla aynı işlemde kuyruğa yazılıyor");
ok(audit.includes("catch") && audit.includes("denetim kuyruğa yazılamadı"), "kuyruk hatası denetim kaydını düşürmüyor");
const repo = readFileSync(path.join(root, "src/lib/server/auditDeliveryRepo.ts"), "utf8");
ok(repo.includes("X-Atik-Signature") && repo.includes("createHmac"), "SIEM gönderimi HMAC ile imzalanıyor");
ok(repo.includes("AbortSignal.timeout") && repo.includes("lastAttemptAt"), "zaman aşımı + deneme zamanı yazılıyor");
ok(repo.includes("CREATE TABLE IF NOT EXISTS audit_delivery"), "kuyruk tablosu çalışma anında hazırlanır (ek geçiş gerekmez)");
const schema = readFileSync(path.join(root, "src/db/schema.ts"), "utf8");
ok(schema.includes('pgTable(\n  "audit_delivery"') || schema.includes('"audit_delivery"'), "şemada audit_delivery tanımlı");
const route = readFileSync(path.join(root, "src/app/api/audit/export/route.ts"), "utf8");
ok(route.includes('sp.get("siem")') && route.includes("deliveryStats"), "kuyruk durumu yönetici ucundan okunuyor");
ok(route.includes("deliverPending") && route.includes("audit.siem_flush"), "elle boşaltma denetim kaydına yazılıyor");
const admin = readFileSync(path.join(root, "src/components/AdminPanel.tsx"), "utf8");
ok(admin.includes("SIEM kuyruğu") && admin.includes("siem.pending"), "yönetici ekranında kuyruk görünür");

if (failed) { console.error(`${failed} SIEM teslimat testi başarısız`); process.exit(1); }
console.log("Tüm w-audit (SIEM teslimat) testleri geçti.");

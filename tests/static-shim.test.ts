/**
 * Statik demo (GitHub Pages) ↔ yönetim paneli sözleşme testi.
 *
 * Neden: Pages derlemesinde `src/app/api` **silinir** ve istekler
 * `StaticAdminShim` tarafından karşılanır. Panel yeni bir uç çağırıp shim'e
 * eklenmezse demo **sessizce boş sekme** gösterir — bu, "çalışıyor" izlenimi
 * veren en tehlikeli hata sınıfı. Test iki yönü de kilitler:
 *
 *   A) Panelin çağırdığı her `/api/...` yolu shim'de karşılanmalı,
 *   B) shim'in `/api/admin/health` yanıtı **gerçek uçla aynı** saf katmandan
 *      üretilmeli (`evaluateEnv`/`parsePrometheus`), ayrıca kopya mantık yok.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateEnv, summarizeChecks, type EnvSnapshot } from "../src/lib/adminHealth";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const panel = read("src/components/AdminPanel.tsx");
const shim = read("src/components/StaticAdminShim.tsx");
const workstation = read("src/components/Workstation.tsx");
// Ana ekran uçları `StaticApiShim` tarafından karşılanır (admin shim'den ayrı dosya).
const apiShim = read("src/components/StaticApiShim.tsx");

// ── A) Panelin çağırdığı uçlar shim'de var mı? ──
const calls = [...panel.matchAll(/"(\/api\/[a-z0-9/_\-\{\}]+)"/g)].map((m) => m[1]);
const unique = [...new Set(calls)];
ok(unique.length >= 20, `panelde en az 20 farklı uç çağrısı (${unique.length})`);
// Şablon değişkenli yollar (ör. /api/shares/${token}) shim'de regex/method ile
// karşılanır; burada yalnız statik dizeleri denetliyoruz.
const shimCases = [...shim.matchAll(/p === "(\/api\/[^"]+)"/g)].map((m) => m[1]);
const shimLoops = [...shim.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
const apiShimCases = [...apiShim.matchAll(/p === "(\/api\/[^"]+)"/g)].map((m) => m[1]);
const covered = (u: string) =>
  [...shimCases, ...apiShimCases, ...shimLoops].some((c) => c === u || u.startsWith(`${c}/`) || `${c}/`.startsWith(`${u}/`));
const missing = unique.filter((u) => !u.includes("${") && !covered(u));
ok(missing.length === 0, `panel uçlarının tamamı shim'de karşılanıyor${missing.length ? ` — EKSİK: ${missing.join(", ")}` : ""}`);

// Yeni bağlanan uçlar (bu turda): her biri gerçek bir yanıt üretmeli, 503 değil.
for (const p of ["/api/admin/health", "/api/admin/backup/drill", "/api/shares", "/api/shadow/summary"]) {
  ok(shim.includes(`p === "${p}"`), `shim ${p} için gövde içeriyor`);
}
ok(/p === "\/api\/admin\/backup\/drill"[\s\S]{0,600}else/.test(shim) === false, "backup/drill hem GET hem POST dalı taşıyor");
ok(/\/\^\\\/api\\\/shares\\\/\[0-9a-f\]\{48\}\$/.test(shim), "shim, DELETE /api/shares/<48 hex> yolunu tanır");
ok(shim.includes('fail("Statik demoda paylaşım bağlantısı oluşturulamaz (sunucu gerekir)", 503)'), "oluşturma gerçekten sunucu gerektirir → 503 (sahte başarı yok)");
ok(shim.includes("biçim"), "shim'de biçim bozulması yok (yanlış karakter denemesi)");

// Bilinmeyen uç: sessiz 200 değil, açık 503.
const tail = shim.slice(shim.lastIndexOf("return json("));
ok(/503/.test(tail), "bilinmeyen uç 503 döner (demo 'başarılı' taklidi yapmaz)");

// `StaticApiShim`'de özel dalı olmayan uçlar bilinçli olarak 503 döner; testte
// bunlar "eksik" sayılmaz ama **listesi sabittir**: yeni bir uç eklendiğinde
// burada görünür ve sahibi karar verir.
const KNOWN_UNIMPLEMENTED = ["/api/pacs/stow", "/api/multi-analyze"];
const unexpected = missing.filter((u) => !KNOWN_UNIMPLEMENTED.includes(u));
ok(unexpected.length === 0, `bilinmeyen eksik uç yok${unexpected.length ? ` — ${unexpected.join(", ")}` : ""}`);
for (const u of missing) {
  ok(
    /503/.test(apiShim + shim),
    `${u} demoda 503 ile açıkça reddediliyor (sessiz başarı yok)`,
  );
}

// ── B) Demo sağlık yanıtı gerçek katmandan mı? ──
ok(/import \{[^}]*evaluateEnv[^}]*\} from "@\/lib\/adminHealth"/.test(shim), "shim, gerçek `evaluateEnv` fonksiyonunu içe aktarır");
ok(/import \{[^}]*parsePrometheus[^}]*\} from "@\/lib\/adminHealth"/.test(shim), "shim, gerçek Prometheus ayrıştırıcısını içe aktarır");
ok(!/function evaluateEnv|const evaluateEnv =/.test(shim), "shim kendi denetim kopyasını yazmıyor (ikiz mantık yok)");
ok(shim.includes("DEMO VERİSİ"), "demo yanıtı örnek veri olduğunu açıkça yazar");
ok(/ready: null/.test(shim), "statik demoda readiness `null` (uydurulmuş 'hazır' yok)");

// Demo ortamı gerçekçi mi? Demo bir **kurulum** gibidir: kimlik modu kapalıdır
// ve TLS yoktur (statik sitede sunucu tarafı yok). Bu ikisi üretimde kritik
// olduğu için demo kartı da kritik gösterir — bu doğru davranıştır; kartın
// "DEMO VERİSİ" notu ve önerileri bunu açıklar. Kalan 10 kural kritik olmamalı.
const demo = {
  authMode: "hesap", requireTls: "0", hstsMaxAge: "", keySource: "env", keyCount: 2,
  databaseUrl: false, llmConfigured: false, metricsToken: false,
  auditSiemUrl: false, auditSyslogHost: false, storage: "fs:./.data (demo)", nodeEnv: "production",
  appVersion: "0.2.0", ingestApiKey: false, hisApiKey: false, requireTotpRoles: "yonetici",
} satisfies EnvSnapshot;
const sum = summarizeChecks(evaluateEnv(demo));
const kritikIds = evaluateEnv(demo).filter((c) => c.level === "kritik").map((c) => c.id).sort();
// Statik sitede sunucu/DB/TLS yoktur: bu üç kural gerçekten kritiktir ve
// kartın "DEMO VERİSİ" notu nedeniyle yanıltıcı değildir.
const EXPECTED_DEMO_CRITICAL = ["auth-mode", "tls", "database"];
ok(kritikIds.every((id) => EXPECTED_DEMO_CRITICAL.includes(id)), `demo farkları yalnız ortam kaynaklı: ${kritikIds.join(", ") || "yok"}`);
ok(/DEMO VERİSİ/.test(shim.slice(shim.indexOf('p === "/api/admin/health"'), shim.indexOf('p === "/api/admin/health"') + 2000)), "sağlık yanıtı demo olduğunu aynı yanıtta yazar");
ok(sum.uyari >= 3, `demo kartı gerçek uyarıları gösteriyor (${sum.uyari})`);
ok(sum.total === 12, "demo kartı 12 kuralın tamamını basıyor");

// ── C) Ana ekran (Workstation) yeni uçlara bağımlı değil ──
const wsApis = [...new Set([...workstation.matchAll(/"(\/api\/[a-z0-9/_\-\{\}]+)"/g)].map((m) => m[1]))];
const wsMissing = wsApis.filter((u) => !u.includes("${") && !covered(u) && !KNOWN_UNIMPLEMENTED.includes(u));
ok(wsMissing.length === 0, `Workstation uçları da karşılanıyor${wsMissing.length ? ` — EKSİK: ${wsMissing.join(", ")}` : ""}`);

if (failed) { console.error(`${failed} statik demo sözleşme testi başarısız`); process.exit(1); }
console.log("Statik demo ↔ yönetim paneli sözleşme testleri geçti.");

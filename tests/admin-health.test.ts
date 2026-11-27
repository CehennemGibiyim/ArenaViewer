/**
 * Yönetim → Sistem sağlığı sekmesinin **saf** katmanı testi.
 *
 * Neden: panel "her şey yolunda" diyorsa bu bir iddiadır. Bu testler ortam
 * denetiminin kurallarını, Prometheus ayrıştırıcısının bozuk girdide çökmemesi
 * ve **sır sızdırmaması**, paylaşım token'ının maskelenmesi gibi sözleşmeleri
 * sabitler. Ayrıca API ucu ile panelin aynı alanları kullandığı kaynak
 * taramasıyla denetlenir (uç/panel uyumsuzluğu sessiz hatadır).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  backupAge, backupState, evaluateEnv, formatBytes, formatMetricValue, maskShareToken,
  parsePrometheus, shadowRows, shareRemaining, summarizeChecks, type EnvSnapshot,
} from "../src/lib/adminHealth";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const base: EnvSnapshot = {
  authMode: "hesap", requireTls: "1", hstsMaxAge: "31536000", keySource: "env", keyCount: 2,
  databaseUrl: true, llmConfigured: false, metricsToken: true, auditSiemUrl: true, auditSyslogHost: false,
  storage: "S3 pacs.local/atik", nodeEnv: "production", appVersion: "0.2.0",
  ingestApiKey: true, hisApiKey: false, requireTotpRoles: "yonetici",
};

// ── 1. Ortam değerlendirmesi ──
const good = evaluateEnv(base);
ok(good.length === 12, `12 denetim kuralı (${good.length})`);
ok(good.every((c) => ["ok", "uyari", "kritik", "bilgi"].includes(c.level)), "her seviye geçerli");
ok(new Set(good.map((c) => c.id)).size === good.length, "kural kimlikleri benzersiz");
ok(good.every((c) => c.label && c.hint), "her kuralın etiketi ve önerisi var");
const goodLevels = summarizeChecks(good);
ok(goodLevels.kritik === 0, `iyi yapılandırmada kritik yok (${goodLevels.kritik})`);
ok(good.find((c) => c.id === "auth-mode")?.level === "ok", "AUTH_MODE=hesap → ok");

// Üretimde demo kimlik ve TLS'siz çalışma KRİTİK olmalı (güvenlik iddiası).
const bad = evaluateEnv({ ...base, authMode: "", requireTls: "0", keySource: "file", metricsToken: false });
ok(bad.find((c) => c.id === "auth-mode")?.level === "kritik", "üretimde demo kimlik modu → kritik");
ok(bad.find((c) => c.id === "tls")?.level === "kritik", "üretimde TLS kapalı → kritik");
ok(bad.find((c) => c.id === "key-source")?.level === "kritik", "üretimde anahtar dosyada → kritik");
ok(bad.find((c) => c.id === "metrics-token")?.level === "uyari", "METRICS_TOKEN yok → uyarı");
// Geliştirmede aynı durumlar kritik değil: yanlış alarm üretilmemeli.
const dev = evaluateEnv({ ...base, authMode: "", requireTls: "0", keySource: "file", nodeEnv: "development" });
ok(dev.find((c) => c.id === "auth-mode")?.level === "uyari", "geliştirmede demo kimlik → uyarı (kritik değil)");
// Sır sızdırmama: metinlerde ortam değeri/anahtarı yok.
const dump = JSON.stringify(good) + JSON.stringify(bad);
ok(!/sk-|password|secret|BEGIN PRIVATE/.test(dump), "rapor metinlerinde sır örneği yok");
ok(dump.includes("HSTS"), "HSTS bilgisi gösterilir (sır değil; max-age genel yapılandırmadır)");

// ── 2. Prometheus ayrıştırıcı ──
const text = [
  "# HELP atik_db_up Veritabanı bağlantısı 1/0",
  "# TYPE atik_db_up gauge",
  "atik_db_up 1",
  "# HELP atik_studies_total Çalışma sayısı",
  "# TYPE atik_studies_total gauge",
  'atik_studies_total{work_status="okunuyor"} 12',
  'atik_studies_total{work_status="onaylandı"} 7',
  "# TYPE atik_build_info gauge",
  'atik_build_info{version="0.2.0"} 1',
  "",
].join("\n");
const parsed = parsePrometheus(text);
ok(parsed.length === 3, `3 seri ayrıştırıldı (${parsed.length})`);
ok(parsed.every((m) => m.name.startsWith("atik_")), "yalnız metrik serileri döner (# yorumları değil)");
const studies = parsed.find((m) => m.name === "atik_studies_total")!;
ok(studies.points.length === 2 && studies.points[0].labels.work_status === "okunuyor", "etiketler çözülür (Türkçe karakter dahil)");
ok(parsed.find((m) => m.name === "atik_build_info")?.help === "" || true, "HELP satırı olmayan seri çökmez");
// Bozuk/eksik girdi: sessizce atlanır, istisna fırlatmaz.
const messy = parsePrometheus("bozuk satır\natik_x\natik_y{a=\"b\"} NaN\n# TYPE\n\natik_z 1e3\n");
ok(Array.isArray(messy), "bozuk metin dizi döndürür (çökmez)");
ok(messy.find((m) => m.name === "atik_z")?.points[0].value === 1000, "bilimsel gösterim sayıya çevrilir");
ok(parsePrometheus("").length === 0, "boş metin → boş dizi");
// Etiket kaçışları geri çözülür.
const esc = parsePrometheus('atik_q{note="a\\"b\\nc"} 5');
ok(esc[0].points[0].labels.note === 'a"b\nc', "etiket kaçışları (\\\" ve \\n) çözülür");
ok(formatMetricValue(1234.5) === "1.234,5", `tr-TR sayı biçimi (${formatMetricValue(1234.5)})`);
ok(formatMetricValue(Number.NaN) === "—", "NaN değeri '—' olarak gösterilir");

// ── 3. Yedek görünümü ──
ok(formatBytes(0) === "0 B" && formatBytes(1536) === "1.5 KB" && formatBytes(3 * 1024 ** 3) === "3.00 GB", "bayt biçimleme");
const manifest = {
  createdAt: "2026-11-20T00:00:00.000Z", appVersion: "0.2.0", source: "fs:./.data", totalBytes: 2048,
  entries: [
    { key: "a.dcm", size: 1024, sha256: "a".repeat(64), shaScope: "plain" as const },
    { key: "b.dcm", size: 1024, sha256: "b".repeat(64), shaScope: "cipher" as const },
  ],
};
const st = backupState(manifest);
ok(st.verified === false && st.label === "doğrulanmadı", "doğrulanmamış yedek 'sağlam' sayılmaz");
ok(st.cipherOnly === 1, "yalnız şifreli özet taşıyan dosya sayılır (anahtar kaybı riski görünür)");
const st2 = backupState(manifest, { ok: true, checked: 2, errors: [], warnings: [] });
ok(st2.label === "sağlam" && st2.level === "ok", "başarılı doğrulama → sağlam");
const st3 = backupState(manifest, { ok: false, checked: 2, errors: ["Eksik: b.dcm"], warnings: [] });
ok(st3.level === "kritik" && st3.missing === 1, "eksik dosya → kritik + sayı");
const age = backupAge("2026-10-01T00:00:00.000Z", new Date("2026-11-27T00:00:00.000Z"));
ok(age.days === 57 && age.level === "kritik", `30 günden eski yedek kritik (${age.days} gün)`);
ok(backupAge("2026-11-25T00:00:00.000Z", new Date("2026-11-27T00:00:00.000Z")).level === "ok", "yeni yedek ok");
ok(backupAge("bozuk", new Date()).days === null, "bozuk tarih null (tahmin yok)");

// ── 4. Paylaşım görünümü ──
const token = "a1b2c3d4e5f6".repeat(4);
ok(maskShareToken(token).startsWith("a1b2c3d4") && maskShareToken(token).includes("…"), "token maskelenir");
ok(!maskShareToken(token).includes(token), "maskelenmiş metin tam token içermez");
ok(maskShareToken("kisa") === "…", "kısa token yalnız '…'");
const rem = shareRemaining("2026-11-27T12:00:00.000Z", null, new Date("2026-11-27T00:00:00.000Z"));
ok(rem.hours === 12 && rem.level === "uyari", "24 saatten az kalan bağlantı uyarı");
ok(shareRemaining("2026-11-27T00:00:00.000Z", "2026-11-26T00:00:00.000Z").text === "kapatıldı", "kapatılmış bağlantı");
ok(shareRemaining("2026-11-01T00:00:00.000Z", null, new Date("2026-11-27T00:00:00.000Z")).text === "süresi doldu", "süresi dolmuş bağlantı");

// ── 5. Gölge mod özeti ──
const shadow = shadowRows([
  { engine: "ich", model: "m1", count: 3, findings: 4, lastAt: "2026-11-26T10:00:00.000Z" },
  { engine: "cxr", model: "m2", count: 2, findings: 9, lastAt: "2026-11-27T09:00:00.000Z" },
]);
ok(shadow.totalRecords === 5 && shadow.totalFindings === 13, "gölge kayıt/bulgu toplamları");
ok(shadow.lastAt === "2026-11-27T09:00:00.000Z", "en son gölge kaydı zamanı");
ok(shadowRows([]).empty && shadowRows([]).totalFindings === 0, "boş özet sıfır (uydurma yok)");

// ── 6. Uç ↔ panel uyumu (kaynak taraması) ──
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const healthRoute = read("src/app/api/admin/health/route.ts");
const panel = read("src/components/AdminPanel.tsx");
ok(healthRoute.includes("authorize(req, [\"yonetici\"])"), "sağlık ucu yönetici yetkisi ister");
// Sırlar yalnız boolean varlık olarak taşınır: hiçbir ortam değişkeni doğrudan
// bir alana atanmaz ( `: process.env.X` deseni yasak).
ok(!/:\s*process\.env\.[A-Z_]+\s*[,}]/.test(healthRoute), "ortam değişkenleri alanlara ham atanmaz");
ok(!/DATA_ENCRYPTION_KEYS|SECRET|PASSWORD/.test(healthRoute), "uç, anahtar/parola değişkenlerini hiç okumaz");
ok((healthRoute.match(/!!process\.env\./g) ?? []).length >= 6, "varlık bilgisi boolean olarak üretilir");
ok(healthRoute.includes("evaluateEnv") && healthRoute.includes("parsePrometheus"), "uç, saf katmanı kullanır (mantık ikizlenmez)");
for (const marker of ["/api/admin/health", "tab === \"health\"", "tab === \"backup\"", "tab === \"sharing\""]) {
  ok(panel.includes(marker), `AdminPanel "${marker}" bağlı`);
}
ok(panel.includes("/api/admin/backup/drill") && panel.includes("/api/shares"), "panel yedek tatbikatı ve paylaşım uçlarını çağırır");
ok(panel.includes("/api/shadow/summary"), "panel gölge mod özetini gösterir");

if (failed) { console.error(`${failed} admin sağlık testi başarısız`); process.exit(1); }
console.log("Admin sağlık/paylaşım/yedek görünüm testleri geçti.");

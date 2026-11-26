/**
 * g-webhard / CSP→SIEM: CSP ihlal raporlarının denetime ve SIEM'e aktarımı.
 * Saf filtre + kaynak bağlantısı kontrolleri (DB'siz ortam).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCsp, summarizeCspReport, CspReportFilter, ruleFor } from "../src/lib/webSecurity";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");

// 1) CSP'ye rapor yönergesi eklendi
const csp = buildCsp({ nonce: "abc" });
assert.match(csp, /report-uri \/api\/csp-report/, "CSP report-uri yazıyor");
assert.match(csp, /frame-ancestors 'self'/, "çerçeveleme kuralı korunuyor");
console.log("PASS buildCsp report-uri + temel yönergeler");

// 2) Kontrol karakterleri temizlenir (log enjeksiyonu)
const evil = summarizeCspReport({
  "csp-report": {
    "violated-directive": "img-src\r\nX-Forged: 1",
    "blocked-uri": "https://cdn.example/x.png\nSecond: line",
    "document-uri": "https://rad.ornek.hastane/x",
  },
});
assert.doesNotMatch(evil, /[\r\n]/, `kontrol karakteri yok: ${JSON.stringify(evil)}`);
assert.match(evil, /img-src X-Forged: 1/, "CRLF tek boşluğa indirilir");
console.log("PASS kontrol karakterleri temizlenir");

// 3) CspReportFilter: IP penceresi + yinelenme bastırması
const f = new CspReportFilter(3, 60_000, 8);
const t0 = 1_000_000;
assert.equal(f.allow("ip:1", "img-src | a | o", t0), true, "ilk rapor geçer");
assert.equal(f.allow("ip:1", "img-src | a | o", t0 + 1000), false, "aynı satır 60 sn içinde bastırılır");
assert.equal(f.allow("ip:2", "img-src | a | o", t0 + 2000), false, "aynı satır farklı IP'den de bastırılır (zincir korunur)");
assert.equal(f.allow("ip:1", "img-src | b | o", t0 + 3000), true, "farklı satır geçer");
assert.equal(f.allow("ip:1", "img-src | c | o", t0 + 4000), true, "üçüncü farklı satır geçer (3/3 hak)");
assert.equal(f.allow("ip:1", "img-src | d | o", t0 + 5000), false, "IP penceresi dolu: 4. farklı satır bastırılır");
assert.equal(f.allow("ip:2", "img-src | a | o", t0 + 61_000), true, "pencere dolunca aynı satır yeniden raporlanır");
// maxTrack taşması: en eski girişler atılır, boyut sınırlanır
const g2 = new CspReportFilter(100, 60_000, 2);
for (let i = 0; i < 6; i++) g2.allow("ip:9", `x${i} | y | o`, t0 + i);
const size = (g2 as unknown as { lineAt: Map<string, number> }).lineAt.size;
assert.ok(size <= 3, `satır takibi sınırlanır (size=${size})`);
console.log("PASS CspReportFilter (IP penceresi + bastırma + sınır)");

// 4) Hız sınırı: csp ucu sıkı kurala bağlandı
assert.equal(ruleFor("/api/csp-report", "POST")?.name, "csp", "csp ucu kendi kuralını alır");
assert.equal(ruleFor("/api/csp-report", "POST")?.rule.limit, 60, "csp kuralı 60/dk");
console.log("PASS ruleFor csp kuralı");

// 5) Uç → denetim → SIEM bağlantısı (kaynak sözleşmesi)
const route = read("src/app/api/csp-report/route.ts");
assert.ok(route.includes('audit(null, "csp.report"'), "rapor denetime yazılır");
assert.ok(route.includes("CspReportFilter"), "uç gürültü filtresi kullanıyor");
assert.ok(!route.includes("authorize("), "kimlik doğrulaması yok (tasarım gereği)");
assert.ok(route.includes("16_384"), "gövde sınırı korunuyor");
assert.ok(route.includes("status: 204"), "her durumda 204");
const audit = read("src/lib/server/audit.ts");
assert.ok(audit.includes("enqueueDelivery"), "audit() aynı işlemde SIEM teslimat kuyruğuna yazar");
const proxy = read("src/proxy.ts");
assert.ok(proxy.includes("CSP_REPORT_PATH"), "proxy CSP rapor yolunu tanıyor");
assert.ok(proxy.includes("path !== CSP_REPORT_PATH"), "CSP rapor ucu CSRF kontrolünden muaf");
assert.ok(proxy.includes("pathname === CSP_REPORT_PATH"), "CSP rapor ucu erişim kapısından muaf");
console.log("PASS uç → audit → audit_delivery/SIEM bağlantısı + proxy muafiyetleri");

console.log("Tüm CSP→SIEM testleri geçti.");

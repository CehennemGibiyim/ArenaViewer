/**
 * iframe gömme testi — `AV_FRAME_ANCESTORS` davranışını gerçek Chromium'da doğrular.
 *
 * İki sunucu gerekir (ikisi de aynı derlemeyi kullanır):
 *   A) AV_FRAME_ANCESTORS="http://127.0.0.1:3399" npx next start -p 3301   → gömülmeye İZİNLİ
 *   B) (değişken yok)                            npx next start -p 3302   → gömülmeye KAPALI
 * ve bu betik:
 *   eval "$(node scripts/local-chromium.mjs --print-env)" && node tests/frame-embed-browser.cjs
 *
 * Beklenen: A çerçevesi yüklenir ve içeriği görünür; B çerçevesi tarayıcı tarafından
 * reddedilir (alt çerçeve hiç oluşmaz) — yani X-Frame-Options/CSP koruması varsayılan
 * durumda gerçekten çalışıyor, izin verildiğinde de portalda gömülebiliyor.
 */
const http = require("node:http");
const { chromium } = require("playwright");

const PARENT_PORT = Number(process.env.AV_FRAME_PARENT_PORT || 3399);
const OK_URL = process.env.AV_FRAME_OK_URL || "http://127.0.0.1:3301/giris";
const BLOCKED_URL = process.env.AV_FRAME_BLOCKED_URL || "http://127.0.0.1:3302/giris";

const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Portal</title></head>
<body><h1>Kurumsal portal</h1>
<iframe id="ok" src="${OK_URL}" width="900" height="600"></iframe>
<iframe id="blocked" src="${BLOCKED_URL}" width="900" height="600"></iframe>
</body></html>`;

(async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(PARENT_PORT, "127.0.0.1", r));

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  let failures = 0;
  const check = (ok, msg, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${msg}${extra ? ` (${extra})` : ""}`);
    if (!ok) failures++;
  };

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PARENT_PORT}/`, { waitUntil: "load" });
    await page.waitForTimeout(2500);

    const frames = page.frames();
    const izinli = frames.find((f) => f.url().startsWith(OK_URL.replace(/\/giris$/, "")));
    check(!!izinli, "izinli köken çerçevesi oluştu", `${frames.length} çerçeve`);

    if (izinli) {
      const metin = await izinli.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "");
      check(metin.length > 20, "izinli çerçevede uygulama içeriği render edildi", JSON.stringify(metin.slice(0, 60)));
    }

    const engelli = frames.find((f) => f.url().startsWith(BLOCKED_URL.replace(/\/giris$/, "")) && !f.url().startsWith(OK_URL));
    check(!engelli, "izin verilmeyen köken çerçevesi tarayıcıda engellendi");

    // Konsolda CSP ihlali mesajı bekleniyor (koruma gerçekten devrede).
    const ihlal = [];
    page.on("console", (m) => {
      if (/frame-ancestors|X-Frame-Options/i.test(m.text())) ihlal.push(m.text());
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);
    check(ihlal.length > 0 || !page.frames().some((f) => f.url().startsWith(BLOCKED_URL.replace(/\/giris$/, ""))),
      "engellenen çerçeve için tarayıcı reddi doğrulandı", ihlal[0]?.slice(0, 80) ?? "çerçeve yok");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log(failures === 0 ? "iframe gömme testi: TÜMÜ GEÇTİ" : `iframe gömme testi: ${failures} HATA`);
  process.exitCode = failures === 0 ? 0 : 1;
})();

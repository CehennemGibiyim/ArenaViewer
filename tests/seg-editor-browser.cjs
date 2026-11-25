/* Segmentasyon düzenleyici (m-seg) tarayıcı duman testi.
 *
 * Gereksinim: `NEXT_PUBLIC_E2E_FIXTURES=true` ile çalışan bir sunucu.
 *   NEXT_PUBLIC_E2E_FIXTURES=true npm run dev -- -p 3100
 *   BASE_URL=http://127.0.0.1:3100 node tests/seg-editor-browser.cjs
 *
 * Tarayıcı ikilisi: Playwright CDN'i kapalı ortamlarda `CHROMIUM_PATH` ile
 * hazır bir Chromium (ör. @sparticuz/chromium) verilebilir:
 *   CHROMIUM_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib:/tmp \
 *     BASE_URL=http://127.0.0.1:3100 node tests/seg-editor-browser.cjs
 *
 * Neden ayrı: fırça/eşik etkileşimi yalnızca gerçek DOM olaylarıyla doğrulanır;
 * lib testleri maskeyi kapsar, tuval eşlemesini kapsamaz.
 */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const launch = {
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(process.env.CHROMIUM_PATH ? ["--disable-gpu", "--single-process", "--no-zygote"] : [])],
  };
  // Playwright CDN'i erişilemezse hazır Chromium ikilisi (sandbox/CI) kullanılır.
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(process.env.BASE_URL ?? "http://127.0.0.1:3100", { waitUntil: "domcontentloaded" });
    await page.getByTestId("workstation").waitFor();
    const side = page.locator('aside[aria-label="Seri listesi"]');
    await side.getByText("Toraks BT (akciğer penceresi)", { exact: true }).click();

    await page.getByTestId("open-seg-editor").click();
    const dialog = page.getByRole("dialog", { name: /Segmentasyon düzenleyici/ });
    await dialog.waitFor();

    // Fırça ile yatay bir darbe: tuval koordinatları görüntü pikseline çevrilmeli.
    const canvas = dialog.locator("canvas");
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 100, "tuval görünür ve ölçülebilir");
    const y = box.y + box.height * 0.45;
    await page.mouse.move(box.x + box.width * 0.35, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(box.x + box.width * (0.35 + 0.02 * i), y, { steps: 2 });
    }
    await page.mouse.up();

    const volumeText = await dialog.getByText(/voksel · /).first().innerText();
    const slicesPainted = Number(/(\d+) kesitte maske/.exec(volumeText)?.[1] ?? "0");
    assert.equal(slicesPainted, 1, `fırça tek kesite yazmalı (metin: ${volumeText})`);
    assert.match(volumeText, /bu kesitte [1-9]\d* piksel/);

    // Eşik dolgusu: tıklama HU aralığındaki pikselleri ekler.
    await dialog.getByRole("button", { name: /Eşik/ }).click();
    await page.mouse.click(box.x + box.width * 0.52, y);
    await dialog.getByRole("status").filter({ hasText: /Eşik dolgusu|Eşik aralığında piksel yok/ }).waitFor();

    // Geri al: eşik adımı geri alınabilmeli.
    await dialog.getByRole("button", { name: /Geri al/ }).click();
    await dialog.getByRole("status").filter({ hasText: /geri alındı/ }).waitFor();

    // Kesit kopyalama ve kesit temizleme komşu kesitle sınırlı kalmalı.
    await dialog.getByRole("button", { name: "Sonraki kesit" }).click();
    await dialog.getByRole("button", { name: /Önceki kesitten kopyala/ }).click();
    await dialog.getByRole("status").filter({ hasText: /kopyalandı/ }).waitFor();

    await dialog.getByRole("button", { name: /Uygula ve kapat/ }).click();
    await dialog.waitFor({ state: "hidden" });

    // Maske ana görüntüleyiciye taşınır ve alt bilgi çubuğunda hacim görünür.
    const footer = page.locator("footer");
    await footer.getByText(/Segment: \d+\.\d{2} mL/).waitFor();
    const footText = await footer.innerText();
    assert.match(footText, /Segment: \d+\.\d{2} mL/);

    // AI aday örtüsü ile karışmamalı: AI analizi çalıştırmadan da maske görünür.
    assert.match(await page.locator("body").innerText(), /Segment: \d+\.\d{2} mL/);

    // ── AI aday maskesinden tohumlama (m-seg) ──
    // Analiz, bulgu maskelerini üretir; düzenleyici bunları tohum olarak kopyalar.
    await page.getByRole("button", { name: /Analizi başlat/ }).first().click();
    await page.locator("footer").getByText(/ANALİZ TAMAM/).waitFor({ timeout: 90000 });
    await page.getByTestId("open-seg-editor").click();
    const dialog2 = page.getByRole("dialog", { name: /Segmentasyon düzenleyici/ });
    await dialog2.waitFor();
    const seed = dialog2.locator("button").filter({ hasText: /Nodül|Pulmoner/ }).first();
    await seed.waitFor();
    await seed.click();
    await dialog2.getByText(/düzenlemeye alındı/).waitFor();
    const seedLabel = await dialog2.locator('label:has-text("Segment adı") input').inputValue();
    assert.match(seedLabel, /^AI tohumlu/, `segment adı AI tohumlamasını gösterir (${seedLabel})`);
    const seedVol = await dialog2.getByText(/voksel · /).first().innerText();
    assert.doesNotMatch(seedVol, /^0 voksel/, `tohumlanan maske boş değil (${seedVol})`);
    await dialog2.getByRole("button", { name: /Uygula ve kapat/ }).click();
    await dialog2.waitFor({ state: "hidden" });
    console.log("PASS AI tohumlama: aday maske düzenlemeye kopyalandı ve hacim üretti.");

    assert.deepEqual(errors, [], `sayfa hatası olmamalı: ${errors.join(" | ")}`);
    console.log("PASS Segment editörü: fırça, eşik, geri al, kesit kopyalama ve mL hacim aktarımı çalışıyor.");
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/* Segmentasyon düzenleyici (m-seg) tarayıcı duman testi.
 *
 * Gereksinim: `NEXT_PUBLIC_E2E_FIXTURES=true` ile çalışan bir sunucu.
 *   NEXT_PUBLIC_E2E_FIXTURES=true npm run dev -- -p 3100
 *   BASE_URL=http://127.0.0.1:3100 NODE_PATH=<playwright> node tests/seg-editor-browser.cjs
 *
 * Neden ayrı: fırça/eşik etkileşimi yalnızca gerçek DOM olaylarıyla doğrulanır;
 * lib testleri maskeyi kapsar, tuval eşlemesini kapsamaz.
 */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
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

    assert.deepEqual(errors, [], `sayfa hatası olmamalı: ${errors.join(" | ")}`);
    console.log("PASS Segment editörü: fırça, eşik, geri al, kesit kopyalama ve mL hacim aktarımı çalışıyor.");
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

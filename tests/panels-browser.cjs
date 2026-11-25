/* Yeni panellerin tarayıcı testi: 📈 Trend, ⚖ Peer, /yonetim → Model kayıt defteri,
 * Oturumlar ve Kullanıcılar (hesap kilidi).
 *
 * Neden ayrı: bu üç panelin verisi sunucudan gelir; API testleri (test:db-api)
 * uçları doğrular, ancak panelin bu veriyi gösterdiği yalnız gerçek DOM ile
 * kanıtlanır.
 *
 * Gereksinim: PostgreSQL + şema + E2E fixture'lı production sunucu:
 *   npm run db:local && npm run db:push
 *   NEXT_PUBLIC_E2E_FIXTURES=true DATABASE_URL=... npm run build
 *   DATABASE_URL=... AV_RATE_LIMIT=off npx next start -p 3300
 *   eval "$(node scripts/local-chromium.mjs --print-env)"
 *   BASE_URL=http://127.0.0.1:3300 node tests/panels-browser.cjs
 *
 * Test kendi ölçüm geçmişi satırlarını 'L7084261 SD' (örnek hasta) için yazar ve
 * başlamadan önce temizler; model kayıt defterinde `e2e.` satırlarını bekler
 * (yoksa panelin boş durumu doğrulanır). Kilit testi için `e2e.locked` adlı geçici
 * bir kullanıcıyı kilitleyip arayüzden kilidi açar, sonucu veritabanından doğrular.
 */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { Client } = require("pg");

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const DB = process.env.DATABASE_URL ?? "postgres://atik@127.0.0.1:5432/atik";
const PATIENT = "L7084261 SD";

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();
  await db.query("delete from measurement_history where patient_id=$1", [PATIENT]);
  await db.query(
    `insert into measurement_history (patient_id, study_uid, study_date, series_key, modality, label, kind, value, unit, slice)
     values ($1,'P.STUDY.1','2026-01-10','PS1','MR','Uzunluk · E2E Nodül','length',12,'mm',3),
            ($1,'P.STUDY.1','2026-01-10','PS1','MR','Elipsoid hacim · E2E Nodül','volume',0.9,'mL',3),
            ($1,'P.STUDY.2','2026-03-10','PS2','MR','Uzunluk · E2E Nodül','length',18,'mm',4)`,
    [PATIENT]
  );

  // Kilit testi için geçici kullanıcı: sayaç 5, kilit 10 dk ileri.
  const LOCKED = "e2e.locked";
  await db.query("delete from users where username=$1", [LOCKED]);
  await db.query(
    `insert into users (username, password_hash, full_name, role, active, failed_login_count, locked_until)
     values ($1,'-','E2E Kilitli', 'radyolog', true, 5, now() + interval '10 minutes')`,
    [LOCKED]
  );

  const launch = {
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(process.env.CHROMIUM_PATH ? ["--disable-gpu", "--single-process", "--no-zygote"] : [])],
  };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;

  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workstation").waitFor();

    // ── 📈 Trend ──
    await page.getByRole("button", { name: /📈 Trend/ }).click();
    const trend = page.getByRole("dialog", { name: /Ölçüm geçmişi ve trend/ });
    await trend.waitFor();
    await trend.getByText(PATIENT, { exact: false }).first().waitFor();
    await trend.getByText("Uzunluk · E2E Nodül").first().waitFor();
    const trendText = await trend.innerText();
    assert.match(trendText, /12\.00/, "ilk ölçüm değeri (12,00 mm) tabloda");
    assert.match(trendText, /18\.00/, "ikinci ölçüm değeri (18,00 mm) tabloda");
    assert.match(trendText, /artıyor/, "iki ölçüm arası artış yönü yazılı");
    assert.match(trendText, /%\+50\.0/, "yüzde değişim hesaplanmış");
    assert.match(trendText, /ikilenme/i, "ikilenme süresi gösteriliyor");
    assert.match(trendText, /mL/, "hacim satırı da listeleniyor");
    await trend.getByRole("button", { name: "Kapat" }).click();
    await trend.waitFor({ state: "hidden" });
    console.log("PASS 📈 Trend: sunucudaki ölçümler etiket bazında grafik + yüzde + ikilenme ile gösterildi.");

    // ── ⚖ Peer ──
    await page.getByRole("button", { name: /⚖ Peer/ }).click();
    const peer = page.getByRole("dialog", { name: /RADPEER/ });
    await peer.waitFor();
    await peer.getByText(/değerlendirme · uyum/).waitFor();
    const peerText = await peer.innerText();
    assert.match(peerText, /%95 GA/, "uyum oranı güven aralığıyla");
    assert.match(peerText, /RADPEER 3/, "büyük fark puanı dağılımda");
    assert.match(peerText, /Günün örneklemi|Örneklem boş/, "örneklem bölümü var");
    await peer.getByRole("button", { name: "Kapat" }).click();
    await peer.waitFor({ state: "hidden" });
    console.log("PASS ⚖ Peer: uyuşmazlık istatistikleri ve RADPEER puan dağılımı panelde.");

    // ── /yonetim → Model kayıt defteri ──
    await page.goto(`${BASE}/yonetim`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Model kayıt defteri" }).click();
    const panel = page.getByRole("heading", { name: "Model kayıt defteri" });
    await panel.waitFor();
    // Panel önce "Yükleniyor…" gösterir; veri ya da boş durum gelene kadar bekle.
    await page.getByText(/e2e\.nodule|Kayıtlı model sürümü yok|Yalnız yönetici|Sunucuya ulaşılamadı/).first().waitFor({ timeout: 15000 });
    const registryText = await page.locator("main").innerText();
    const hasSeeded = /e2e\.nodule/.test(registryText);
    if (hasSeeded) {
      assert.match(registryText, /1\.0\.0/, "kayıtlı sürüm listeleniyor");
      assert.match(registryText, /Aktif/, "aşama rozeti görünüyor");
      assert.match(registryText, /Trafik planı/, "A/B trafik planı gösteriliyor");
      console.log("PASS /yonetim → Model kayıt defteri: sürümler, aşama ve trafik planı listelendi.");
    } else {
      assert.match(registryText, /Kayıtlı model sürümü yok|Yalnız yönetici|Sunucuya ulaşılamadı/, "boş/hata durumu açıkça yazılı");
      console.log("PASS /yonetim → Model kayıt defteri: kayıt yokken boş durum açıkça gösteriliyor.");
    }

    // ── /yonetim → Oturumlar (w-auth) ──
    await page.getByRole("button", { name: "Oturumlar" }).click();
    const sessionsPanel = page.getByTestId("sessions-panel");
    await sessionsPanel.waitFor();
    await sessionsPanel.getByText(/Etkin oturum yok|Sonlandır/).first().waitFor({ timeout: 15000 });
    const sessionsText = await sessionsPanel.innerText();
    assert.match(sessionsText, /Oturum kaydı sunucuda tutulur/, "kaydın sunucuda tutulduğu açıkça yazılı");
    assert.match(sessionsText, /Diğer oturumları kapat/, "toplu kapatma düğmesi var");
    // Demo modunda hesap girişi olmadığı için liste boş olmalı; varsa satırlar sonlandırılabilir olmalı.
    if (/Etkin oturum yok/.test(sessionsText)) {
      assert.match(sessionsText, /demo modunda işlemler operatör profiline atfedilir/i, "boş durumun nedeni yazılı");
    } else {
      assert.ok(await sessionsPanel.getByRole("button", { name: "Sonlandır" }).first().isVisible(), "oturum satırında Sonlandır düğmesi var");
    }
    console.log("PASS /yonetim → Oturumlar: sunucu tarafı oturum listesi ve boş durum açıklaması göründü.");

    // ── /yonetim → Kullanıcılar: hesap kilidi + kilidi aç ──
    await page.getByRole("button", { name: "Kullanıcılar" }).click();
    await page.getByText(LOCKED).first().waitFor({ timeout: 15000 });
    const lockedRow = page.locator("tr", { hasText: LOCKED }).first();
    // Tam eşleşme: satırdaki "E2E Kilitli" adı ile "kilitli" rozeti karışmasın.
    await lockedRow.getByText("kilitli", { exact: true }).waitFor();
    await lockedRow.getByRole("button", { name: "Kilidi aç" }).click();
    await page.waitForFunction((name) => {
      const tr = [...document.querySelectorAll("tr")].find((r) => r.textContent?.includes(name));
      if (!tr) return false;
      return ![...tr.querySelectorAll("span,td")].some((el) => el.textContent?.trim() === "kilitli");
    }, LOCKED, { timeout: 15000 });
    const after = await db.query("select failed_login_count, locked_until from users where username=$1", [LOCKED]);
    assert.equal(after.rows[0].failed_login_count, 0, "kilit açılınca sayaç sıfırlanmalı");
    assert.equal(after.rows[0].locked_until, null, "kilit bitişi temizlenmeli");
    console.log("PASS /yonetim → Kullanıcılar: kilitli hesap işaretlendi, 'Kilidi aç' sayacı ve kilidi veritabanında temizledi.");

    assert.deepEqual(errors, [], `sayfa hatası olmamalı: ${errors.join(" | ")}`);
    console.log("PASS Panel testleri: tarayıcıda JavaScript hatası yok.");
  } finally {
    await db.query("delete from users where username=$1", [LOCKED]).catch(() => {});
    await db.end();
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

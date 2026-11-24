/**
 * PWA / mobil hazırık testleri: manifest, hizmet işçisi kapsamı ve kayıt bekçisi.
 * Klinik verinin önbelleğe alınmaması açısından hizmet işçisi içeriği denetlenir.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// ── manifest ──
ok(existsSync(path.join(root, "public/manifest.webmanifest")), "manifest dosyası var");
const m = JSON.parse(read("public/manifest.webmanifest"));
ok(m.name && m.short_name === "AtikViewer", `ad/short_name (${m.short_name})`);
ok(m.lang === "tr-TR" && m.dir === "ltr", "dil/tr ve yön/ltr");
ok(["standalone", "fullscreen"].includes(m.display), `display = ${m.display}`);
ok(m.start_url.startsWith("/"), `start_url = ${m.start_url}`);
ok(m.background_color && m.theme_color, "arka plan/tema rengi tanımlı");
ok(Array.isArray(m.icons) && m.icons.some((i: { sizes?: string }) => i.sizes === "192x192") && m.icons.some((i: { sizes?: string }) => i.sizes === "512x512"),
  "192 ve 512 simgeleri listeli");
for (const ic of m.icons) ok(existsSync(path.join(root, "public", ic.src.replace(/^\//, ""))), `simge dosyası mevcut: ${ic.src}`);

// ── hizmet işçisi ──
ok(existsSync(path.join(root, "public/sw.js")), "sw.js var");
const sw = read("public/sw.js");
ok(sw.includes('"/api"'), "API yolları önbellek kurulardan çıkarılıyor");
ok(!/caches\.put\(\s*req/.test(sw), "bilinmeyen istekler önbelleğe yazılmıyor");
ok(sw.includes('"/offline.html"') || sw.includes("/offline.html"), "çevrimdışı sayfasına düşüş var");
ok(sw.includes("skipWaiting") && sw.includes("clients.claim"), "yeni sürüm devralmayı uygular");

// ── çevrimdışı sayfası ──
const off = read("public/offline.html");
ok(off.includes("Çevrimdışı") && off.includes("/giris"), "çevrimdışı sayfası Türkçe ve yeniden deneme bağlantısı içeriyor");
ok(!off.includes("fetch(") && !off.includes("/api/"), "çevrimdışı sayfa hasta verisi istemiyor");

// ── kayıt ve meta ──
const reg = read("src/components/ServiceWorkerRegister.tsx");
ok(reg.includes('process.env.NODE_ENV !== "production"'), "hizmet işçisi yalnızca üretimde kaydediliyor");
ok(reg.includes('register("/sw.js")'), "/sw.js kaydediliyor");
const layout = read("src/app/layout.tsx");
ok(layout.includes('manifest: "/manifest.webmanifest"'), "layout manifest bağlantısını veriyor");
ok(layout.includes("viewportFit: \"cover\"") && layout.includes("themeColor:"), "viewport/themeColor tanımlı");
ok(layout.includes("<ServiceWorkerRegister />"), "kayıt bileşeni yerleştirilmiş");

if (failed) { console.error(`${failed} PWA testi başarısız`); process.exit(1); }
console.log("Tüm PWA/mobil testleri geçti.");

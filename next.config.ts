import type { NextConfig } from "next";

// GitHub Pages (statik demo) derlemesi: GITHUB_PAGES=true ile açılır. Ayrıntı: scripts/prepare-pages.sh
const pages = process.env.GITHUB_PAGES === "true";
const basePath = pages ? (process.env.NEXT_PUBLIC_BASE_PATH ?? "") : "";

const nextConfig: NextConfig = {
  // Geliştirme önizlemesi (Arena sandbox / uzak tüneller): Next.js 16 sunucu
  // eylemlerini ve HMR isteklerini Host/Origin ile doğrular; bu ortamların
  // kökenleri `allowedDevOrigins` listesinde olmazsa sayfa hidrasyonu sessizce
  // kırılır. Yalnız **dev** derlemesinde etkilidir, üretimi değiştirmez.
  ...(pages ? {} : {
    allowedDevOrigins: [
      "*.e2b.app",
      "localhost:38247",
      "127.0.0.1:38247",
      ...(process.env.PREVIEW_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ],
  }),
  ...(pages ? { output: "export" as const, basePath, trailingSlash: true, images: { unoptimized: true } } : {}),
  // Derin AI uç noktası büyük HU hacimleri (gzip int16) alır; Next.js'in varsayılan
  // 10 MiB gövde sınırı veriyi sessizce keser → 700 MB'a çıkarılır.
  ...(pages ? {} : { experimental: { proxyClientMaxBodySize: 700 * 1024 * 1024 } }),
  // statik dışa aktarımda başlıklar desteklenmez
  ...(pages ? {} : { async headers() {
    // Kurumsal web hardening (G1): tüm yanıtlara temel güvenlik başlıkları.
    // CSP bilinçli olarak EKLENMEDİ: tarayıcı regresyon testlerinde menü
    // etkileşimleri bozuldu; önce nonce/strict-dynamic altyapısı kurulmalı.
    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    ];
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders, { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
      {
        // Prometheus metrik uç noktası: önbelleğe alınmaz.
        source: "/metrics",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/yonetim",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
      {
        source: "/kiyaslama",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
      {
        // Görüntü çözücüleri (JPEG 2000 / HTJ2K / JPEG-LS WASM) uygulama kısıtlı bir iframe içinde
        // (sandbox, allow-same-origin olmadan → köken "null") açıldığında da yüklenebilmeli.
        // Bu dosyalar herkese açık statik kütüphanelerdir; hasta verisi içermez.
        source: "/codecs/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Cache-Control", value: "public, max-age=86400" },
        ],
      },
      {
        // JPEG 2000 / JPEG-LS çözücü ikilileri. Next'in `send` MIME tablosu eski
        // sürümlü olduğu için .wasm → application/wasm burada açıkça verilir;
        // yanlış MIME'de WebAssembly.instantiateStreaming başarısız olur ve
        // Emscripten köprüsünün geri dönük tampon yolu devreye girmez.
        source: "/wasm/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Content-Type", value: "application/wasm" },
          { key: "Cache-Control", value: "public, max-age=86400" },
        ],
      },
    ];
  } }),
};

export default nextConfig;

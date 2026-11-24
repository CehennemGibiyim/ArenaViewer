import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import ClientRecovery from "@/components/ClientRecovery";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import UpdateNotice from "@/components/UpdateNotice";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATIKVIEWER — Vision AI Radyoloji İstasyonu",
  description:
    "DICOM görüntüleme, kesit kesit AI analizi ve yapısal radyoloji raporu üretimi. Araştırma amaçlıdır.",
  manifest: "/manifest.webmanifest",
  applicationName: "AtikViewer",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "AtikViewer" },
  icons: [
    { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};

export const viewport: Viewport = {
  themeColor: "#0b0f16",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body className="bg-[#070a0f] text-slate-200 antialiased"><ClientRecovery />{children}<UpdateNotice /><ServiceWorkerRegister /></body>
    </html>
  );
}

"use client";

import { useEffect, useState } from "react";

/**
 * Hizmet işçisini kaydeder (yalnızca üretim derlemesinde; geliştirme sunucusunda
 * önbellek çakışmasını önlemek için dev'de kayıt yapılmaz).
 *
 * İşçi yalnızca statik varlıkları önbelleğe alır; klinik veri hiçbir şekilde
 * önbelleğe girmez (`public/sw.js`).
 */
export default function ServiceWorkerRegister() {
  const [needReload, setNeedReload] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            // Yeni sürüm hazır: eski sekmeler yenilenene dek bekle.
            if (worker.state === "installed" && navigator.serviceWorker.controller) setNeedReload(true);
          });
        });
      }).catch(() => {});
      navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload());
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  if (!needReload) return null;
  return (
    <div className="fixed bottom-3 right-3 z-[60] flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-[#0b0f16] px-3 py-2 text-xs text-slate-200 shadow-lg">
      <span>Yeni sürüm hazır.</span>
      <button onClick={() => window.location.reload()} className="rounded bg-cyan-500/20 px-2 py-1 font-bold text-cyan-200 hover:bg-cyan-500/30">Yenile</button>
    </div>
  );
}

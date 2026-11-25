"use client";

/**
 * Görünüm tercihini (tema + hareket) ilk boyamada uygular.
 *
 * İş istasyonu kendi tema seçicisini taşır; giriş/yönetim/tercihler gibi sayfalarda
 * da aynı görünümün korunması için küçük bir istemci bileşeni kullanılır.
 * Satır içi <script> yerine effect kullanılır: CSP'de nonce/hash gerekmez.
 */
import { useEffect } from "react";

export default function AppearanceBoot() {
  useEffect(() => {
    try {
      const theme = window.localStorage.getItem("atik-theme");
      if (theme) document.documentElement.setAttribute("data-theme", theme);
      const motion = window.localStorage.getItem("atik-motion");
      if (motion) document.documentElement.dataset.motion = motion;
    } catch { /* depolama kapalıysa varsayılan görünüm */ }
  }, []);
  return null;
}

"use client";

import { useEffect } from "react";
import { HIGH_CONTRAST_CLASS, HIGH_CONTRAST_STORAGE_KEY } from "@/lib/a11y";

/**
 * Yüksek kontrast tercihini tüm sayfalarda uygular (i-a11y).
 *
 * Tercih cihazda saklanır (`localStorage`); iş istasyonundaki «◐ Kontrast»
 * düğmesi aynı anahtarı yazar. Bu bileşen ilk açılışta sınıfı `<html>`e ekler.
 */
export default function HighContrastInit() {
  useEffect(() => {
    let on = false;
    try { on = localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === "1"; } catch { /* depolama kapalı */ }
    if (on) document.documentElement.classList.add(HIGH_CONTRAST_CLASS);
  }, []);
  return null;
}

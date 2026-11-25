"use client";

import { useEffect } from "react";

/**
 * Diyalog pencereleri için Escape ile kapatma (i-a11y).
 *
 * WCAG beklentisi: klavye kullanıcısı fareye gitmeden pencereyi kapatabilmeli.
 * Yalnız geri alınamaz veri girmeyen panellerde kullanılır.
 */
export function useEscapeKey(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, active]);
}

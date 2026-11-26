/**
 * Yerinde piksel doldurma (lazy-pixel Adım 2): decode edilmiş tek kesiti
 * iskeletin sıfır Int16Array'ine kopyalar. Boyut uyuşmazlığında dizi
 * DEĞİŞTİRİLMEZ; çağıran «uyumsuz» sayacını artırır.
 *
 * Not: decode çıktısı Pixels birleşimidir; Float32/Uint16 diziler
 * Int16Array'e zorlanmaz — iskelet slotuna kendi dizisi yazılır
 * (dilim türü bağımsız kalır, render yolları üçünü de destekler).
 */
import type { Pixels } from "./types";

export type FillResult = "int16" | "replaced" | "incompatible";

/** Hedef Int16Array slota kaynak dizisini mümkün olduğunca yerinde kopyalar. */
export function fillSkeletonSlice(dst: Pixels[], index: number, src: Pixels): FillResult {
  const target = dst[index];
  if (!target || !src) return "incompatible";
  if (src.length !== target.length) return "incompatible";
  if (target instanceof Int16Array && src instanceof Int16Array) {
    target.set(src);
    return "int16";
  }
  // Uint16/Float32: yerinde kopya anlamsız (yanlış kesim/arpı); slotu değiştir
  dst[index] = src.slice() as Pixels;
  return "replaced";
}

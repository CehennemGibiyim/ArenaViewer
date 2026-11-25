/**
 * Monokrom pencere/seviye (WL/WW) dönüşümü — performans yolu (v-perf).
 *
 * Viewport'un taban katmanı her WL/WW/kesit değişiminde tüm kesiti yeniden işler;
 * büyük 2B görüntülerde (CR/DR, binlerce piksel) bu ana iş parçacığını dondurur.
 * Burada aynı dönüşüm tek geçişli bir LUT ile yapılır: değer → indis (trunc),
 * sınırlandır, LUT → paketlenmiş RGBA. Tam sayı değerli serilerde (gerçek HU)
 * eski döngüyle birebir aynı çıktıyı verir; kesirli sentetik örneklerde en fazla
 * 1 gri seviyesi fark eder (kliniksel anlam taşımaz).
 */

/** GRI_PALETTE[g] = 0xff000000 | g<<16 | g<<8 | g — paketlenmiş opak gri RGBA. */
export const GRAY_PALETTE: Uint32Array = (() => {
  const p = new Uint32Array(256);
  for (let g = 0; g < 256; g++) p[g] = 0xff000000 | (g << 16) | (g << 8) | g;
  return p;
})();

export interface WindowLUT { lut: Uint8ClampedArray; lo: number }

/**
 * WL/WW + ters çevirme için tek seferlik tablo. lut[j], pencere aralığının j.
 * birim adımındaki 0–255 çıktısıdır; dışarıda kalanlar sınırlara kenetlenir.
 */
export function buildWindowLUT(wl: number, ww: number, invert: boolean): WindowLUT {
  const span = Math.max(1, ww);
  const k = 255 / span;
  const len = Math.ceil(span) + 1;
  const lut = new Uint8ClampedArray(len);
  for (let j = 0; j < len; j++) {
    const g = j >= span ? 255 : Math.min(255, Math.trunc(j * k));
    lut[j] = invert ? 255 - g : g;
  }
  return { lut, lo: wl - span / 2 };
}

/**
 * Monokrom piksel dizisini RGBA'ya çevirir (out verilmezse yeni dizi).
 * src: kesit pikselleri (HU/SI); out: U×H×4 bayt ImageData için u32 görünümü.
 */
export function windowToRGBA(
  src: ArrayLike<number>,
  lut: Uint8ClampedArray,
  lo: number,
  out?: Uint32Array
): Uint32Array {
  const u32 = out ?? new Uint32Array(src.length);
  const top = lut.length - 1;
  const pal = GRAY_PALETTE;
  for (let i = 0; i < src.length; i++) {
    let t = (src[i] - lo) | 0; // trunc (negatifte de doğru)
    if (t < 0) t = 0; else if (t > top) t = top;
    u32[i] = pal[lut[t]];
  }
  return u32;
}

/** Eski (doğruluk referansı) dönüşüm; testte eşdeğerlik karşılaştırması için. */
export function windowToRGBALegacy(src: ArrayLike<number>, wl: number, ww: number, invert: boolean): Uint32Array {
  const lo = wl - ww / 2;
  const k = 255 / Math.max(1, ww);
  const u32 = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let g = (src[i] - lo) * k;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert) g = 255 - g;
    const gi = g | 0;
    u32[i] = 0xff000000 | (gi << 16) | (gi << 8) | gi;
  }
  return u32;
}

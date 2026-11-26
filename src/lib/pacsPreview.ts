/**
 * PACS metadata-first "ilk kare" önizlemesi (e-wado-frame, dilim 1/2).
 *
 * Görüntüleyici içe aktarma hattı hâlâ tam instance WADO indirir; bu modül
 * yalnız PACS listesinde, kullanıcı istediğinde TEK kare getirip çizer:
 *   1) `/api/pacs/instances` ile listenin ilk örneğini bul
 *   2) `/api/pacs/metadata` ile geometri/pencere/referans al (JSON, küçük)
 *   3) `/api/pacs/frames?…&raw=1` ile YALNIZ 1. kare baytlarını al
 *
 * Bilinçli sınırlar (dürüst): yalnız sıkıştırılmamış (implicit/explicit VR LE
 * ve explicit BE) tek örnek (MONOCHROME1/2) kareler; RGB/palet/sıkıştırılmış
 * aktarımlarda açık hata. Tam lazy-pixel görüntüleyici (MPR/cine dahil) ayrı
 * ve büyük iştir.
 */
import { firstInstance, type DicomJsonInstance, type DicomJsonElement } from "./bulkdata";
import { decodeGrayNative, grayFrameBytes } from "./pixelDecode";

const TS_EXPLICIT_LE = "1.2.840.10008.1.2.1";
const TS_EXPLICIT_BE = "1.2.840.10008.1.2.2";
const TS_IMPLICIT_LE = "1.2.840.10008.1.2";
export const UNCOMPRESSED_TS = new Set([TS_IMPLICIT_LE, TS_EXPLICIT_LE, TS_EXPLICIT_BE]);

export interface PreviewInfo {
  transferSyntax: string;
  photometric: "MONOCHROME1" | "MONOCHROME2";
  width: number;
  height: number;
  numberOfFrames: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRep: 0 | 1;
  slope: number;
  intercept: number;
  /** Modality WL/WW; yoksa undefined → kare min/max'i kullanılır */
  windowCenter?: number;
  windowWidth?: number;
}

export interface DecodedPreview {
  width: number;
  height: number;
  rgba: Uint8Array;
  wl: number;
  ww: number;
  sourceMin: number;
  sourceMax: number;
}

const el = (m: DicomJsonInstance, key: string): DicomJsonElement | undefined =>
  (m as Record<string, DicomJsonElement>)[key];

/** Value dizisinin ilk sayısını döndürür; dize sayılar da kabul edilir. */
const num = (m: DicomJsonInstance, key: string): number | undefined => {
  const v = el(m, key)?.Value?.[0];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (m: DicomJsonInstance, key: string): string | undefined => {
  const v = el(m, key)?.Value?.[0];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
};

/** metadata JSON'undan önizleme parametrelerini çözer; uygunsuzsa Türkçe hata fırlatır. */
export function parsePreviewMeta(metadata: unknown): PreviewInfo {
  const m = firstInstance(metadata);
  const transferSyntax = str(m, "0002,0010")?.trim() ?? "";
  if (!UNCOMPRESSED_TS.has(transferSyntax)) {
    throw new Error(`Bu örneğin aktarım sözdizimi sıkıştırılmış veya belge dışı (${transferSyntax || "tanımsız"}); önizleme yalnız sıkıştırılmamış MONOCHROME karelerde. Seriyi «Getir ve aç» ile açın.`);
  }
  const samples = num(m, "0028,0002") ?? 1;
  if (samples !== 1) {
    throw new Error(`Çok örnekli/RGB kare önizlemesi desteklenmiyor (SamplesPerPixel=${samples}).`);
  }
  const pmRaw = (str(m, "0028,0004") ?? "MONOCHROME2").trim().toUpperCase();
  if (pmRaw !== "MONOCHROME2" && pmRaw !== "MONOCHROME1") {
    throw new Error(`Fotometri ${pmRaw}; yalnız MONOCHROME1/2 önizlenir.`);
  }
  const height = Math.trunc(num(m, "0028,0010") ?? NaN);
  const width = Math.trunc(num(m, "0028,0011") ?? NaN);
  if (!Number.isFinite(height) || !Number.isFinite(width) || height < 1 || width < 1 || height > 16384 || width > 16384) {
    throw new Error("metadata'da geçerli Rows/Columns yok.");
  }
  const bitsAllocated = Math.trunc(num(m, "0028,0100") ?? 8);
  if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error(`BitsAllocated=${bitsAllocated}; yalnız 8/16 bit desteklenir.`);
  const bitsStored = Math.trunc(num(m, "0028,0101") ?? bitsAllocated);
  if (bitsStored < 1 || bitsStored > bitsAllocated) throw new Error(`BitsStored=${bitsStored} geçersiz (BitsAllocated=${bitsAllocated}).`);
  const pixelRep = (num(m, "0028,0103") ?? 0) === 1 ? 1 : 0;
  const numFrames = Math.max(1, Math.trunc(num(m, "0028,0008") ?? 1));
  return {
    transferSyntax,
    photometric: pmRaw,
    width,
    height,
    numberOfFrames: numFrames,
    bitsAllocated,
    bitsStored,
    pixelRep,
    slope: num(m, "0028,1053") ?? 1,
    intercept: num(m, "0028,1052") ?? 0,
    windowCenter: num(m, "0028,1050"),
    windowWidth: num(m, "0028,1051"),
  };
}

/** Kare baytlarını RGBA'ya çözer. Pencere yoksa kare min/max'i kullanılır. */
export function decodeFrameToRgba(info: PreviewInfo, frame: Uint8Array): DecodedPreview {
  const n = info.width * info.height;
  if (frame.length < n * (info.bitsAllocated >> 3)) {
    throw new Error(`Kare bayt sayısı beklenenden küçük (${frame.length} < ${n * (info.bitsAllocated >> 3)}).`);
  }
  const dec = decodeGrayNative(frame, 0, {
    rows: info.height,
    cols: info.width,
    bitsAllocated: info.bitsAllocated,
    bitsStored: info.bitsStored,
    pixelRep: info.pixelRep,
    bigEndian: info.transferSyntax === TS_EXPLICIT_BE,
    slope: info.slope,
    intercept: info.intercept,
  });
  if (!dec) throw new Error("Kare çözülemedi (boş/bozuk çerçeve).");
  let wl = info.windowCenter;
  let ww = info.windowWidth;
  const range = dec.max - dec.min;
  if (wl === undefined || !Number.isFinite(wl)) wl = (dec.min + dec.max) / 2;
  if (ww === undefined || !Number.isFinite(ww) || ww <= 0) ww = Math.max(1, range);
  const low = wl - ww / 2;
  const rgba = new Uint8Array(n * 4);
  const src = dec.pixels;
  const mono1 = info.photometric === "MONOCHROME1";
  for (let i = 0; i < n; i++) {
    let t = (src[i] - low) / ww;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let g = Math.round(t * 255);
    if (mono1) g = 255 - g;
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
  return { width: info.width, height: info.height, rgba, wl, ww, sourceMin: dec.min, sourceMax: dec.max };
}

/** Beklenen kare bayt uzunluğu (çağıran tarafın «tek kare» isteğiyle aynı olmalı). */
export function expectedFrameBytes(info: PreviewInfo): number {
  return grayFrameBytes({ rows: info.height, cols: info.width, bitsAllocated: info.bitsAllocated, bitsStored: info.bitsStored, pixelRep: info.pixelRep, bigEndian: info.transferSyntax === TS_EXPLICIT_BE, slope: info.slope, intercept: info.intercept });
}

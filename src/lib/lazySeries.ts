/**
 * Tam lazy-pixel görüntüleyici — Adım 1 (altyapı; görüntüleyiciye BAĞLI DEĞİL).
 *
 * Amaç: PACS'ten açılan serinin künye/geometrisini (QIDO includefield ile gelen
 * InstanceNumber, ImagePositionPatient z, Slice Thickness, Rows/Columns) tek
 * sorgudan alıp, piksel baytı henüz indirilmemiş TAHSİSLİ sıfır Int16Array
 * dizisi kurmak. Adım 2'de iskelet açılır, pikseller dalgalar hâlinde yerinde
 * doldurulur; bu adımda hiçbir çalışma zamanı davranışı değişmez.
 *
 * Seri sırası: z (IPP[2] / SliceLocation) küçükten büyüğe; z yoksa InstanceNumber;
 * ikisi de yoksa QIDO sırası korunur (kararlı sıralama). z'i eksik ögeler z'li
 * ögelerin arkasına, InstanceNumber'a göre (yoksa ham index) yerleşir.
 */

export interface LazyPacsInstance {
  seriesUid: string;
  sopUid: string;
  instanceNumber?: number;
  sliceLocation?: number;
  sliceThickness?: number;
  rows?: number;
  cols?: number;
  pixelSpacing?: number;
}

/** Seriye göre gruplar; grup ve grup-içi sıra QIDO sırasını izler (kararlı). */
export function groupInstancesBySeries<T extends LazyPacsInstance>(list: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of list) {
    if (!it?.seriesUid || !it?.sopUid) continue;
    const arr = out.get(it.seriesUid);
    if (arr) arr.push(it);
    else out.set(it.seriesUid, [it]);
  }
  return out;
}

/** Tek serinin dilimlerini kesit sırasına dizer (z → InstanceNumber → ham sıra). */
export function orderInstances<T extends LazyPacsInstance>(instances: T[]): T[] {
  const key = (it: T, index: number): [number, number, number] => {
    const z = Number.isFinite(it.sliceLocation as number) ? (it.sliceLocation as number) : Number.POSITIVE_INFINITY;
    const n = Number.isFinite(it.instanceNumber as number) ? (it.instanceNumber as number) : Number.POSITIVE_INFINITY;
    return [z, n, index];
  };
  return instances
    .map((it, index) => ({ it, k: key(it, index) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
    .map((x) => x.it);
}

export interface SkeletonInput {
  /** Tek seriye ait örnekler (QIDO instance listesi, istenen seri) */
  instances: LazyPacsInstance[];
  studyUid: string;
  modality?: string;
  description?: string;
  defaultWL?: number;
  defaultWW?: number;
  pixelSpacing?: number;
  /** Öğe başına rows/cols yoksa kullanılacak yedek (ör. metadata'dan) */
  rows?: number;
  cols?: number;
  sopClassUid?: string;
  /** İskelet için azami bellek (bayt). Aşılırsa RangeError fırlatır. Varsayılan 2 GiB */
  maxBytes?: number;
}

export interface SeriesSkeleton {
  studyUid: string;
  seriesUid: string;
  modality: string;
  description: string;
  /** Kesit sıralı TAHSİSLİ sıfır piksel dizileri (yerinde doldurulur) */
  slices: Int16Array[];
  /** Kesit sıralı SOP Instance UID'leri (indirme/çerçeve eşlemesi) */
  sopUids: string[];
  sopClassUid?: string;
  /** Tüm kesitlerde z tam tanımlıysa konumlar, değilse [] */
  slicePositions: number[];
  sliceThickness: number;
  width: number;
  height: number;
  pixelSpacing: number;
  defaultWL: number;
  defaultWW: number;
  /** Toplam tahsis edilen bayt (kullanıcıya bilgi) */
  allocatedBytes: number;
}

export const SKELETON_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Seri iskeletini kurar: künye + sıfır Int16Array slices + z konumları.
 * Boyut bilinmiyorsa ya da bellek tavanı aşılırsa açık hata fırlatır
 * (sessizce eksik tahsis yapılmaz).
 */
export function buildSeriesSkeleton(input: SkeletonInput): SeriesSkeleton {
  const ordered = orderInstances(input.instances);
  if (!ordered.length) throw new Error("İskelet için örnek listesi boş.");
  const width = Math.trunc(input.cols ?? ordered[0].cols ?? 0);
  const height = Math.trunc(input.rows ?? ordered[0].rows ?? 0);
  if (!(width > 0) || !(height > 0) || width > 16384 || height > 16384) {
    throw new Error("İskelet için Rows/Columns bilinmiyor (QIDO includefield ya da metadata gerekli).");
  }
  const px = width * height;
  const allocatedBytes = ordered.length * px * 2;
  const cap = input.maxBytes ?? SKELETON_MAX_BYTES;
  if (allocatedBytes > cap) {
    throw new Error(`Seri çok büyük (${(allocatedBytes / 1024 / 1024 / 1024).toFixed(1)} GiB); parçalı indirme gerekli — iskelet tahsis edilmedi.`);
  }
  const slices = Array.from({ length: ordered.length }, () => new Int16Array(px));
  const zs = ordered.map((i) => i.sliceLocation);
  const slicePositions = zs.every((z): z is number => Number.isFinite(z as number)) ? (zs as number[]) : [];
  const th = ordered.map((i) => i.sliceThickness).find((t) => Number.isFinite(t as number));
  return {
    studyUid: input.studyUid,
    seriesUid: ordered[0].seriesUid,
    modality: (input.modality ?? "CT").slice(0, 16),
    description: input.description ?? "PACS serisi",
    slices,
    sopUids: ordered.map((i) => i.sopUid),
    sopClassUid: input.sopClassUid,
    slicePositions,
    sliceThickness: (th as number) ?? 1,
    width,
    height,
    pixelSpacing: input.pixelSpacing ?? 1,
    // CT tipik varsayılan; decode dalgası geldiğinde gerçek pencere metadata'dan bilinir
    defaultWL: input.defaultWL ?? 40,
    defaultWW: input.defaultWW ?? 400,
    allocatedBytes,
  };
}

import type { SeriesData } from "./types";

export interface SkeletonSeriesMeta {
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  institution?: string;
}

/**
 * İskeleti `SeriesData`'ya dönüştürür (görüntüleyiciye bağlama Adım 2).
 * Slices ZERO-filled sıfır dizilerdir; `lazyPending = slices.length`.
 * Kimlikler tazedir (iskelet her açılışta yeniden kurulur).
 */
export function skeletonToSeriesData(sk: SeriesSkeleton, meta: SkeletonSeriesMeta = {}): SeriesData {
  const uidTail = sk.studyUid.replace(/\D/g, "").slice(-6) || "pacs";
  return {
    id: `lazy-${uidTail}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seriesUid: sk.seriesUid,
    modality: sk.modality as SeriesData["modality"],
    description: sk.description,
    bodyPart: "",
    patientName: meta.patientName?.trim() || "ANONİM",
    patientId: meta.patientId?.trim() || "",
    patientAge: "-",
    patientSex: "-",
    studyDate: meta.studyDate ?? "",
    institution: meta.institution ?? "",
    studyUid: sk.studyUid,
    width: sk.width,
    height: sk.height,
    pixelSpacing: sk.pixelSpacing,
    sliceThickness: sk.sliceThickness,
    sliceSpacing: sk.sliceThickness,
    slicePositions: sk.slicePositions.length ? [...sk.slicePositions] : undefined,
    sopUids: [...sk.sopUids],
    sopClassUid: sk.sopClassUid,
    defaultWL: sk.defaultWL,
    defaultWW: sk.defaultWW,
    unit: sk.modality === "CT" ? "HU" : "SI",
    slices: sk.slices,
    lesions: [],
    tags: [],
    isSample: false,
    lazyPending: sk.slices.length,
  };
}

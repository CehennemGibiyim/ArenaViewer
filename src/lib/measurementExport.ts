/**
 * Ekran ölçümleri → TID 1500 ölçüm listesi (c-sr-tid1500).
 *
 * Köprü modülü: `geometry` ölçümlerini (uzunluk/elipsoid/ROI…) TID 1500
 * `Measurement` nesnelerine çevirir. Böylece PACS'e giden SR, serbest metin
 * yerine sayısal ölçüm içerir ve izleyici lesyon takibini yeniden yapabilir.
 *
 * Kodlama ilkesi: bulgu/bölge kodları UYDURULMAZ; bilinmeyenler 99ATIKVIEWER
 * özel şemasına yazılır. Standart uzunluk/hacim/ortalama kodları DICOM'dandır.
 */
import { dist, ellipsoidD3 } from "./geometry";
import { mapTerm, type CodeTable } from "./codeMapping";
import type { Annotation } from "./types";
import { atikCode, QUANTITY, SITES, type Code, type Measurement } from "./sr1500";

export interface MeasureExportOptions {
  /** Piksel→mm ölçeği */
  pxMm: number;
  /** İzleme kimliği öneki (ör. "NOD") */
  prefix?: string;
  /** Varsayılan bulgu kodu (panelden seçilir; yoksa 99ATIKVIEWER) */
  finding?: Code;
  /** Varsayılan bölge kodu */
  site?: Code;
  /** Seri UID'leri (görüntü başvurusu için) */
  series?: { seriesUid?: string; sopClassUid?: string; sopUids?: string[] };
}

const f2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ölçüm türü → TID 1500 ölçüm(ler)i.
 * Elipsoid hem hacim hem en uzun çap olarak yazılır (takipte ikisi de kullanılır).
 */
export function annotationToMeasurements(a: Annotation, o: MeasureExportOptions, n: number): Measurement[] {
  const id = `${o.prefix ?? "OLCUM"}-${n}`;
  const p = a.points;
  const image = o.series?.seriesUid && o.series.sopClassUid && o.series.sopUids?.[a.slice]
    ? { seriesUid: o.series.seriesUid, sopClassUid: o.series.sopClassUid, sopUid: o.series.sopUids[a.slice] }
    : undefined;
  const base = { trackingId: id, finding: o.finding ?? atikCode("MEASUREMENT", "Ölçüm"), site: o.site, image };
  const mm = (v: number) => f2(v * o.pxMm);

  switch (a.kind) {
    case "length":
      return p.length >= 2 ? [{ ...base, value: mm(dist(p[0], p[1])), unit: "mm", quantity: QUANTITY.length }] : [];
    case "ellipsoid": {
      if (p.length < 2) return [];
      const d1 = mm(Math.abs(p[1].x - p[0].x));
      const d2 = mm(Math.abs(p[1].y - p[0].y));
      const d3 = f2(ellipsoidD3(a, d1, d2));
      const vol = (Math.PI / 6) * d1 * d2 * d3;
      return [
        { ...base, value: vol, unit: "mm3", quantity: QUANTITY.volume },
        { ...base, trackingId: `${id}#cap`, value: Math.max(d1, d2, d3), unit: "mm", quantity: QUANTITY.length },
      ];
    }
    case "rect": {
      if (p.length < 2) return [];
      // Dikdörtgen ölçümünde kısa/uzun kenar ayrı uzunluk olarak yazılır.
      const w = mm(Math.abs(p[1].x - p[0].x)), h = mm(Math.abs(p[1].y - p[0].y));
      return [
        { ...base, value: Math.max(w, h), unit: "mm", quantity: QUANTITY.length },
        { ...base, trackingId: `${id}#kisa`, value: Math.min(w, h), unit: "mm", quantity: QUANTITY.length },
      ];
    }
    case "ellipse": {
      // Elips ROI istatistikleri (HU) — ortalama yoğunluk ölçümü.
      const st = a.stats;
      if (!st) return [];
      return [{ ...base, value: f2(st.mean), unit: "hu", quantity: QUANTITY.mean }];
    }
    case "polygon": {
      // Kapalı çokgen: mm² değeri ayrı bir (standart olmayan) kavram olarak yazılır.
      if (p.length < 3) return [];
      let area = 0;
      for (let i = 0; i < p.length; i++) {
        const q = p[(i + 1) % p.length];
        area += p[i].x * q.y - q.x * p[i].y;
      }
      area = Math.abs(area) / 2 * o.pxMm * o.pxMm;
      return [{ ...base, value: f2(area), unit: "mm2", quantity: atikCode("AREA", "Alan") }];
    }
    default:
      // açı/Cobb/sapma/ok: sayısal izleme ölçümü değil (TID 1500'e yazılmaz)
      return [];
  }
}

/** Tüm ekran ölçümlerini TID 1500 listesine çevirir (ok/açı atlanır). */
export function annotationsToMeasurements(list: Annotation[], o: MeasureExportOptions): Measurement[] {
  const out: Measurement[] = [];
  let n = 0;
  for (const a of [...list].sort((x, y) => x.slice - y.slice)) {
    const ms = annotationToMeasurements(a, o, ++n);
    out.push(...ms);
  }
  return out;
}

/** Hangi ölçüm türlerinin yazıldığı/atlandığı — kullanıcıya özet. */
export function exportCoverage(list: Annotation[]): { used: number; skipped: string[] } {
  const skipped = new Set<string>();
  let used = 0;
  const label: Record<string, string> = { angle: "açı", cobb: "Cobb", deviation: "sapma", arrow: "ok" };
  for (const a of list) {
    if (["length", "ellipsoid", "rect", "ellipse", "polygon"].includes(a.kind)) used++;
    else skipped.add(label[a.kind] ?? a.kind);
  }
  return { used, skipped: [...skipped] };
}

/** Türkçe bölge adı → SNOMED CT kodu (yalnızca kesin eşleşmeler). */
const SITE_ALIASES: { key: string[]; code: Code }[] = [
  { key: ["toraks", "akciger", "akciğer", "göğüs", "thorax"], code: SITES.akciger },
  { key: ["beyin", "kafa", "brain"], code: SITES.beyin },
  { key: ["karaciger", "karaciğer", "liver"], code: SITES.karaciger },
];

/**
 * Bilinen bölge kodu veya 99ATIKVIEWER karşılığı.
 * Uydurma SNOMED kodu yazılmaz: eşleşme yoksa özel şema kullanılır.
 */
export function siteCode(name: string, codeTable?: CodeTable | null): Code {
  const key = (name || "").toLocaleLowerCase("tr-TR");
  const hit = SITE_ALIASES.find((a) => a.key.some((k) => key.includes(k)));
  const base = hit ? hit.code : atikCode("SITE", name || "belirtilmedi");
  // Kurum tablosu varsa terim adı üzerinden lisanslı koda çevir; yoksa davranış aynı.
  return mapTerm(name, base, codeTable).code as Code;
}

/**
 * Anotasyonlar → DICOM GSPS grafik nesneleri.
 *
 * Neden: PR (sunum durumu) çıktısı yalnız pencere/döndürme/çevirme taşıyordu;
 * ekrandaki ölçüm ve işaretler PR belgesine girmiyordu. Bu modül anotasyonları
 * GSPS'in **Graphic Object / Text Object** yapısına (PIXEL biriminde) çevirir.
 *
 * Sınırlar:
 *  - Koordinatlar görüntü piksel uzayındadır (mm değil); GSPS zaten böyle tanımlar.
 *  - Kalibrasyon/açı gibi ölçümler yalnız geometri olarak yazılır; sayısal değer
 *    metin olarak eklenmez (rapor SR'ında sayı vardır).
 *  - Kesit ↔ SOP Instance eşleşmesi yoksa (örnek vaka/UID'siz görüntü) o anotasyon atlanır.
 */
import type { Annotation } from "./types";

export type GspsGraphicType = "POLYLINE" | "CIRCLE" | "ELLIPSE" | "POINT";

export interface GspsGraphic {
  type: GspsGraphicType;
  /**
   * Piksel koordinatları, standarda **tam uyumlu** düzen:
   *  - POLYLINE: [x1,y1, x2,y2, …] (kapalı şekilde ilk nokta sonda tekrar eder)
   *  - POINT:    [x,y]
   *  - CIRCLE:   [cx,cy, rx, ry]  (DICOM PS3.3 C.10.5)
   *  - ELLIPSE:  [cx,cy, 1, 0, 0, 1, 0, 0]  — merkez + iki yarı-eksen ucu
   *              (DICOM PS3.3 C.10.6). Eski sürüm sınırlayıcı dikdörtgenin dört
   *              köşesini yazıyordu; DICOM okuyucuları bunu elips sanıp
   *              şekli bozuyordu.
   */
  data: number[];
}

export interface GspsText {
  text: string;
  anchor: [number, number];
}

export interface GspsAnnotationItem {
  slice: number;
  graphics: GspsGraphic[];
  texts: GspsText[];
  /** Anotasyon türü — geri okumada tam eşleşme için Graphic Layer kimliğine yazılır. */
  kind: Annotation["kind"];
  /** DICOM Graphic Layer (0070,0002) kimliği; CS ≤ 16 karakter. */
  layer: string;
}

/**
 * Anotasyon türü → Graphic Layer kimliği.
 * Graphic Layer **standart** bir alandır (DICOM PS3.3 C.10.7); başka görüntüleyiciler
 * katmanı görmezden gelir, kendi yazdığımız PR'ı biz tam olarak geri okuyabiliriz.
 * Böylece "hangi çizim uzunluk, hangisi Cobb" bilgisi geometriden tahmin edilmez.
 */
export const KIND_LAYER: Record<Annotation["kind"], string> = {
  length: "LENGTH", angle: "ANGLE", cobb: "COBB", arrow: "ARROW", rect: "RECT",
  ellipse: "ELLIPSE", polygon: "POLY", calib: "CALIB", ellipsoid: "ELLIPSOID",
  deviation: "DEVIATION", msk: "MSK",
};

export const LAYER_KIND: Record<string, Annotation["kind"]> = Object.fromEntries(
  (Object.entries(KIND_LAYER) as [Annotation["kind"], string][]).map(([k, v]) => [v, k]),
) as Record<string, Annotation["kind"]>;

const round2 = (v: number) => Math.round(v * 100) / 100;

function bbox(points: { x: number; y: number }[]): { x1: number; y1: number; x2: number; y2: number } | null {
  const p = points.filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y));
  if (p.length < 2) return null;
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Tek anotasyonu GSPS grafik nesnesine çevirir; çizilemezse null. */
export function annotationToGraphic(a: Annotation): GspsGraphic | null {
  const pts = (a.points ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (pts.length === 0) return null;

  if (a.kind === "ellipse" || a.kind === "ellipsoid") {
    const b = bbox(pts);
    if (!b) return null;
    // DICOM PS3.3 C.10.6 ELLIPSE: [cx, cy, x1, y1, x2, y2]. Merkezden yarı-eksen
    // uçlarına iki vektör. Eksen-hizalı elipste uçlar (cx+rx, cy) ve (cx, cy+ry).
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    const rx = (b.x2 - b.x1) / 2;
    const ry = (b.y2 - b.y1) / 2;
    if (!(rx > 0) || !(ry > 0)) return null; // sıfır yarı-eksenli elips çizilemez
    return { type: "ELLIPSE", data: [cx, cy, cx + rx, cy, cx, cy + ry].map(round2) };
  }
  if (a.kind === "rect") {
    const b = bbox(pts);
    if (!b) return null;
    // Kapalı POLYLINE (ilk nokta tekrar eder).
    const d = [b.x1, b.y1, b.x2, b.y1, b.x2, b.y2, b.x1, b.y2, b.x1, b.y1];
    return { type: "POLYLINE", data: d.map(round2) };
  }
  if (a.kind === "polygon") {
    if (pts.length < 3) return null;
    const d = pts.flatMap((p) => [p.x, p.y]);
    d.push(pts[0].x, pts[0].y);
    return { type: "POLYLINE", data: d.map(round2) };
  }
  // Uzunluk, açı, Cobb, ok, kalibrasyon, sapma, MSK: açık POLYLINE.
  if (pts.length < 2) return { type: "POINT", data: [round2(pts[0].x), round2(pts[0].y)] };
  return { type: "POLYLINE", data: pts.flatMap((p) => [p.x, p.y]).map(round2) };
}

/** Anotasyon listesini GSPS öğelerine böler (her anotasyon tek öğe; metin varsa eklenir). */
export function annotationsToGsps(annotations: Annotation[]): GspsAnnotationItem[] {
  const out: GspsAnnotationItem[] = [];
  for (const a of annotations) {
    const graphic = annotationToGraphic(a);
    if (!graphic) continue;
    const p0 = a.points?.find((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    const texts: GspsText[] = [];
    const label = (a.text ?? "").trim();
    if (label && p0) texts.push({ text: label.slice(0, 256), anchor: [round2(p0.x), round2(p0.y)] });
    out.push({ slice: a.slice, graphics: [graphic], texts, kind: a.kind, layer: KIND_LAYER[a.kind] ?? "ANNOT" });
  }
  return out;
}

/** Yazılabilecek (SOP UID'si eşleşen) anotasyon sayısı — kullanıcıya bilgi için. */
export function writableAnnotationCount(annotations: Annotation[], sopUids: string[]): number {
  return annotationsToGsps(annotations).filter((i) => !!sopUids[i.slice]).length;
}

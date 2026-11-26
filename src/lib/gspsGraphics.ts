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
  /** [x1,y1,x2,y2,...] — piksel koordinatları. */
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
}

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
    // DICOM ELLIPSE: sınırlayıcı dikdörtgenin dört köşesi.
    return { type: "ELLIPSE", data: [b.x1, b.y1, b.x1, b.y2, b.x2, b.y1, b.x2, b.y2].map(round2) };
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
    out.push({ slice: a.slice, graphics: [graphic], texts });
  }
  return out;
}

/** Yazılabilecek (SOP UID'si eşleşen) anotasyon sayısı — kullanıcıya bilgi için. */
export function writableAnnotationCount(annotations: Annotation[], sopUids: string[]): number {
  return annotationsToGsps(annotations).filter((i) => !!sopUids[i.slice]).length;
}

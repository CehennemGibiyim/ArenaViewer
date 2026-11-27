/**
 * DICOM GSPS (Presentation State) → uygulama ölçümleri (m-persist).
 *
 * Neden: PR/GSPS belgesi **okunuyor ve çiziliyordu**, ama içindeki ölçümler
 * çalışma durumuna (`study_state`) alınmıyordu. Yani başka bir istasyonda
 * çizilmiş ROI/uzunluk çalışma listesine, ölçüm tablosuna ve rapora girmiyordu.
 * Bu modül grafik nesnelerini `Annotation` yapısına çevirir; kaydetme/yükleme
 * mevcut `/api/state` hattıyla yapılır.
 *
 * Dürüst sınırlar:
 *  - Yalnız GSPS'te **standart** tanımlı geometriler desteklenir: POINT, POLYLINE,
 *    CIRCLE, ELLIPSE. INTERPOLATED ve dış üreticilerin özel grafik türleri
 *    **tahmin edilmeden** atlanır ve sayısı raporlanır.
 *  - Metin nesneleri ölçüme dönüşmez; yalnız ok sayısı olarak raporlanır.
 *  - POLYLINE'dan uzunluk/açı/Cobb **geri hesaplanmaz** (hangi köşenin açı olduğu
 *    belirsizdir); çokgen olarak alınır, tür katman kimliğinden gelir.
 *  - Kesit eşleşmesi SOP Instance UID ile yapılır (0008,1140 → 0008,1155);
 *    eşleşme yoksa **tahmin edilmez**, atlanır.
 *  - ROI istatistikleri (ort/SS/min/maks) GSPS'te taşınmaz; içe aktarılan
 *    ölçümlerde `stats` boş kalır (uydurma değer üretilmez).
 */
import type { Annotation, AnnotationKind, DicomGSPS, GSPSGraphicObject } from "./types";
import { LAYER_KIND } from "./gspsGraphics";

export interface GspsImportResult {
  annotations: Omit<Annotation, "id">[];
  /** Grafik nesnesi sayısı (belgede bulunan) */
  graphics: number;
  /** Ölçüme çevrilemeyen grafik sayısı (desteklenmeyen tür / eşleşmeyen kesit) */
  skipped: number;
  /** Metin nesnesi sayısı (ölçüme çevrilmez) */
  texts: number;
  /** Kullanıcıya gösterilecek kısa notlar */
  notes: string[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** SOP Instance UID → kesit indeksi (serideki sıraya göre). */
export function sopUidIndex(sopUids: (string | undefined)[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  (sopUids ?? []).forEach((u, i) => {
    const k = (u ?? "").trim();
    if (k && !map.has(k)) map.set(k, i);
  });
  return map;
}

/**
 * Standart GSPS geometrisi → nokta listesi.
 *  - POINT:    [x,y]
 *  - CIRCLE:   [cx,cy,rx,ry] → iki noktalı elips (Viewport bu biçimi çizer)
 *  - ELLIPSE:  [cx,cy, x1,y1, x2,y2] → yarı-eksen uçlarından sınırlayıcı kutu
 *  - POLYLINE: ardışık çiftler; kapalı şekilde ilk nokta sonda tekrar eder → atılır
 */
export function graphicToPoints(g: GSPSGraphicObject): { x: number; y: number }[] | null {
  const d = (g.data ?? []).filter((v) => Number.isFinite(v));
  const pt = (i: number) => ({ x: round2(d[i]), y: round2(d[i + 1]) });
  switch (g.type) {
    case "POINT":
      return d.length >= 2 ? [pt(0)] : null;
    case "CIRCLE": {
      if (d.length < 4) return null;
      const [cx, cy, rx, ry] = d;
      if (!(Math.abs(rx) > 0) || !(Math.abs(ry) > 0)) return null;
      return [{ x: round2(cx - Math.abs(rx)), y: round2(cy - Math.abs(ry)) },
        { x: round2(cx + Math.abs(rx)), y: round2(cy + Math.abs(ry)) }];
    }
    case "ELLIPSE": {
      if (d.length < 6) return null;
      const [cx, cy, x1, y1, x2, y2] = d;
      const ex = Math.max(Math.abs(x1 - cx), Math.abs(x2 - cx));
      const ey = Math.max(Math.abs(y1 - cy), Math.abs(y2 - cy));
      if (!(ex > 0) || !(ey > 0)) return null;
      return [{ x: round2(cx - ex), y: round2(cy - ey) }, { x: round2(cx + ex), y: round2(cy + ey) }];
    }
    case "POLYLINE": {
      if (d.length < 4) return null;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i + 1 < d.length; i += 2) pts.push(pt(i));
      // Kapalı şekil: son nokta ilk noktayla aynıysa tekrarı at.
      while (pts.length > 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) pts.pop();
        else break;
      }
      return pts.length >= 2 ? pts : null;
    }
    default:
      return null; // INTERPOLATED vb. — tahmin edilmez
  }
}

/** Katman kimliği yoksa (dış PR) geometriden tür çıkarımı — asgari, dürüst varsayım. */
function inferKind(g: GSPSGraphicObject, pts: { x: number; y: number }[]): AnnotationKind {
  if (g.type === "ELLIPSE" || g.type === "CIRCLE") return "ellipse";
  if (g.type === "POINT" || pts.length === 1) return "arrow";
  if (pts.length === 2) return "length";
  if (pts.length === 3) return "angle";
  return "polygon";
}

/**
 * GSPS belgesini ölçümlere çevirir.
 * @param gsps   Okunmuş sunum durumu
 * @param sopUids Serinin kesit sırasına göre SOP Instance UID listesi
 */
export function gspsToAnnotations(gsps: DicomGSPS, sopUids: (string | undefined)[] | undefined): GspsImportResult {
  const result: GspsImportResult = { annotations: [], graphics: 0, skipped: 0, texts: gsps.texts?.length ?? 0, notes: [] };
  const index = sopUidIndex(sopUids);
  const refs = gsps.referenceSopUids ?? [];
  const layers = gsps.layers ?? [];

  if (index.size === 0) {
    result.notes.push("Seride SOP Instance UID yok — GSPS ölçümleri kesitlere bağlanamadı, hiçbiri alınmadı.");
    result.skipped = gsps.graphics?.length ?? 0;
    return result;
  }

  let noRef = 0;
  (gsps.graphics ?? []).forEach((g, i) => {
    result.graphics++;
    const pts = graphicToPoints(g);
    if (!pts) { result.skipped++; return; }
    const uid = (refs[i] ?? "").trim();
    const slice = uid ? index.get(uid) : undefined;
    if (slice === undefined) { result.skipped++; if (!uid) noRef++; return; }
    const layerKind = LAYER_KIND[(layers[i] ?? "").toUpperCase()];
    const kind = layerKind ?? inferKind(g, pts);
    // Çokgen en az 3 nokta, uzunluk/açı beklenen nokta sayısı ister; uymayanı türüyle bozmayız.
    if (kind === "polygon" && pts.length < 3) { result.skipped++; return; }
    if (kind === "length" && pts.length !== 2) { result.skipped++; return; }
    if ((kind === "angle" || kind === "cobb") && pts.length < 3) { result.skipped++; return; }
    const label = gsps.texts?.find((t) => t.referenceSopUid && t.referenceSopUid === uid && t.anchorPoint)?.text?.trim();
    result.annotations.push({ kind, slice, points: pts, ...(label ? { text: label.slice(0, 200) } : {}) });
  });

  if (noRef > 0) result.notes.push(`${noRef} grafik nesnesinde görüntü referansı (0008,1140) yok — kesit bilinmediği için atlandı.`);
  if (result.skipped > 0) result.notes.push(`${result.skipped} grafik nesnesi ölçüme çevrilemedi (desteklenmeyen tür ya da eşleşmeyen kesit).`);
  if (result.texts > 0) result.notes.push(`${result.texts} metin nesnesi ölçüme çevrilmez (yalnız grafikler alınır).`);
  if (result.annotations.length > 0) result.notes.push("GSPS'te ROI istatistikleri (ort/SS/min/maks) taşınmaz; içe aktarılan ölçümlerde bu değerler boştur.");
  return result;
}

/** Seriye ait PR'lar arasından ölçüm üreten ilk belgeyi seçer (UID eşleşmesi ya da sıra). */
export function pickPresentationState(gspsList: DicomGSPS[] | undefined, seriesUid: string): DicomGSPS | null {
  const list = (gspsList ?? []).filter((g) => (g.graphics?.length ?? 0) > 0);
  if (list.length === 0) return null;
  const matching = list.filter((g) => g.presentedSeriesUid && g.presentedSeriesUid === seriesUid);
  return matching[0] ?? list[0];
}

/** Aynı ölçüm iki kez eklenmesin diye geometrik imza (tür + kesit + noktalar). */
function annotationKey(a: Pick<Annotation, "kind" | "slice" | "points">): string {
  return `${a.kind}|${a.slice}|${a.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(";")}`;
}

/**
 * İçe aktarılan ölçümleri mevcut listeye ekler; **birebir aynı** ölçüm ikinci kez
 * eklenmez (aynı PR iki kez alınırsa kopya oluşmaz). Dönen `added` yeni ölçümlerdir.
 */
export function mergeGspsAnnotations(
  existing: Pick<Annotation, "kind" | "slice" | "points">[],
  incoming: Omit<Annotation, "id">[],
): { added: Omit<Annotation, "id">[]; duplicates: number } {
  const seen = new Set(existing.map(annotationKey));
  const added: Omit<Annotation, "id">[] = [];
  let duplicates = 0;
  for (const a of incoming) {
    const k = annotationKey(a);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    added.push(a);
  }
  return { added, duplicates };
}

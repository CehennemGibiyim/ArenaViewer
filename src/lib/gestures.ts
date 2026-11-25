/**
 * Dokunmatik jest çekirdeği (v-multimon) — saf ve test edilebilir.
 *
 * Tarayıcı olaylarından bağımsız çalışır: iki parmak temas noktasından mesafe
 * ve merkez, ardından adım başına zoom çarpanı ve kaydırma deltası üretir.
 * `Viewport` bu sonuçları `onZoom` / `onPan` geri çağrılarına bağlar.
 */

export interface Pt {
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 12;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export interface Pinch {
  /** İki parmak arasındaki mesafe (ekran pikseli). */
  dist: number;
  /** Temas noktalarının orta noktası (ekran pikseli). */
  cx: number;
  cy: number;
}

/** İlk iki temas noktasından kıstırma durumu; iki nokta yoksa `null`. */
export function pinchOf(points: Pt[]): Pinch | null {
  if (points.length < 2) return null;
  const [a, b] = points;
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

export interface GestureStep {
  /** Zoom çarpanı (1 = değişmedi). */
  zoom: number;
  /** Kaydırma deltası (ekran pikseli). */
  dx: number;
  dy: number;
}

/** Çok küçük mesafelerde bölme kaynaklı sıçramayı önleyen taban. */
const MIN_DIST = 12;

/**
 * İki kıstırma durumu arasındaki adım. Mesafe ölçülemiyorsa zoom 1 döner
 * (yalnız kaydırma uygulanır) — parmaklar üst üste geldiğinde görüntü atlamaz.
 */
export function gestureStep(prev: Pinch | null, next: Pinch | null): GestureStep {
  if (!next) return { zoom: 1, dx: 0, dy: 0 };
  const dx = prev ? next.cx - prev.cx : 0;
  const dy = prev ? next.cy - prev.cy : 0;
  if (!prev || prev.dist < MIN_DIST || next.dist < MIN_DIST) return { zoom: 1, dx, dy };
  const raw = next.dist / prev.dist;
  // Tek karede aşırı sıçramayı engelle (ör. parmak kalkıp yeniden konunca).
  const zoom = Math.min(2.5, Math.max(0.4, raw));
  return { zoom, dx, dy };
}

/**
 * Adımı mevcut görünüm durumuna uygular: pan ekran pikseli olarak birikir,
 * zoom sınırlanır. Saf — `Viewport` yalnız sonucu yazar.
 */
export function applyGesture(
  state: { zoom: number; pan: Pt },
  step: GestureStep
): { zoom: number; pan: Pt } {
  return {
    zoom: clampZoom(state.zoom * step.zoom),
    pan: { x: state.pan.x + step.dx, y: state.pan.y + step.dy },
  };
}

/** Dokunmatik girdide tek parmak kaydırması varsayılan aracı geçersiz kılar mı? */
export function touchToolOverride(pointerType: string, activePointers: number): "pan" | null {
  if (pointerType !== "touch") return null;
  // İki parmak: jest modu (kıstırma + kaydırma) — araç ne olursa olsun.
  if (activePointers >= 2) return "pan";
  // Tek parmak: kaydırma (mobil DICOM okuyucuların yaygın davranışı).
  return "pan";
}

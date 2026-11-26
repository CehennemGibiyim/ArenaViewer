/**
 * VR kırpma düzlemi — v-vr "Kalan: kesme düzlemi/kırpma kutusu" maddesi.
 *
 * WebGL ışın izlemede (VolumeRender.tsx) örneklenen her ışının "attığı" tarafındaki
 * vokseller atlanır. Shader yalnızca aşağıdaki sözleşmeye uyar; `keepPoint` ile
 * birebir aynı eşitsizliği içerir (kaynak denetimi tests/vr-clip.test.ts).
 *
 * Nesne uzayı birimleri: q ∈ [-uHalf, +uHalf]; eksen 0=X (sağ/sol), 1=Y (üst/alt, kesit yönü), 2=Z (ön/arka, sözcele derinlği).
 * axis = -1 → kırpma kapalı (her nokta kabul edilir).
 */

export type ClipAxis = -1 | 0 | 1 | 2;

export interface VrClip {
  axis: ClipAxis;
  /** Düzlemin nesne uzayındaki konumu (axis === -1 iken 0). */
  pos: number;
  /** false → `a <= pos` tarafı kalır (ön taraf atılır); true → `a >= pos` tarafı kalır. */
  flip: boolean;
}

/** 0–100 aralığındaki kaydırıcı konumunu nesne uzayına çevirir. */
export function resolveClip(axis: number, pct: number, flip: boolean, half: readonly [number, number, number]): VrClip {
  const a: ClipAxis = axis === 0 || axis === 1 || axis === 2 ? axis : -1;
  if (a === -1) return { axis: -1, pos: 0, flip: false };
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 50;
  const h = Math.abs(half[a]);
  return { axis: a, pos: ((p / 100) * 2 - 1) * h, flip: !!flip };
}

/** Tek nokta sözleşmesi — GLSL'deki `uClipAxis/uClipPos/uClipFlip` mantığının aynısı. */
export function keepPoint(clip: VrClip, x: number, y: number, z: number): boolean {
  if (clip.axis === -1) return true;
  const a = clip.axis === 0 ? x : clip.axis === 1 ? y : z;
  return clip.flip ? a >= clip.pos : a <= clip.pos;
}

/** uHalf hesabı (VolumeRender.draw ile aynı): (genişlik, kesit, yükseklik) yarı-uzantıları, en büyük `ext`'e normalize. */
export function halfExtents(wVoxels: number, hVoxels: number, nSlices: number, sxMm: number, syMm: number, szMm: number): [number, number, number] {
  const ext = Math.max(wVoxels * sxMm, hVoxels * syMm, nSlices * szMm);
  return [(wVoxels * sxMm) / ext / 2, (nSlices * szMm) / ext / 2, (hVoxels * syMm) / ext / 2];
}

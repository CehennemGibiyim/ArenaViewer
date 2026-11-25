/**
 * Füzyon için **katı (rijit) in-plane hizalama** — öteleme + döndürme + izotropik ölçek.
 *
 * Amaç: PET/BT veya MR/MR bindirmesinde hasta koordinatları tam örtüşmediğinde
 * (farklı çekim, farklı maske konumu, hasta hareketi) ikinci seriyi hekimin
 * elle veya otomatik olarak kaydırması. Dönüşüm **hedef kesit piksel uzayında**
 * tanımlıdır: içerik +dx/+dy kayar, merkez çevresinde `rotDeg` döner ve
 * `scale` ile büyür.
 *
 * Yöntem: kabadan inceye normalize çapraz korelasyon (NCC) taraması. Her aday
 * dönüşüm uygulanır, yalnız örtüşen piksellerde Pearson korelasyonu hesaplanır.
 *
 * Dürüst sınırlar:
 *  - Yalnız **2B kesit içi katı** dönüşüm. Kesitler arası (z) kayma, eğim ve
 *    **deformable/elastik** kayıt YOKTUR; TIC (zaman-yoğunluk) eğrileri ayrı iştir.
 *  - Farklı modaliteler arasında (BT↔MR) NCC güvenilir değildir; düşük skorda
 *    sonuç "güvenilmez" sayılır ve klinik kullanım için önerilmez.
 *  - Sonuç tanı aracı değildir; hekim görsel doğrulaması zorunludur.
 */
import { downsample, nccMasked } from "./registration";

export interface RigidParams {
  /** Yatay kayma (hedef kesit pikseli, + = sağa). */
  dx: number;
  /** Dikey kayma (hedef kesit pikseli, + = aşağı). */
  dy: number;
  /** Merkez çevresinde dönme (derece, + = ekranda saat yönünün tersi). */
  rotDeg: number;
  /** İzotropik ölçek (1 = aynı boyut). */
  scale: number;
}

export const IDENTITY_RIGID: RigidParams = Object.freeze({ dx: 0, dy: 0, rotDeg: 0, scale: 1 });

/** Bu skorun altındaki hizalama güvenilir sayılmaz (füzyon bindirmesi için). */
export const MIN_RIGID_SCORE = 0.35;

const MAX_SHIFT_PX = 200;
const MAX_ROT_DEG = 45;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.25;

/** Değerleri güvenli aralıklara kırpar; eksik alanlar kimlik değerini alır. */
export function normalizeRigid(r: Partial<RigidParams> | null | undefined): RigidParams {
  const f = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    dx: clamp(f(r?.dx, 0), -MAX_SHIFT_PX, MAX_SHIFT_PX),
    dy: clamp(f(r?.dy, 0), -MAX_SHIFT_PX, MAX_SHIFT_PX),
    rotDeg: clamp(f(r?.rotDeg, 0), -MAX_ROT_DEG, MAX_ROT_DEG),
    scale: clamp(f(r?.scale, 1), MIN_SCALE, MAX_SCALE),
  };
}

/** Dönüşüm kimlik mi (bindirme değişmez)? */
export function isIdentityRigid(r: Partial<RigidParams> | null | undefined): boolean {
  if (!r) return true;
  const n = normalizeRigid(r);
  return Math.abs(n.dx) < 1e-6 && Math.abs(n.dy) < 1e-6 && Math.abs(n.rotDeg) < 1e-6 && Math.abs(n.scale - 1) < 1e-6;
}

/** Önbellek anahtarı (0.01 piksel / 0.01° duyarlılık). */
export function rigidKey(r: Partial<RigidParams> | null | undefined): string {
  if (isIdentityRigid(r)) return "id";
  const n = normalizeRigid(r);
  return `${n.dx.toFixed(2)},${n.dy.toFixed(2)},${n.rotDeg.toFixed(2)},${n.scale.toFixed(3)}`;
}

/** Hedef piksel (x,y) için kaynak görüntüde örneklenecek koordinat (ters dönüşüm). */
export function rigidSourceXY(x: number, y: number, w: number, h: number, r: RigidParams): { sx: number; sy: number } {
  const cx = w / 2, cy = h / 2;
  const th = (r.rotDeg * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const u = x - cx - r.dx, v = y - cy - r.dy;
  const s = Math.abs(r.scale) > 1e-6 ? r.scale : 1;
  // Ters dönüşüm: içerik +rotDeg kadar saat yönünün tersine döner.
  return { sx: (u * cos - v * sin) / s + cx, sy: (u * sin + v * cos) / s + cy };
}

/**
 * Kaynağı hedef ızgaraya katı dönüşümle yeniden örnekler (bilineer).
 * Görüntü dışına düşen pikseller NaN olur (füzyonda şeffaf kalır).
 */
export function applyRigid(src: ArrayLike<number>, w: number, h: number, r: RigidParams): Float32Array {
  const out = new Float32Array(w * h);
  const n = normalizeRigid(r);
  if (isIdentityRigid(n)) {
    for (let i = 0; i < w * h; i++) out[i] = i < src.length ? src[i] : NaN;
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { sx, sy } = rigidSourceXY(x + 0.5, y + 0.5, w, h, n);
      const fx = sx - 0.5, fy = sy - 0.5;
      if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) {
        out[y * w + x] = NaN;
        continue;
      }
      const x0 = Math.min(w - 2, Math.floor(fx)), y0 = Math.min(h - 2, Math.floor(fy));
      const ax = fx - x0, ay = fy - y0;
      const v00 = src[y0 * w + x0], v10 = src[y0 * w + x0 + 1], v01 = src[(y0 + 1) * w + x0], v11 = src[(y0 + 1) * w + x0 + 1];
      const v = v00 * (1 - ax) * (1 - ay) + v10 * ax * (1 - ay) + v01 * (1 - ax) * ay + v11 * ax * ay;
      out[y * w + x] = Number.isFinite(v) ? v : NaN;
    }
  }
  return out;
}

/** İki katı dönüşümü birleştirir (önce `b`, sonra `a` uygulanır — MVP sırası). */
export function composeRigid(a: RigidParams, b: RigidParams): RigidParams {
  const A = normalizeRigid(a), B = normalizeRigid(b);
  const ta = (A.rotDeg * Math.PI) / 180, tb = (B.rotDeg * Math.PI) / 180;
  const th = ta + tb;
  const s = A.scale * B.scale;
  // A ∘ B ötelemesi: A.scale·R(A)·(B.dx, B.dy) + (A.dx, A.dy)
  const ca = Math.cos(ta), sa = Math.sin(ta);
  const bx = B.dx * A.scale, by = B.dy * A.scale;
  return normalizeRigid({
    dx: ca * bx - sa * by + A.dx,
    dy: sa * bx + ca * by + A.dy,
    rotDeg: (th * 180) / Math.PI,
    scale: s,
  });
}

export interface RigidEstimate {
  rigid: RigidParams;
  score: number;
  /** Kullanılan en ince indirgeme kademesi (1 = tam çözünürlük). */
  level: number;
  /** Değerlendirilen aday sayısı. */
  candidates: number;
}

export interface RigidOptions {
  /** En büyük kayma (tam çözünürlük pikseli). */
  maxShift?: number;
  /** En büyük dönme (derece). */
  maxRotDeg?: number;
  /** Taranacak ölçekler (1 = yalnız öteleme+dönme). */
  scales?: number[];
  /** Altında korelasyon hesaplanmayacak örtüşme oranı. */
  minOverlap?: number;
}

/**
 * Katı hizalamayı kabadan inceye kestirir.
 *
 * `ref` referans (ana seri kesiti), `mov` hizalanacak kesit — aynı ızgarada
 * olmalıdır (`resampleOnto` çıktısı). NaN'li pikseller `mov` içinde geçersiz
 * sayılır (örtüşme maskesi).
 */
export function estimateRigid(
  ref: ArrayLike<number>,
  mov: ArrayLike<number>,
  w: number,
  h: number,
  opts: RigidOptions = {}
): RigidEstimate {
  const maxShift = Math.max(0, Math.min(MAX_SHIFT_PX, opts.maxShift ?? 30));
  const maxRot = Math.max(0, Math.min(MAX_ROT_DEG, opts.maxRotDeg ?? 15));
  const scales = (opts.scales && opts.scales.length ? opts.scales : [1]).map((s) => normalizeRigid({ scale: s }).scale);
  const minOverlap = Math.max(0.05, Math.min(0.95, opts.minOverlap ?? 0.25));

  let best: RigidEstimate = { rigid: normalizeRigid({}), score: -1, level: 1, candidates: 0 };
  let candidates = 0;

  // Kademeler: 512² için 4→2→1; 128–255 için 2→1; küçük görüntüde tek kademe.
  const levels = w >= 256 && h >= 256 ? [4, 2, 1] : w >= 128 ? [2, 1] : [1];
  for (let li = 0; li < levels.length; li++) {
    const f = levels[li];
    const rl = downsample(ref, w, h, f);
    const ml = downsample(mov, w, h, f);
    const last = li === levels.length - 1;
    // Kaba kademede geniş tarama; sonraki kademelerde en iyi adayın çevresinde ince.
    const rotRange = li === 0 ? maxRot : last ? 1 : Math.max(2, maxRot / 4);
    const shiftRange = li === 0 ? maxShift : last ? 2 : Math.max(3, maxShift / 5);
    const rotStep = li === 0 ? Math.max(1, Math.round(maxRot / 3) || 1) : 1;
    const shiftStep = li === 0 ? Math.max(2, Math.round(maxShift / 6)) : 1;
    const rotList = li === 0
      ? rangeStep(-rotRange, rotRange, rotStep)
      : rangeStep(best.rigid.rotDeg - rotRange, best.rigid.rotDeg + rotRange, rotStep);
    const dxList = li === 0
      ? rangeStep(-shiftRange, shiftRange, shiftStep)
      : rangeStep(best.rigid.dx - shiftRange, best.rigid.dx + shiftRange, shiftStep);
    const dyList = li === 0
      ? rangeStep(-shiftRange, shiftRange, shiftStep)
      : rangeStep(best.rigid.dy - shiftRange, best.rigid.dy + shiftRange, shiftStep);
    const scaleList = li === 0 ? scales : [best.rigid.scale || 1];
    for (const rotDeg of rotList) {
      for (const dx of dxList) {
        for (const dy of dyList) {
          for (const scale of scaleList) {
            // Aday parametreler **tam çözünürlük** pikselindedir; indirgenmiş
            // ızgarada kayma f ile ölçeklenir, dönme/ölçek değişmez.
            const cand = normalizeRigid({ dx, dy, rotDeg, scale });
            const aligned = applyRigid(ml.data, ml.w, ml.h, { dx: dx / f, dy: dy / f, rotDeg, scale });
            const mask = new Uint8Array(aligned.length);
            let valid = 0;
            for (let i = 0; i < aligned.length; i++) if (Number.isFinite(aligned[i])) { mask[i] = 1; valid++; }
            candidates++;
            if (valid < 64) continue;
            const { score, overlap } = nccMasked(rl.data, aligned, mask);
            if (overlap < minOverlap || score <= best.score) continue;
            best = { rigid: cand, score, level: f, candidates };
          }
        }
      }
      best = { ...best, candidates };
    }
  }
  if (best.score < 0) best = { rigid: normalizeRigid({}), score: 0, level: 1, candidates };
  return { ...best, candidates };
}

function rangeStep(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const s = Math.max(1e-6, step);
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  for (let v = a; v <= b + 1e-9; v += s) out.push(Number(v.toFixed(4)));
  if (!out.length) out.push(a);
  return out;
}

/** Skor güvenilir mi? */
export function rigidTrusted(e: { score: number }): boolean {
  return Number.isFinite(e.score) && e.score >= MIN_RIGID_SCORE;
}

/** Kullanıcıya gösterilecek durum cümlesi. */
export function rigidNote(e: RigidEstimate, trusted = rigidTrusted(e)): string {
  const { dx, dy, rotDeg, scale } = e.rigid;
  const p = `dx ${dx.toFixed(1)} px · dy ${dy.toFixed(1)} px · ${rotDeg.toFixed(1)}° · ölçek ${scale.toFixed(3)}`;
  return trusted
    ? `Katı hizalama: ${p} (NCC ${e.score.toFixed(2)}, ${e.candidates} aday). Hekim görsel doğrulaması gerekir.`
    : `Katı hizalama güvenilmez (NCC ${e.score.toFixed(2)} < ${MIN_RIGID_SCORE}). Öneri: ${p} — elle kontrol edin.`;
}

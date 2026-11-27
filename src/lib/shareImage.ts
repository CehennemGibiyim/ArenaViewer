/**
 * Görüntü paylaşımı (f-share) — süreli, filigranlı, denetimli **anonim kesit** paylaşımı.
 *
 * Neden: süreli paylaşım bugün yalnız rapor metnini + tek anahtar kesiti taşıyordu.
 * Klinikte "şu kesiti meslektaşıma/hastaya göster" en sık ihtiyaçtır; ham DICOM
 * paylaşmak ise kimlik ve ölçüm verisini dışarı çıkarır. Bu modül **yeniden
 * üretilmiş gri tonlamalı JPEG kesitleri** paylaşır:
 *
 * Dürüst sınırlar (tasarım gereği):
 *  - Ham DICOM **gönderilmez**; yalnız seçilen kesitlerin JPEG görüntüsü.
 *  - Hasta kimliği görüntüye **yakılmaz**; paket yalnız seri etiketi/modalite/tarih
 *    taşır (paylaşım sayfası anonim başlık gösterir).
 *  - Pencere/seviye (WL/WW) yalnız uygulama anında kullanılır, sunucuda kalır.
 *  - Görüntü sunucuda **gömülü olarak** (nesne depolamada) tutulur; süresi dolan ya da
 *    kapatılan bağlantının görüntü blob'u **silinir** (artık erişilemez).
 *  - Ölçüm/AI bulgusu paylaşılan kesite **çizilmez** — çizim yalnız rapor ekranında.
 *  - Bu bir teşhis aracı değildir; paylaşım sayfası "tanı için kullanılamaz" der.
 *
 * Bu dosya saf hesaplama/doğrulamadır; HTTP/DB/Depolama katmanı ayrıdır.
 */

/** Paylaşılabilir en fazla kesit sayısı (tek istekte). */
export const MAX_SHARE_IMAGES = 24;
/** Kesit başına en uzun kenar (piksel) ve JPEG kalitesi. */
export const SHARE_IMAGE_MAX_SIDE = 1024;
export const SHARE_IMAGE_QUALITY = 0.82;
/** Paket toplam bayt tavanı (base64 çözülmüş JPEG'ler). */
export const MAX_SHARE_IMAGE_BYTES = 6 * 1024 * 1024;
/** Tek kare için üst sınır. */
export const MAX_SHARE_FRAME_BYTES = 700 * 1024;

/** Nesne depolamadaki anahtar öneki. Token dışarıdan gelmez — yalnız üretilmiş token. */
export const SHARE_IMAGE_PREFIX = "share-image/";
export const shareImageKey = (token: string) => `${SHARE_IMAGE_PREFIX}${token}.json`;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export interface ShareImageFrame {
  /** Serideki kesit sırası (0 tabanlı) */
  slice: number;
  /** İstenen kare genişliği */
  width: number;
  height: number;
  /** JPEG bayt uzunluğu (base64 çözülmüş) */
  bytes: number;
}

export interface ShareImagePackage {
  version: 1;
  /** Seri etiketi (hasta adı yok) */
  label: string;
  modality: string;
  studyDate: string;
  sliceCount: number;
  frames: ShareImageFrame[];
  /** Base64 JPEG (data URL öneki YOK) — sırayla `frames` ile eşleşir */
  images: string[];
}

export interface BuildInput {
  label: string;
  modality: string;
  studyDate: string;
  /** `frames[i]` ile aynı sırada base64 JPEG */
  frames: { slice: number; width: number; height: number; b64: string }[];
}

const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[^\p{L}\p{N} ._\-/():,]/gu, "").trim().slice(0, max);

/** Base64'ün ilk baytlarının JPEG imzası olup olmadığı (HTML/script enjeksiyonunu eler). */
export function looksJpeg(b64: string): boolean {
  if (!b64 || b64.length < 12 || !B64.test(b64)) return false;
  try {
    const head = Buffer.from(b64.slice(0, 8), "base64");
    return head.length >= 3 && head[0] === JPEG_MAGIC[0] && head[1] === JPEG_MAGIC[1] && head[2] === JPEG_MAGIC[2];
  } catch {
    return false;
  }
}

export const jpegByteLength = (b64: string): number =>
  b64 ? Math.floor((b64.replace(/=+$/, "").length * 3) / 4) : 0;

/**
 * Paketi kurar ve **doğrular**. Herhangi bir kural ihlalinde `{ ok: false }` döner —
 * yarım/gevşek paket asla kaydedilmez.
 */
export function buildShareImagePackage(input: BuildInput): { ok: true; pkg: ShareImagePackage } | { ok: false; error: string } {
  const frames = Array.isArray(input.frames) ? input.frames : [];
  if (frames.length === 0) return { ok: false, error: "Paylaşılacak kesit seçilmedi." };
  if (frames.length > MAX_SHARE_IMAGES) return { ok: false, error: `En fazla ${MAX_SHARE_IMAGES} kesit paylaşılabilir.` };

  const out: ShareImageFrame[] = [];
  const images: string[] = [];
  let total = 0;
  for (const f of frames) {
    if (!Number.isInteger(f.slice) || f.slice < 0) return { ok: false, error: "Geçersiz kesit numarası." };
    if (!(f.width > 0) || !(f.height > 0)) return { ok: false, error: "Geçersiz kesit boyutu." };
    if (Math.max(f.width, f.height) > SHARE_IMAGE_MAX_SIDE) {
      return { ok: false, error: `Kesit en uzun kenarı ${SHARE_IMAGE_MAX_SIDE} pikseli aşamaz.` };
    }
    const b64 = (f.b64 ?? "").trim();
    if (!looksJpeg(b64)) return { ok: false, error: "Kesit JPEG değil ya da bozuk (base64/JPEG imzası doğrulanamadı)." };
    const bytes = jpegByteLength(b64);
    if (bytes > MAX_SHARE_FRAME_BYTES) return { ok: false, error: "Bir kesit boyut sınırını aşıyor." };
    total += bytes;
    if (total > MAX_SHARE_IMAGE_BYTES) return { ok: false, error: "Paket boyutu sınırı aşıldı; daha az kesit seçin." };
    out.push({ slice: f.slice, width: f.width, height: f.height, bytes });
    images.push(b64);
  }
  // Aynı kesit iki kez paylaşılmaz (yanlışlıkla kopya üretmeyi engeller).
  if (new Set(out.map((f) => f.slice)).size !== out.length) return { ok: false, error: "Aynı kesit birden fazla seçilmiş." };

  out.sort((a, b) => a.slice - b.slice);
  const order = [...images.keys()].sort((a, b) => frames[a].slice - frames[b].slice);
  return {
    ok: true,
    pkg: {
      version: 1,
      label: clean(input.label, 60) || "SERİ",
      modality: clean(input.modality, 16).toUpperCase() || "OT",
      studyDate: clean(input.studyDate, 16),
      sliceCount: out.length,
      frames: out,
      images: order.map((i) => images[i]),
    },
  };
}

/** Depodan okunan ham metni doğrular; bozuk/eski biçim `null` döner (uydurma yok). */
export function parseShareImagePackage(raw: string | null | undefined): ShareImagePackage | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  if (p.version !== 1) return null;
  if (!Array.isArray(p.frames) || !Array.isArray(p.images)) return null;
  if (p.frames.length === 0 || p.frames.length !== p.images.length || p.frames.length > MAX_SHARE_IMAGES) return null;
  const frames: ShareImageFrame[] = [];
  const images: string[] = [];
  let total = 0;
  for (let i = 0; i < p.frames.length; i++) {
    const f = p.frames[i] as Record<string, unknown>;
    const b64 = String(p.images[i] ?? "");
    if (!looksJpeg(b64)) return null;
    const bytes = jpegByteLength(b64);
    if (bytes > MAX_SHARE_FRAME_BYTES) return null;
    total += bytes;
    frames.push({
      slice: Number.isInteger(f.slice) ? (f.slice as number) : -1,
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      bytes,
    });
    images.push(b64);
  }
  if (total > MAX_SHARE_IMAGE_BYTES) return null;
  if (frames.some((f) => f.slice < 0 || f.width <= 0 || f.height <= 0)) return null;
  return {
    version: 1,
    label: clean(p.label, 60) || "SERİ",
    modality: clean(p.modality, 16).toUpperCase() || "OT",
    studyDate: clean(p.studyDate, 16),
    sliceCount: frames.length,
    frames,
    images,
  };
}

/** Paketten tek kare (1 tabanlı `n`) — sunucu ucunda `image/jpeg` olarak servis edilir. */
export function packageFrame(pkg: ShareImagePackage, n: number): { b64: string; meta: ShareImageFrame } | null {
  if (!Number.isInteger(n) || n < 1 || n > pkg.frames.length) return null;
  return { b64: pkg.images[n - 1], meta: pkg.frames[n - 1] };
}

/** Tek seçimde taranabilecek en geniş aralık (bellek koruması). */
export const MAX_SELECTION_SPAN = 4000;

/**
 * Paylaşım seçimi → seri kesit indeksleri. `from`/`to` kapalı aralık, 1 tabanlı.
 * **Adet sınırı burada uygulanmaz**: geniş aralık `uniformStride` ile seyreltilir
 * (çağıran `sampleSelection` kullanmalı). Geçersiz aralıkta `error` döner;
 * sessizce kırpılmaz.
 */
export function selectionToSlices(count: number, from: number, to: number): { slices: number[]; error?: string } {
  if (!Number.isInteger(count) || count <= 0) return { slices: [], error: "Seride kesit yok." };
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { slices: [], error: "Aralık sayı olmalı." };
  if (from < 1 || to < 1 || from > count || to > count) return { slices: [], error: `Aralık 1–${count} dışında.` };
  if (to < from) return { slices: [], error: "Bitiş, başlangıçtan küçük olamaz." };
  if (to - from + 1 > MAX_SELECTION_SPAN) return { slices: [], error: `Aralık çok geniş (en fazla ${MAX_SELECTION_SPAN} kesit).` };
  const slices: number[] = [];
  for (let s = from; s <= to; s++) slices.push(s - 1);
  return { slices };
}

/**
 * Seçimi **en fazla `MAX_SHARE_IMAGES` kesite** indirger: geniş aralıkta eşit
 * aralıklı örnekleme yapar, dar aralıkta hiçbir kesit atlanmaz.
 * Dönen `stride` kullanıcıya "her n. kesit" olarak gösterilir.
 */
export function sampleSelection(count: number, from: number, to: number, max = MAX_SHARE_IMAGES):
  { slices: number[]; stride: number; error?: string } {
  const sel = selectionToSlices(count, from, to);
  if (sel.error) return { slices: [], stride: 1, error: sel.error };
  const st = uniformStride(sel.slices.length, max);
  const slices = sel.slices.filter((_, i) => i % st.stride === 0).slice(0, max);
  return { slices, stride: st.stride };
}

/**
 * Kare adımı: uzun aralıklarda **eşit aralıklı alt örnekleme**.
 * Dönen `stride` ile seçim yapılır; kullanıcıya kaç kesitin atlandığı söylenir.
 */
export function uniformStride(count: number, max = MAX_SHARE_IMAGES): { stride: number; effective: number } {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return { stride: 1, effective: 0 };
  const stride = Math.max(1, Math.ceil(n / Math.max(1, max)));
  return { stride, effective: Math.ceil(n / stride) };
}

/** İnsan-okur boyut (paylaşım ekranında). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

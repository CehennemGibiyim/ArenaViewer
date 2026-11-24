/**
 * MSK/X-ışını ölçüm protokol kiti (a-msk).
 *
 * Amaç: sıklıkla istenen kemik/eklem ölçümlerini adlandırılmış anatomik
 * noktalar üzerinden hesaplamak ve aralık yorumu sunmak. Bu bir **tanısal model
 * değildir**: sonuçlar yalnızca "ölçüm yardımcısıdır" ve raporda bu şekilde
 * etiketlenmelidir. Kırık/landmark sınıflandırması ve heatmap için ayrı bir eğitim
 * verisi/modeli gerekir (bu sürümde yoktur).
 *
 * Tüm fonksiyonlar saf matematiktir; ekran pikseli yerine mm bazlı noktalar
 * bekler (Viewport piksel konumunu pxMm ile ölçekler).
 */
import { angleAt, dist, lineAngle, type Pt } from "./geometry";

export interface MskMetric {
  name: string;
  value: number;
  unit: "°" | "mm";
  /** Aralık dışı/şüpheli yorumu. */
  assessment: "normal" | "sınırda" | "anormal" | "yetersiz";
  note: string;
}

export interface MskPointDef {
  id: string;
  label: string;
  /** Tıklanacak anatomik yerin kısa tarifi. */
  hint: string;
}

export interface MskProtocol {
  id: string;
  title: string;
  bodyPart: string;
  /** Önerilen modalite (DX/BT/MR). */
  modality: string;
  points: MskPointDef[];
  compute: (p: Record<string, Pt>, pxMm: number) => MskMetric[];
}

const deg = (r: number) => (r * 180) / Math.PI;

/** İki doğru arası dar açı (yatay/dikey referans yok, piksel düzlemi). */
function lineToLineDeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  return lineAngle(a, b, c, d);
}

/** Noktanın doğrunun sağında/solunda kaldığı (işaretli) mesafe (mm). */
function signedPerp(a: Pt, b: Pt, p: Pt, pxMm: number): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return ((dy * (p.x - a.x) - dx * (p.y - a.y)) / len) * pxMm;
}

/** Noktalar görüntü piksellerindendir; mesafeler pxMm ile mm'e çevrilir. */
const get = (p: Record<string, Pt>, id: string): Pt => {
  const q = p[id];
  if (!q) throw new Error(`Eksik nokta: ${id}`);
  return q;
};

// ───────────── Protokoller ─────────────

const WRIST_PA: MskProtocol = {
  id: "wrist-pa",
  title: "El bileği AP (radiyal inklinasyon + ulnar varyans)",
  bodyPart: "EKSTREMİTE",
  modality: "DX",
  points: [
    { id: "shaftA", label: "Radial diafiz üst", hint: "Radius diaphysis medial kenar (proksimal)" },
    { id: "shaftB", label: "Radial diafiz alt", hint: "Radius diaphysis medial kenar (distal)" },
    { id: "styloid", label: "Radiyal stiloid", hint: "Stiloid proses ucu" },
    { id: "lunateCorner", label: "Lunatum ulnar köşe", hint: "Distal radius artiküler yüzeyin ulnar köşesi" },
    { id: "ulnarHead", label: "Ulna başı distal", hint: "Ulna başının distal eklem yüzeyi" },
  ],
  compute(p, pxMm) {
    const shaftA = get(p, "shaftA"), shaftB = get(p, "shaftB");
    const styloid = get(p, "styloid"), lunateCorner = get(p, "lunateCorner");
    const ulnarHead = get(p, "ulnarHead");
    // Radiyal inklinasyon: diafiz eksenine dik doğru ile stiloid–lunatum
    // köşesi doğrusu arasındaki dar açı (AP grafi).
    const shaftAng = Math.atan2(shaftB.y - shaftA.y, shaftB.x - shaftA.x) + Math.PI / 2;
    const artAng = Math.atan2(lunateCorner.y - styloid.y, lunateCorner.x - styloid.x);
    let inc = Math.abs(deg(artAng - shaftAng));
    inc = inc % 180;
    if (inc > 90) inc = 180 - inc;
    // Ulnar varyans: ulna başı ile distal radius çizgisi arası, diafize dik mesafe.
    const uv = Math.abs(signedPerp(styloid, lunateCorner, ulnarHead, pxMm));
    return [
      {
        name: "Radiyal inklinasyon", value: Math.round(inc * 10) / 10, unit: "°",
        assessment: inc >= 15 && inc <= 29 ? "normal" : inc < 15 ? "anormal" : "sınırda",
        note: "Normal ≈ 21–25°; distorsiyonda azalır.",
      },
      {
        name: "Ulnar varyans", value: Math.round(uv * 10) / 10, unit: "mm",
        assessment: uv <= 2 ? "normal" : uv <= 4 ? "sınırda" : "anormal",
        note: "|UV| ≤ 2 mm normal; >4 mm ulnar impaksiyonu düşündürür.",
      },
    ];
  },
};

const ANKLE: MskProtocol = {
  id: "ankle-boehler",
  title: "Ayak bileği (Böhler açısı + tibiofibular mesafe)",
  bodyPart: "AYAK BİLEĞİ",
  modality: "DX",
  points: [
    { id: "antProcess", label: "Kalkaneus ön süreç", hint: "Anterior tüberkül ucu" },
    { id: "postFacet", label: "Posterior faset tepe", hint: "Arka fasetin en yüksek noktası" },
    { id: "tuberosity", label: "Tüberkül ucu", hint: "Kalkaneal tüberkülün en arka noktası" },
    { id: "tibiaEdge", label: "Tibia plafon medial", hint: "Plafon medial kenar" },
    { id: "fibulaEdge", label: "Fibula medial kenar", hint: "Fibulanın medial kenarı (sıyırık)" },
  ],
  compute(p, pxMm) {
    const a = get(p, "antProcess"), b = get(p, "postFacet"), c = get(p, "tuberosity");
    const ti = get(p, "tibiaEdge"), fi = get(p, "fibulaEdge");
    const boehler = angleAt(a, b, c);
    const clear = Math.abs(dist(ti, fi) * pxMm);
    return [
      {
        name: "Böhler açısı", value: Math.round(boehler * 10) / 10, unit: "°",
        assessment: boehler >= 25 && boehler <= 40 ? "normal" : boehler < 25 ? "anormal" : "sınırda",
        note: "Normal 20–40°; <20° posterior faset kırığını düşündürür.",
      },
      {
        name: "Tibiofibular temiz mesafe", value: Math.round(clear * 10) / 10, unit: "mm",
        assessment: clear <= 6 ? "normal" : clear <= 10 ? "sınırda" : "anormal",
        note: "Plafon seviyesinde >6 mm sindesmoz yaralanmasını düşündürür.",
      },
    ];
  },
};

const FOOT_LATERAL: MskProtocol = {
  id: "foot-lateral",
  title: "Ayak lateral (Meary açısı + kalkaneal pitch)",
  bodyPart: "AYAK",
  modality: "DX",
  points: [
    { id: "talarNeckA", label: "Talar boynu üst", hint: "Talus boyun aksının üst noktası" },
    { id: "talarNeckB", label: "Talar boynu alt", hint: "Talus boyun aksının alt noktası" },
    { id: "met1A", label: "1. metatars üst", hint: "Birinci metatarsal aksının dorsal ucu" },
    { id: "met1B", label: "1. metatars alt", hint: "Birinci metatarsal aksının plantar ucu" },
  ],
  compute(p) {
    const ta = get(p, "talarNeckA"), tb = get(p, "talarNeckB");
    const ma = get(p, "met1A"), mb = get(p, "met1B");
    const meary = lineToLineDeg(ta, tb, ma, mb);
    const calcPitch = Math.abs(deg(Math.atan2(tb.y - ta.y, tb.x - ta.x)));
    return [
      {
        name: "Meary (talar–1. metatars) açısı", value: Math.round(meary * 10) / 10, unit: "°",
        assessment: meary <= 4 ? "normal" : meary <= 15 ? "sınırda" : "anormal",
        note: "Normal ≤4°; >4° pes planus (düz taban) lehine.",
      },
      {
        name: "Kalkaneal pitch (yaklaşık)", value: Math.round(calcPitch * 10) / 10, unit: "°",
        assessment: calcPitch >= 17 && calcPitch <= 25 ? "normal" : "sınırda",
        note: "Referans: 17–25°; tek başına tanı değildir.",
      },
    ];
  },
};

const HIP_AP: MskProtocol = {
  id: "hip-ap",
  title: "Kalça AP (CE açısı + asetabol indeksi)",
  bodyPart: "KALÇA",
  modality: "DX",
  points: [
    { id: "headCenter", label: "Femur baş merkezi", hint: "Femur başının geometrik merkezi" },
    { id: "latAcetab", label: "Asetabulum lateral kenar", hint: "Sourcil/labrum dış kenarı" },
    { id: "medTeardrop", label: "Medial Gülyaç (teardrop)", hint: "Medial duvarlandırıcı çizgi" },
    { id: "roofMid", label: "Asetabulum tavan orta", hint: "Asetabular tavanın orta noktası" },
  ],
  compute(p) {
    const hc = get(p, "headCenter"), la = get(p, "latAcetab"), mt = get(p, "medTeardrop"), rm = get(p, "roofMid");
    // CE açısı: merkezden dik (görsel yukarı) çizgi ile merkez–lateral kenar çizgisi arası.
    const vertical = { x: hc.x, y: hc.y - 1 };
    const ce = angleAt(vertical, hc, la);
    const ai = lineToLineDeg(mt, rm, hc, { x: hc.x, y: hc.y - 1 });
    return [
      {
        name: "CE (Wiberg) açısı", value: Math.round(ce * 10) / 10, unit: "°",
        assessment: ce >= 20 && ce <= 30 ? "normal" : ce < 20 ? "anormal" : "sınırda",
        note: "<20° displazi lehine; >40° köprüleme (pincer) lehine.",
      },
      {
        name: "Asetabular indeks (yaklaşık)", value: Math.round(ai * 10) / 10, unit: "°",
        assessment: ai <= 10 ? "normal" : ai <= 20 ? "sınırda" : "anormal",
        note: "Yetişkinlerde >10–15° açık lokalizasyon lehine yorulur.",
      },
    ];
  },
};

export const MSK_PROTOCOLS: MskProtocol[] = [WRIST_PA, ANKLE, FOOT_LATERAL, HIP_AP];

export function findMskProtocol(id: string): MskProtocol | null {
  return MSK_PROTOCOLS.find((p) => p.id === id) ?? null;
}

export const ASSESSMENT_LABEL: Record<MskMetric["assessment"], string> = {
  normal: "normal sınırlar içinde",
  sınırda: "sınırda — klinikle birlikte değerlendirilmeli",
  anormal: "anormal sınır — hekime bildirilmeli",
  yetersiz: "yetersiz veri",
};

/**
 * Görüntüdeki belirgin özelliğe yakın noktayı bulur ("nokta yapışması").
 * mode: "max" en parlak, "min" en koyu, "edge" en yüksek gradyan büyüklüğü.
 * Kapsam dışı girdide orijinal nokta döner.
 */
export function snapPoint(
  pixels: ArrayLike<number>,
  w: number,
  h: number,
  p: Pt,
  radius = 6,
  mode: "max" | "min" | "edge" = "edge",
): Pt {
  const cx = Math.round(p.x), cy = Math.round(p.y);
  let best: Pt = { x: p.x, y: p.y }, bestScore = -Infinity;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const i = y * w + x;
      const v = pixels[i];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      let score: number;
      if (mode === "max") score = v;
      else if (mode === "min") score = -v;
      else {
        const xr = Math.min(w - 1, x + 1), yb = Math.min(h - 1, y + 1);
        const gx = (pixels[y * w + xr] ?? 0) - v;
        const gy = (pixels[yb * w + x] ?? 0) - v;
        score = Math.hypot(gx, gy);
      }
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}

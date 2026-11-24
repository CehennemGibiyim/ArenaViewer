/**
 * MSK ölçüm protokol kiti testleri (a-msk).
 * Noktalar piksel indeksli sanal grafikte; pxMm = 2 mm/piksel varsayılır.
 */
import {
  ASSESSMENT_LABEL, findMskProtocol, MSK_PROTOCOLS, snapPoint,
} from "../src/lib/msk";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pt } from "../src/lib/geometry";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

// ── kayıt / etiketler ──
ok(MSK_PROTOCOLS.length >= 4, `protokol sayısı (${MSK_PROTOCOLS.length})`);
ok(findMskProtocol("wrist-pa")?.points.length === 5, "el bileği 5 nokta istiyor");
ok(findMskProtocol("yok") === null, "bilinmeyen protokol null");
ok(new Set(MSK_PROTOCOLS.map((p) => p.id)).size === MSK_PROTOCOLS.length, "protokol id'leri tekil");
ok(Object.values(ASSESSMENT_LABEL).every((v) => v.length > 3), "yorum etiketleri dolu");

// ── el bileği AP ──
const pxMm = 2;
// Dikey radiyal eksen (0,0)->(0,100); artiküler doğru ~20° eğimli:
const styloid: Pt = { x: -40, y: 80 }, lunateCorner: Pt = { x: 40, y: 140 };
const w = findMskProtocol("wrist-pa")!.compute({
  shaftA: { x: 0, y: 0 }, shaftB: { x: 0, y: 100 },
  styloid, lunateCorner, ulnarHead: { x: 60, y: 150 },
}, pxMm);
const inc = w.find((m) => m.name.startsWith("Radiyal"))!;
const uv = w.find((m) => m.name.includes("Ulnar"))!;
ok(near(inc.value, 36.9, 1), `radiyal inklinasyon ölçülüyor (${inc.value.toFixed(1)}°)`);
ok(inc.unit === "°" && uv.unit === "mm", "birimler doğru");
ok(uv.value > 0, `ulnar varyans pozitif mesafe (${uv.value.toFixed(1)} mm)`);

// ── ayak bileği ──
const a = findMskProtocol("ankle-boehler")!.compute({
  antProcess: { x: 0, y: 0 }, postFacet: { x: 20, y: 10 }, tuberosity: { x: 60, y: 0 },
  tibiaEdge: { x: 40, y: 40 }, fibulaEdge: { x: 48, y: 40 },
}, pxMm);
const bohler = a.find((m) => m.name.includes("Böhler"))!;
const clear = a.find((m) => m.name.includes("temiz"))!;
ok(near(bohler.value, angleDeg({ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 60, y: 0 }), 0.6), `Böhler açısı (${bohler.value.toFixed(1)}°)`);
ok(clear.value === 16, `tibiofibular mesafe pxMm ile mm'ye çevrilir (${clear.value} mm)`);
ok(a.every((m) => m.note.length > 8), "her ölçüm için yorum notu var");

function angleDeg(a1: Pt, b1: Pt, c1: Pt): number {
  const v1 = { x: a1.x - b1.x, y: a1.y - b1.y }, v2 = { x: c1.x - b1.x, y: c1.y - b1.y };
  return (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y))))) * 180) / Math.PI;
}

// ── ayak lateral ──
const f = findMskProtocol("foot-lateral")!.compute({
  talarNeckA: { x: 0, y: 0 }, talarNeckB: { x: 40, y: 40 },
  met1A: { x: 60, y: 20 }, met1B: { x: 100, y: 60 },
}, 1);
ok(f.length === 2 && f[0].unit === "°", "Meary + pitch üretiliyor");
ok(f.some((m) => m.assessment !== "yetersiz"), "değerlendirme yapılıyor");

// ── kalça AP ──
const h = findMskProtocol("hip-ap")!.compute({
  headCenter: { x: 50, y: 50 }, latAcetab: { x: 80, y: 50 }, medTeardrop: { x: 20, y: 60 }, roofMid: { x: 50, y: 30 },
}, 1);
ok(h.length === 2, "CE + asetabular indeks üretiliyor");

// ── nokta yapışması ──
const W = 20, H = 20;
const img = new Float32Array(W * H);
for (let i = 0; i < img.length; i++) img[i] = 100;
img[5 * W + 5] = 250;                 // en parlak nokta
img[12 * W + 12] = -50;               // en koyu nokta
const sMax = snapPoint(img, W, H, { x: 4, y: 4 }, 3, "max");
ok(sMax.x === 5 && sMax.y === 5, `max modunda tepe noktasına yapışır (${sMax.x},${sMax.y})`);
const sMin = snapPoint(img, W, H, { x: 13, y: 13 }, 3, "min");
ok(sMin.x === 12 && sMin.y === 12, `min modunda çukur noktasına yapışır (${sMin.x},${sMin.y})`);
// kenar: keskin geçiş 0..255 dikey kenar x=10
const edge = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = x < 10 ? 0 : 255;
const sEdge = snapPoint(edge, W, H, { x: 9, y: 5 }, 2, "edge");
ok(sEdge.x === 10 || sEdge.x === 9, `edge modunda gradyan tepe noktası (${sEdge.x})`);
// kapsam dışı girdi
const out = snapPoint(img, W, H, { x: -5, y: -5 }, 3, "max");
ok(out.x === -5 && out.y === -5, "kapsam dışı girdide orijinal korunur");


// ── arayüz bağlantısı ──
const root = path.resolve(__dirname, "..");
const ws = readFileSync(path.join(root, "src/components/Workstation.tsx"), "utf8");
const rp = readFileSync(path.join(root, "src/components/RightPanel.tsx"), "utf8");
ok(ws.includes("🦴 MSK") && ws.includes('setTool("msk")'), "araç çubuğunda MSK girişi var");
ok(ws.includes("onMskPoints={onMskPoints}") && ws.includes("snapRadius={4}"), "Viewport MSK noktalarını ve yapışmayı alıyor");
ok(rp.includes("MSK_PROTOCOLS.map") && rp.includes("ASSESSMENT_LABEL"), "ölçüm sekmesinde protokol listesi ve yorum etiketleri var");
ok(rp.includes("Ölçüm yardımcısıdır"), "panelde tanısal olmayan uyarı metni var");

if (failed) { console.error(`${failed} MSK testi başarısız`); process.exit(1); }
console.log("Tüm MSK testleri geçti.");

/**
 * m-seg / v-multimon: bileşen düzeyi duman testi (sunucu tarafı render).
 *
 * Amaç gerçek tarayıcı E2E'sinin yerini almak değil; hook sırası, koşullu hook
 * ve render-time çökme gibi hataları (ekran açılmadan) yakalamak. Etkileşim
 * mantığı `tests/seg.test.ts`, `tests/mirror.test.ts`, `tests/gestures.test.ts`
 * içinde saf fonksiyonlarla doğrulanır.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MirrorView from "../src/components/MirrorView";
import SegEditor from "../src/components/SegEditor";
import type { SeriesData } from "../src/lib/types";

const mirror = renderToStaticMarkup(<MirrorView />);
assert.ok(mirror.includes("İKİNCİ EKRAN"), "ikinci ekran başlığı render edilir");
assert.ok(mirror.includes("yayın bekleniyor"), "yayın gelmeden bekleme durumu gösterilir");
assert.ok(!mirror.includes("Kesit 1"), "veri yokken sahte kesit etiketi yazılmaz");
console.log("PASS ikinci ekran: boş durum çökmeden render edilir.");

const series = {
  id: "test-1", modality: "CT", description: "Beyin BT", bodyPart: "BEYİN",
  patientName: "TEST", patientId: "T1", patientAge: "040Y", patientSex: "O",
  studyDate: "20260101", institution: "TEST", studyUid: "1.2.3",
  width: 4, height: 4, pixelSpacing: 0.5, sliceThickness: 1,
  slices: [new Float32Array(16), new Float32Array(16)],
} as unknown as SeriesData;

const seg = renderToStaticMarkup(
  <SegEditor series={series} slice={0} wl={40} ww={80} invert={false} pxMm={0.5} onClose={() => {}} toast={() => {}} />
);
for (const marker of ["Segmentasyon editörü", "Fırça", "Silgi", "Eşik dolgusu", "Bölge büyüt", "Hacim", "DICOM SEG indir", "RTSTRUCT indir"]) {
  assert.ok(seg.includes(marker), `editörde "${marker}" bulunmalı`);
}
assert.ok(seg.includes("0.00 mL"), "boş maskede hacim 0,00 mL");
assert.ok(seg.includes("hekim onayına tabidir") || seg.includes("Hacim piksel aralığına göredir"), "hacim uyarısı görünür");
assert.ok(seg.includes("1/2"), "kesit sayacı seri uzunluğunu gösterir");
console.log("PASS segmentasyon editörü: tüm araçlar ve hacim paneli render edilir.");

const empty = renderToStaticMarkup(
  <SegEditor series={null} slice={0} wl={40} ww={80} invert={false} pxMm={1} onClose={() => {}} toast={() => {}} />
);
assert.ok(empty.includes("önce bir görüntü serisi"), "seri yokken yönlendirme gösterilir");
console.log("PASS segmentasyon editörü: seri yokken güvenli boş durum.");
console.log("Tüm arayüz duman testleri geçti.");

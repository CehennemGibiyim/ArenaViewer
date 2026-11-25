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
import NoduleTracker from "../src/components/NoduleTracker";
import MeasureHistoryPanel from "../src/components/MeasureHistoryPanel";
import LungQuantPanel from "../src/components/LungQuantPanel";
import NuclearPanel from "../src/components/NuclearPanel";
import PatientLetterModal from "../src/components/PatientLetterModal";
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
for (const marker of ["Segmentasyon editörü", "Fırça", "Silgi", "Eşik dolgusu", "Bölge büyüt", "Hacim", "Eksen:", "DICOM SEG indir", "RTSTRUCT indir"]) {
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

// a-track: nodül takibi — çalışmalar arası eşleştirme paneli SSR'da çökmeden render edilir.
const nod = renderToStaticMarkup(
  <NoduleTracker patientId="T1" patientName="TEST" studyDate="20260101" measurements={[]} onClose={() => {}} />
);
for (const marker of ["Nodül takibi", "Çalışmalar arası eşleştirme", "en az iki farklı tarihte ölçüm gerekir", "Lung-RADS", "CSV indir"]) {
  assert.ok(nod.includes(marker), `nodül takibinde "${marker}" bulunmalı`);
}
assert.ok(nod.includes('data-testid="cross-study-panel"'), "eşleştirme paneli işaretli render edilir");
assert.ok(nod.includes('role="dialog"') && nod.includes('aria-modal="true"'), "nodül takibi diyalog semantiği taşır (i-a11y)");
console.log("PASS nodül takibi: çalışmalar arası eşleştirme paneli boş durumda render edilir.");

// c-measure-history: sunucu ölçüm geçmişi paneli SSR'da çökmeden render edilir.
const hist = renderToStaticMarkup(<MeasureHistoryPanel patientId="T1" onClose={() => {}} />);
for (const marker of ["Ölçüm geçmişi · sunucu", "Hasta: T1", "Yükleniyor…", "CSV indir"]) {
  assert.ok(hist.includes(marker), `ölçüm geçmişinde "${marker}" bulunmalı`);
}
assert.ok(hist.includes('data-testid="measure-history-panel"'), "geçmiş paneli işaretli render edilir");
assert.ok(hist.includes('role="dialog"') && hist.includes('aria-modal="true"'), "ölçüm geçmişi diyalog semantiği taşır (i-a11y)");
console.log("PASS ölçüm geçmişi: sunucu paneli yükleme durumunda render edilir.");

// a-lungquant: akciğer kantitasyonu paneli SSR'da çökmeden render edilir.
const chest = { ...series, id: "chest-1", modality: "CT", description: "Toraks BT" } as unknown as SeriesData;
const lung = renderToStaticMarkup(<LungQuantPanel series={chest} onClose={() => {}} />);
for (const marker of ["Akciğer kantitasyonu · LAA-950", "Hesaplanıyor…", "Toraks BT"]) {
  assert.ok(lung.includes(marker), `akciğer panelinde "${marker}" bulunmalı`);
}
assert.ok(lung.includes('data-testid="lung-quant-panel"'), "akciğer paneli işaretli render edilir");
assert.ok(lung.includes('role="dialog"') && lung.includes('aria-modal="true"'), "akciğer paneli diyalog semantiği taşır (i-a11y)");
console.log("PASS akciğer kantitasyonu: panel hesaplama öncesi durumda render edilir.");

// a-nm: nükleer tıp paneli (SUV çarpanı yokken uyarı, TIC girişi) SSR'da render edilir.
const nuc = renderToStaticMarkup(<NuclearPanel series={chest} onClose={() => {}} />);
for (const marker of ["Nükleer tıp · MTV / SUV / TIC", "SUV çarpanı yok", "Zaman-aktivite eğrisi (TIC)", "yetersiz veri"]) {
  assert.ok(nuc.includes(marker), `nükleer panelde "${marker}" bulunmalı`);
}
assert.ok(nuc.includes('role="dialog"') && nuc.includes('aria-modal="true"'), "nükleer panel diyalog semantiği taşır");
console.log("PASS nükleer tıp: panel SUV çarpanı olmadan uyarıyla render edilir.");

// d-patient-letter: hasta mektubu paneli SSR'da render edilir (dil/düzey seçicileri + taslak kilidi).
const letterSource = {
  patientName: "TEST HASTA", studyDate: "20260214", modality: "CT", bodyPart: "TORAKS",
  findingsText: "Nodül izlendi.", impression: "Takip önerilir.", recommendation: "3 ay kontrol.",
  institution: "Test Hastanesi", approvedBy: "Dr Test", doctorTitle: "Radyoloji Uzmanı", approved: false,
};
const letter = renderToStaticMarkup(<PatientLetterModal source={letterSource} onClose={() => {}} />);
for (const marker of ["Hasta mektubu", "Türkçe", "sade dil", "Yazdır / PDF", "TASLAK"]) {
  assert.ok(letter.includes(marker), `hasta mektubunda "${marker}" bulunmalı`);
}
assert.ok(letter.includes('role="dialog"') && letter.includes('aria-modal="true"'), "hasta mektubu diyalog semantiği taşır");
assert.ok(letter.includes("disabled"), "onaysız raporda yazdırma kilitlidir");
console.log("PASS hasta mektubu: onaysız raporda taslak uyarısı ve kilitli yazdırma ile render edilir.");

console.log("Tüm arayüz duman testleri geçti.");

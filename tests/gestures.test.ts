/**
 * v-multimon: dokunmatik jest matematiği (kıstırma zoom + iki parmak kaydırma).
 */
import assert from "node:assert/strict";
import { applyGesture, clampZoom, gestureStep, pinchOf, touchToolOverride, ZOOM_MAX, ZOOM_MIN } from "../src/lib/gestures";

// ── Kıstırma geometrisi ────────────────────────────────────────────────────
assert.equal(pinchOf([]), null);
assert.equal(pinchOf([{ x: 1, y: 1 }]), null, "tek parmak kıstırma değildir");
const p = pinchOf([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
assert.ok(p);
assert.equal(p!.dist, 200);
assert.equal(p!.cx, 200);
assert.equal(p!.cy, 100);
// Çapraz parmaklar: Pisagor.
const q = pinchOf([{ x: 0, y: 0 }, { x: 30, y: 40 }]);
assert.equal(q!.dist, 50);
console.log("PASS kıstırma geometrisi: mesafe ve merkez doğru.");

// ── Adım: zoom ve kaydırma ─────────────────────────────────────────────────
const step = gestureStep({ dist: 100, cx: 100, cy: 100 }, { dist: 200, cx: 120, cy: 90 });
assert.equal(step.zoom, 2, "mesafe iki katına → zoom ×2");
assert.equal(step.dx, 20);
assert.equal(step.dy, -10);

// Aşırı tek-kare sıçraması sınırlanır.
assert.equal(gestureStep({ dist: 20, cx: 0, cy: 0 }, { dist: 200, cx: 0, cy: 0 }).zoom, 2.5);
assert.equal(gestureStep({ dist: 200, cx: 0, cy: 0 }, { dist: 20, cx: 0, cy: 0 }).zoom, 0.4);

// Önceki durum yoksa yalnız kaydırma (zoom 1).
assert.deepEqual(gestureStep(null, { dist: 150, cx: 10, cy: 20 }), { zoom: 1, dx: 0, dy: 0 });
// Sonraki durum yoksa hiçbir şey değişmez.
assert.deepEqual(gestureStep({ dist: 150, cx: 10, cy: 20 }, null), { zoom: 1, dx: 0, dy: 0 });
// Parmaklar üst üste (mesafe ~0): bölme yok, sıçrama yok.
const tiny = gestureStep({ dist: 4, cx: 5, cy: 5 }, { dist: 6, cx: 9, cy: 5 });
assert.equal(tiny.zoom, 1, "küçük mesafede zoom uygulanmaz");
assert.equal(tiny.dx, 4, "kaydırma yine uygulanır");
console.log("PASS jest adımı: sıçrama sınırı, eksik durum ve küçük mesafe güvenli.");

// ── Uygulama: sınırlar ─────────────────────────────────────────────────────
assert.equal(clampZoom(100), ZOOM_MAX);
assert.equal(clampZoom(0), ZOOM_MIN);
assert.equal(clampZoom(1.5), 1.5);
const applied = applyGesture({ zoom: 1, pan: { x: 0, y: 0 } }, { zoom: 2, dx: 10, dy: -5 });
assert.deepEqual(applied, { zoom: 2, pan: { x: 10, y: -5 } });
const capped = applyGesture({ zoom: 8, pan: { x: 0, y: 0 } }, { zoom: 2, dx: 0, dy: 0 });
assert.equal(capped.zoom, ZOOM_MAX, "zoom üst sınırı aşılmaz");
const floored = applyGesture({ zoom: 0.2, pan: { x: 0, y: 0 } }, { zoom: 0.4, dx: 0, dy: 0 });
assert.equal(floored.zoom, ZOOM_MIN, "zoom alt sınırı korunur");
// Birikimli kaydırma.
let st = { zoom: 1, pan: { x: 0, y: 0 } };
for (let i = 0; i < 5; i++) st = applyGesture(st, { zoom: 1, dx: 3, dy: 2 });
assert.deepEqual(st.pan, { x: 15, y: 10 });
console.log("PASS uygulama: zoom sınırları ve kaydırma birikimi doğru.");

// ── Araç geçersiz kılma ────────────────────────────────────────────────────
assert.equal(touchToolOverride("mouse", 1), null, "fare aracı değiştirmez");
assert.equal(touchToolOverride("touch", 1), "pan", "tek parmak → kaydır");
assert.equal(touchToolOverride("touch", 2), "pan", "iki parmak → jest");
assert.equal(touchToolOverride("pen", 2), null, "kalem aracı değiştirmez");
console.log("PASS araç geçersiz kılma: dokunmatikte kaydırma, farede araç korunur.");
console.log("Tüm jest testleri geçti.");

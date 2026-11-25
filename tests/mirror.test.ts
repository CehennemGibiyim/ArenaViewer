/**
 * v-multimon: ikinci ekran yayını sözleşmesi.
 *
 * Yayın yalnız seri künyesi + görüntülenen kesit piksellerini taşır (1000
 * kesitlik BT'yi kopyalamak yerine). Bozuk/yarım mesaj alıcıyı bozmaz.
 */
import assert from "node:assert/strict";
import {
  buildSlices, canMirror, isMirrorMeta, isMirrorState, metaOf, MIRROR_CACHE_MAX, MIRROR_CHANNEL,
  MIRROR_MAX_SLICE_PIXELS, pixelsMatch, putSlice, readMirrorMessage, stateLabel, type MirrorState,
} from "../src/lib/mirror";

const state: MirrorState = { slice: 3, wl: 40, ww: 400, invert: false, zoom: 1.5, pan: { x: 10, y: -5 } };

// ── Boyut kapısı: kesit başına ─────────────────────────────────────────────
assert.equal(canMirror(null).ok, false, "seri yok");
assert.equal(canMirror({ width: 0, height: 512, slices: [1] }).ok, false, "boyut okunamaz");
assert.equal(canMirror({ width: 512, height: 512, slices: new Array(1000).fill(0) }).ok, true, "1000 kesitli 512² BT yayınlanabilir");
const tooBig = canMirror({ width: 4096, height: 4096, slices: [1] });
assert.equal(tooBig.ok, false, "16 MP üstü tek kesit yayınlanmaz");
assert.ok(tooBig.reason?.includes("MP"));
assert.equal(MIRROR_MAX_SLICE_PIXELS, 16_000_000);
console.log("PASS boyut kapısı: kesit başına sınır, kesit sayısı sınırsız (yalnız görüntülenen gider).");

// ── Künye ──────────────────────────────────────────────────────────────────
const src = { id: "s1", modality: "CT", description: "Beyin", width: 2, height: 2, pixelSpacing: 0.5, sliceThickness: 1, slices: [1, 2, 3] };
const meta = metaOf(src);
assert.deepEqual(meta, { id: "s1", modality: "CT", description: "Beyin", width: 2, height: 2, pixelSpacing: 0.5, pixelSpacingX: undefined, sliceThickness: 1, sliceCount: 3, unit: undefined, isColor: undefined });
assert.equal("slices" in meta, false, "künye piksel taşımaz");
assert.equal(isMirrorMeta(meta), true);
assert.equal(isMirrorMeta({ ...meta, sliceCount: 0 }), false);
assert.equal(isMirrorMeta({ ...meta, width: -1 }), false);
console.log("PASS künye: piksel içermez, kesit sayısı/boyut doğrulanır.");

// ── Durum ve piksel doğrulama ──────────────────────────────────────────────
assert.equal(isMirrorState(state), true);
assert.equal(isMirrorState({ ...state, slice: NaN }), false);
assert.equal(isMirrorState({ ...state, ww: "400" }), false);
assert.equal(pixelsMatch({ width: 2, height: 2 }, new Float32Array(4)), true);
assert.equal(pixelsMatch({ width: 2, height: 2 }, new Float32Array(3)), false);
assert.equal(pixelsMatch({ width: 2, height: 2 }, null), false);
console.log("PASS doğrulama: durum ve piksel uzunluğu denetlenir.");

// ── Mesaj okuma ────────────────────────────────────────────────────────────
assert.deepEqual(readMirrorMessage({ type: "bye" }), { type: "bye" });
assert.deepEqual(readMirrorMessage({ type: "state", state }), { type: "state", state });
const ser = readMirrorMessage({ type: "series", series: meta, state });
assert.ok(ser && ser.type === "series");
const slice = readMirrorMessage({ type: "slice", index: 2, pixels: new Float32Array(4) });
assert.ok(slice && slice.type === "slice" && slice.index === 2);
assert.equal(readMirrorMessage({ type: "slice", index: 2 }), null, "pikselsiz kesit yok sayılır");
assert.equal(readMirrorMessage({ type: "series", series: { ...meta, sliceCount: 0 }, state }), null, "bozuk künye reddedilir");
assert.equal(readMirrorMessage({ type: "state", state: { slice: "x" } }), null);
assert.equal(readMirrorMessage("metin"), null);
assert.equal(readMirrorMessage(null), null);
console.log("PASS mesaj okuma: tanınmayan/bozuk mesaj sessizce yok sayılır.");

// ── Alıcı önbelleği ────────────────────────────────────────────────────────
const cache = new Map<number, { pixels: Float32Array }>();
for (let i = 0; i < MIRROR_CACHE_MAX + 3; i++) putSlice(cache, i, new Float32Array(4));
assert.equal(cache.size, MIRROR_CACHE_MAX, "önbellek sınırı korunur");
assert.equal(cache.has(0), false, "en eski kesit atılır");
assert.equal(cache.has(MIRROR_CACHE_MAX + 2), true, "yeni kesit tutulur");
putSlice(cache, MIRROR_CACHE_MAX + 2, new Float32Array([9, 9, 9, 9]));
assert.equal(cache.get(MIRROR_CACHE_MAX + 2)!.pixels[0], 9, "aynı kesit tazelenir");
assert.equal(cache.size, MIRROR_CACHE_MAX, "tazeleme boyutu artırmaz");
console.log("PASS alıcı önbelleği: LRU benzeri sınır, tazeleme.");

const slices = buildSlices({ width: 2, height: 2, sliceCount: 4 }, cache as unknown as Map<number, { pixels: Float32Array }>);
assert.equal(slices.length, 4, "kesit sayısı künyeden");
assert.equal(slices[0], slices[1], "eksik kesitler tek paylaşılan sıfır tamponu");
assert.equal(Array.from(slices[0] as Float32Array).every((v) => v === 0), true);
console.log("PASS kesit dizisi: eksik kesitler paylaşılan sıfır tamponu (bellek şişmez).");

// ── Etiket ─────────────────────────────────────────────────────────────────
assert.equal(stateLabel(state, src, 40), "CT · Beyin · Kesit 4/40 · WL 40 / WW 400");
assert.equal(stateLabel({ ...state, invert: true, wl: 40.6, ww: 399.4 }, src), "CT · Beyin · Kesit 4 · WL 41 / WW 399 · INV");
assert.equal(stateLabel(state, null), "Kesit 4 · WL 40 / WW 400", "künye yoksa sade etiket");
console.log("PASS etiket: modalite/kesit/WL-WW/invert doğru yazılır.");
// ── Gerçek taşıma: Node'un kendi BroadcastChannel'ı ile tur ────────────────
// (Node 18+ global BroadcastChannel sağlar; tarayıcıdaki yolun aynısı.)
async function transportTest() {
  assert.ok(typeof BroadcastChannel === "function", "Node BroadcastChannel yok — taşıma testi atlanamaz");
  const sender = new BroadcastChannel(MIRROR_CHANNEL);
  const receiver = new BroadcastChannel(MIRROR_CHANNEL);
  const got: { pixels?: Float32Array; meta?: string; state?: MirrorState } = {};
  const done = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("yayın 2 sn içinde ulaşmadı")), 2000);
    receiver.onmessage = (ev: MessageEvent) => {
      const m = readMirrorMessage(ev.data);
      if (!m) return;
      if (m.type === "series") got.meta = m.series.id;
      if (m.type === "slice") got.pixels = m.pixels as Float32Array;
      if (m.type === "state") got.state = m.state;
      if (got.meta && got.pixels && got.state) { clearTimeout(t); resolve(); }
    };
  });
  sender.postMessage({ type: "series", series: metaOf(src), state });
  sender.postMessage({ type: "slice", index: 1, pixels: new Float32Array([1, 2, 3, 4]) });
  sender.postMessage({ type: "state", state: { ...state, slice: 1 } });
  await done;
  assert.equal(got.meta, "s1");
  assert.deepEqual(Array.from(got.pixels!), [1, 2, 3, 4], "pikseller bozulmadan ulaşır");
  assert.equal(got.state!.slice, 1, "durum güncellemesi ulaşır");
  sender.close();
  receiver.close();
  console.log("PASS taşıma: iki pencere arasında künye + kesit + durum gerçekten aktarıldı.");
}

transportTest()
  .then(() => console.log("Tüm ikinci ekran testleri geçti."))
  .catch((e) => { console.error(e); process.exit(1); });

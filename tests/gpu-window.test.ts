/**
 * v-perf: GPU pencereleme karar mantığı ve CPU eşdeğerliği.
 *
 * WebGL bağlamı Node'da yok; bu yüzden sınanan şey (a) hangi görüntünün GPU
 * yoluna uygun olduğu, (b) kayıpsız doku biçimi seçimi ve (c) shader'ın gri
 * seviye formülünün `windowToRGBA` + `buildWindowLUT` çıktısıyla birebir
 * eşleşmesi. Shader'ın kendisi tarayıcıda çalışır; buradaki `gpuShadeLevel`
 * aynı ifadenin (t = trunc(v−lo); g = trunc(t·k)) CPU aynasıdır.
 */
import assert from "node:assert/strict";
import { gpuShadeLevel, needsGpu, pickTextureFormat } from "../src/lib/gpuWindow";
import { buildWindowLUT, windowToRGBA } from "../src/lib/window";

const base = { webgl2: true, isColor: false, width: 4096, height: 4096, sliceCount: 1 };

// ── GPU yolu seçimi ─────────────────────────────────────────────────────────
assert.equal(needsGpu(base), true, "4096² gri + WebGL2 → GPU");
assert.equal(needsGpu({ ...base, webgl2: false }), false, "WebGL2 yoksa CPU");
assert.equal(needsGpu({ ...base, isColor: true }), false, "renkli seriler GPU penceresinden geçmez");
assert.equal(needsGpu({ ...base, width: 512, height: 512 }), false, "küçük görüntü CPU'da daha hızlı");
assert.equal(needsGpu({ ...base, width: 1024, height: 1024 }), true, "1 MP sınırı dahil");
assert.equal(needsGpu({ ...base, width: 10000, height: 9000 }), false, "WebGL2 doku boyutu aşılır");
assert.equal(needsGpu({ ...base, contextLost: true }), false, "bağlam kaybından sonra CPU");
assert.equal(needsGpu({ ...base, sliceCount: 500 }), false, "bellek kapısı");
assert.equal(needsGpu({ ...base, width: 0, height: 0 }), false);
console.log("PASS GPU yolu seçimi: boyut/eşik/renk/bellek kapıları.");

// ── Doku biçimi: kayıpsız ──────────────────────────────────────────────────
assert.equal(pickTextureFormat(true, false), "r16i", "işaretli 16-bit → R16I");
assert.equal(pickTextureFormat(false, true), "r16ui", "işaretsiz 16-bit → R16UI");
assert.equal(pickTextureFormat(false, false), "r32f", "Float32 → R32F (kuantalama yok)");
console.log("PASS doku biçimi: her tampon türü kayıpsız dokuya eşlenir.");

// ── Shader formülü == CPU LUT çıktısı ──────────────────────────────────────
const cases: Array<[number, number, boolean]> = [
  [40, 400, false], // yumuşak doku
  [-600, 1500, false], // akciğer
  [300, 2000, true], // kemik + invert
  [0, 1, false], // span = 1 sınırı
  [0, 0.4, false], // span < 1 → max(1, ww)
  [-1000, 4000, true],
];
const values = [-4096, -1200, -1000, -0.5, 0, 0.5, 39, 40, 41, 240, 900, 3000, 4095, 70000];
let checked = 0;
for (const [wl, ww, invert] of cases) {
  const { lut, lo } = buildWindowLUT(wl, ww, invert);
  const cpu = windowToRGBA(new Float32Array(values), lut, lo);
  for (let i = 0; i < values.length; i++) {
    const cpuGray = (cpu[i] >>> 16) & 0xff;
    const gpuGray = gpuShadeLevel(values[i], wl, ww, invert);
    assert.equal(gpuGray, cpuGray, `WL=${wl} WW=${ww} invert=${invert} v=${values[i]}: shader ${gpuGray} ≠ CPU ${cpuGray}`);
    checked++;
  }
}
console.log(`PASS shader≡CPU: ${checked} kombinasyonda gri seviye birebir (WL/WW/invert/span sınırları).`);

// Kenetleme davranışı: alt/üst sınır dışı değerler 0/255'e sabitlenir.
assert.equal(gpuShadeLevel(-9999, 40, 400, false), 0);
assert.equal(gpuShadeLevel(9999, 40, 400, false), 255);
assert.equal(gpuShadeLevel(9999, 40, 400, true), 0);
console.log("PASS kenetleme: pencere dışı değerler 0/255 (invert ile ters).");

console.log("Tüm GPU pencereleme testleri geçti.");

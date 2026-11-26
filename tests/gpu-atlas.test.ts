/**
 * GPU doku atlası testleri (v-perf).
 *
 * İki katman doğrulanır:
 *  1. **Karar mantığı** (`planLayers`, `AtlasSlots`): katman sayısı cihaz sınırı +
 *     bellek bütçesine göre; kesit→katman eşlemesi LRU; isabette yükleme yok.
 *  2. **GL sarmalayıcısı** (`AtlasTexture`): sahte (kayıt tutan) GL nesnesiyle
 *     `texStorage3D` bir kez, `texSubImage3D` yalnız ıskada, `dispose` dokuyu siler.
 *
 * Gerçek GPU üzerinde görsel doğrulama bu testin kapsamı DEĞİLDİR; burada
 * sözleşme "gereksiz yükleme yapılmaz" düzeyinde sabitlenir.
 */
import assert from "node:assert/strict";
import { AtlasSlots, AtlasTexture, bytesPerTexelFor, planLayers } from "../src/lib/gpuAtlas";
import { GPU_SHADERS } from "../src/lib/gpuWindow";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ─────────── planLayers ───────────
{
  const full = planLayers({ sliceCount: 200, maxLayers: 2048, width: 512, height: 512, bytesPerTexel: 2 });
  ok(full.layers === 200, `seri tamamı sığıyor → 200 katman (${full.layers})`);
  ok(full.reason.includes("tüm seri sığıyor"), `gerekçe: ${full.reason}`);
  ok(full.layerBytes === 512 * 512 * 2, `katman belleği 512 KB (${full.layerBytes})`);

  const bounded = planLayers({ sliceCount: 2000, maxLayers: 2048, width: 512, height: 512, bytesPerTexel: 2, memoryBudgetBytes: 16 * 1024 * 1024 });
  ok(bounded.layers === 32, `bellek bütçesi 32 katmana indirir (${bounded.layers})`);
  ok(bounded.reason.includes("bellek bütçesi"), `gerekçe: ${bounded.reason}`);

  const device = planLayers({ sliceCount: 400, maxLayers: 64, width: 512, height: 512, bytesPerTexel: 2 });
  ok(device.layers === 64, `cihaz sınırı 64 katman (${device.layers})`);
  ok(device.reason.includes("cihaz sınırı"), `gerekçe: ${device.reason}`);

  const single = planLayers({ sliceCount: 1, maxLayers: 2048, width: 512, height: 512, bytesPerTexel: 2 });
  ok(single.layers === 1 && single.reason.includes("tek kesit"), "tek kesitte atlas kullanılmaz");

  const noArray = planLayers({ sliceCount: 100, maxLayers: 1, width: 512, height: 512, bytesPerTexel: 2 });
  ok(noArray.layers === 1 && noArray.reason.includes("desteklenmiyor"), "dizi dokusu yoksa tek doku yolu");

  const tight = planLayers({ sliceCount: 100, maxLayers: 2048, width: 4096, height: 4096, bytesPerTexel: 4, memoryBudgetBytes: 8 * 1024 * 1024 });
  ok(tight.layers === 1, `bütçe tek katmana bile yetmiyorsa 1 (${tight.layers}, ${tight.reason})`);

  ok(bytesPerTexelFor("r32f") === 4 && bytesPerTexelFor("r16i") === 2, "örnek boyutu biçime göre (R32F 4, R16 2)");
}

// ─────────── AtlasSlots (LRU) ───────────
{
  const s = new AtlasSlots(3);
  const a = s.acquire(10);
  ok(a.upload && a.slot === 0, "ilk kesit boş katmana yüklenir");
  ok(s.acquire(10).upload === false, "aynı kesit tekrar istenirse yükleme yok (isabet)");
  s.acquire(11); s.acquire(12);
  ok(s.resident.sort((x, y) => x - y).join(",") === "10,11,12", `3 katman dolu: ${s.resident.join(",")}`);
  const ev = s.acquire(13);
  ok(ev.upload === true && ev.evicted !== null, `dolu atlasta tahliye var (evicted=${ev.evicted})`);
  ok(ev.evicted === 10, "en uzun süredir kullanılmayan (10) tahliye edildi");
  ok(s.stats.misses === 4 && s.stats.hits === 1 && s.stats.evictions === 1,
    `sayaçlar: ${JSON.stringify(s.stats)}`);
  s.acquire(11);
  const ev2 = s.acquire(14);
  ok(ev2.evicted === 12, `LRU sırası korunuyor (12 tahliye, evicted=${ev2.evicted})`);
  s.reset();
  ok(s.resident.length === 0, "reset atlastaki eşlemeyi temizler");
}

// ─────────── sahte GL ───────────
interface FakeGl {
  calls: Record<string, number>;
  deleted: number;
  failMode: boolean;
}

function makeFakeGl(): { gl: WebGL2RenderingContext; state: FakeGl } {
  const state: FakeGl = { calls: {}, deleted: 0, failMode: false };
  const bump = (n: string) => { state.calls[n] = (state.calls[n] ?? 0) + 1; };
  const C = {
    TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5, TEXTURE0: 0x84c0, NO_ERROR: 0, R16I: 0x8233, RED_INTEGER: 0x8d94, SHORT: 0x1402,
  };
  const gl = {
    ...C,
    createTexture: () => { bump("createTexture"); return { id: 1 } as unknown as WebGLTexture; },
    deleteTexture: () => { state.deleted++; bump("deleteTexture"); },
    bindTexture: () => bump("bindTexture"),
    activeTexture: () => bump("activeTexture"),
    texParameteri: () => bump("texParameteri"),
    pixelStorei: () => bump("pixelStorei"),
    texStorage3D: () => bump("texStorage3D"),
    texSubImage3D: () => bump("texSubImage3D"),
    getError: () => (state.failMode ? 0x0500 : 0),
  } as unknown as WebGL2RenderingContext;
  return { gl, state };
}

{
  const { gl, state } = makeFakeGl();
  const tex = new AtlasTexture(gl, 4, 64, 64, (gl as unknown as { R16I: number }).R16I);
  ok(tex.ensure(), "doku ayırma başarılı");
  ok(state.calls.texStorage3D === 1, `texStorage3D bir kez (${state.calls.texStorage3D})`);
  tex.ensure();
  ok(state.calls.texStorage3D === 1, "ikinci ensure yeniden ayırmaz");

  const data = new Int16Array(64 * 64);
  tex.upload(0, (gl as unknown as { RED_INTEGER: number }).RED_INTEGER, (gl as unknown as { SHORT: number }).SHORT, data);
  ok(state.calls.texSubImage3D === 1 && tex.uploadCount === 1, "katman yüklemesi texSubImage3D ile");
  tex.bind(0);
  ok(state.calls.activeTexture === 1, "bağlama TEXTURE0'a yapılır");
  tex.dispose();
  ok(state.deleted === 1 && tex.texture === null, "dispose dokuyu siler");
}

// hata yolu: GL hata döndürürse `error` işaretlenir (çağıran tek doku yoluna döner)
{
  const { gl, state } = makeFakeGl();
  state.failMode = true;
  const tex = new AtlasTexture(gl, 2, 8, 8, 0x8233);
  const okAlloc = tex.ensure();
  ok(okAlloc === false && tex.error === true, "GL hatasında ayırma başarısız ve işaretlenir");
}

// ─────────── oynatma benzetimi: gereksiz yükleme yok ───────────
{
  const { gl, state } = makeFakeGl();
  const layers = 8;
  const tex = new AtlasTexture(gl, layers, 16, 16, 0x8233);
  const slots = new AtlasSlots(layers);
  const px = new Int16Array(16 * 16);
  const show = (sliceIndex: number) => {
    const got = slots.acquire(sliceIndex);
    if (got.upload) tex.upload(got.slot, 0x8d94, 0x1402, px);
    return got;
  };
  const total = 64;
  for (let i = 0; i < total; i++) show(i);          // ileri tarama
  const afterForward = tex.uploadCount;
  ok(afterForward === total, `ileri taramada kesit başına 1 yükleme (${afterForward})`);
  const hitsBefore = slots.stats.hits;
  for (let i = total - 1; i >= total - layers; i--) show(i); // son 8 kesit geriye doğru tekrar
  ok(tex.uploadCount === afterForward, "atlasta duran kesitlere dönüşte yükleme yok");
  ok(slots.stats.hits - hitsBefore === layers, `son ${layers} kesit için ${slots.stats.hits - hitsBefore} isabet`);
  // Geriye tarama: 8'lik pencere dışına çıkınca yükleme gerekir, ama her kesit için değil.
  let uploadsBefore = tex.uploadCount;
  for (let i = total - layers - 1; i >= 0; i--) show(i);
  const backUploads = tex.uploadCount - uploadsBefore;
  ok(backUploads === total - layers, `geriye taramada ıska sayısı kadar yükleme (${backUploads})`);
  ok(slots.stats.hits > 0 && slots.stats.evictions > 0,
    `önbellek isabeti ve tahliye sayıları: ${JSON.stringify(slots.stats)}`);
  ok(state.calls.texStorage3D === 1, "tüm tarama boyunca tek doku ayırması");
}

// ─────────── shader sözleşmesi ───────────
{
  const a16 = GPU_SHADERS.arrayInt16;
  ok(a16.includes("isampler2DArray") && a16.includes("ivec3(p, u_layer)"), "atlas shader'ı dizi dokusunu ve katmanı kullanır");
  ok(GPU_SHADERS.arrayUint16.includes("usampler2DArray"), "işaretsiz 16 bit atlas shader'ı ayrı");
  ok(GPU_SHADERS.arrayFloat.includes("sampler2DArray"), "Float32 atlas shader'ı ayrı");
  // Pencere formülü CPU ile aynı olmalı: t >= span → 255, aksi hâlde floor(t*scale).
  ok(a16.includes("t >= u_span ? 255.0") && a16.includes("floor(t * u_scale)"), "atlas shader'ı CPU pencere formülünü korur");
  ok(GPU_SHADERS.int16.includes("texelFetch(u_tex, p, 0)"), "tek doku shader'ı değişmedi");
}

if (failed) { console.error(`${failed} doku atlası testi başarısız`); process.exit(1); }
console.log("Tüm doku atlası (GPU) testleri geçti.");

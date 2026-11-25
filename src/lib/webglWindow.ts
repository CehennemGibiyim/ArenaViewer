/**
 * WebGL2 ile WL/WW (v-perf) — GPU'da doku + LUT.
 *
 * `Viewport`'un taban katmanı bir tuvale (canvas) ihtiyaç duyar ve onu
 * `drawImage` ile çizer. Bu modül **aynı sözleşmeyi** sağlayan bir WebGL
 * tuvali üretir: kesit `R16I`/`R16UI`/`R32F` dokusuna yüklenir, 256 girişlik
 * LUT dokusu ile eşlenir ve tam ekran dörtgende çizilir. Böylece piksel
 * dönüşümü GPU'ya taşınır; çizim boru hattı (zoom/pan/annotasyon) değişmez.
 *
 * Güvenlik ağı: GPU yolu herhangi bir nedenle kurulamazsa (WebGL2 yok, sürücü
 * hatası, doku boyutu aşımı, `EXT_color_buffer` yok) `null` döner ve çağıran
 * CPU yoluna (`windowToRGBA`) düşer. Klinik görüntü hiçbir koşulda boş kalmaz.
 */

import { GRAY_PALETTE } from "./window";
import { textureSize, type SliceArray } from "./volumePerf";

/** 0–255 gri için LUT dokusu (256×1 RGBA). */
export function buildLutTexture(invert: boolean): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let g = 0; g < 256; g++) {
    const v = invert ? 255 - g : g;
    const p = GRAY_PALETTE[v];
    out[g * 4] = p & 0xff;
    out[g * 4 + 1] = (p >> 8) & 0xff;
    out[g * 4 + 2] = (p >> 16) & 0xff;
    out[g * 4 + 3] = (p >>> 24) & 0xff;
  }
  return out;
}

/**
 * Pikselleri 0–255 aralığına indirger (LUT indisi). GPU shader'ı ile aynı
 * formülü kullanır; testte shader'a karşı referans olarak kullanılır.
 */
export function lutIndex(value: number, wl: number, ww: number): number {
  const span = Math.max(1, ww);
  const t = Math.trunc(value - (wl - span / 2));
  if (t < 0) return 0;
  if (t > span) return 255;
  return Math.min(255, Math.trunc((t * 255) / span));
}

/** Kesit türüne göre GPU iç doku biçimi. */
export function textureFormat(kind: "float32" | "int16" | "uint16"): { internal: number; format: number; type: number; name: string } {
  // Sabitler WebGL2'den gelir; testte sayısal değer sabit tutulur.
  const R16I = 0x822a, R16UI = 0x8234, R32F = 0x822e, RED_INTEGER = 0x8d94, RED = 0x1903, SHORT = 0x1402, UNSIGNED_SHORT = 0x1403, FLOAT = 0x1406;
  if (kind === "int16") return { internal: R16I, format: RED_INTEGER, type: SHORT, name: "R16I" };
  if (kind === "uint16") return { internal: R16UI, format: RED_INTEGER, type: UNSIGNED_SHORT, name: "R16UI" };
  return { internal: R32F, format: RED, type: FLOAT, name: "R32F" };
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Parça gölgelendiricisi: doku değeri → pencere aralığı → LUT.
 *
 * `u_lo` pencere alt sınırı, `u_span` genişliktir (en az 1). Doku okuması
 * `texelFetch` ile tam sayı indeksinden yapılır (yumuşatma yok: radyolojide
 * kenar keskinliği korunmalı).
 */
const FRAG_INT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform float u_lo;
uniform float u_span;
uniform vec3 u_size;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int v = int(texelFetch(u_img, p, 0).r);
  float t = floor(float(v) - u_lo);
  if (t < 0.0) t = 0.0;
  if (t > u_span) t = u_span;
  int idx = int(min(255.0, floor(t * 255.0 / u_span + 0.0001)));
  outColor = texelFetch(u_lut, ivec2(idx, 0), 0);
}`;

const FRAG_FLOAT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform float u_lo;
uniform float u_span;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_img, p, 0).r;
  float t = floor(v - u_lo);
  if (t < 0.0) t = 0.0;
  if (t > u_span) t = u_span;
  int idx = int(min(255.0, floor(t * 255.0 / u_span + 0.0001)));
  outColor = texelFetch(u_lut, ivec2(idx, 0), 0);
}`;

export interface GlWindowOptions {
  /** Test için enjekte edilebilir bağlam üreteci. */
  createCanvas?: () => HTMLCanvasElement;
  maxTextureSize?: number;
}

/**
 * Kesiti GPU'da pencereleyip tuval döndürür.
 * Başarısızlıkta `null` (çağıran CPU yoluna düşer).
 */
export function webglWindowCanvas(src: SliceArray, width: number, height: number, wl: number, ww: number, invert: boolean, opts: GlWindowOptions = {}): HTMLCanvasElement | null {
  if (typeof document === "undefined" || width <= 0 || height <= 0) return null;
  const canvas = (opts.createCanvas ?? (() => document.createElement("canvas")))();
  const max = opts.maxTextureSize ?? 16384;
  const size = textureSize(width, height, max);
  if (size.scaled) return null; // ölçekleme gerekiyorsa CPU yolu (kalite kaybı olmasın)
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  try {
    const kind = src instanceof Int16Array ? "int16" : src instanceof Uint16Array ? "uint16" : "float32";
    const fmt = textureFormat(kind);
    const frag = kind === "float32" ? FRAG_FLOAT : FRAG_INT;
    const prog = link(gl, VERT, frag);
    if (!prog) return null;
    gl.useProgram(prog);

    // Görüntü dokusu
    const imgTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (kind === "float32") {
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, width, height, 0, fmt.format, fmt.type, src as Float32Array);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, width, height, 0, fmt.format, fmt.type, src as unknown as ArrayBufferView);
    }

    // LUT dokusu (256×1)
    const lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLutTexture(invert));

    const span = Math.max(1, ww);
    gl.uniform1i(gl.getUniformLocation(prog, "u_img"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "u_lo"), wl - span / 2);
    gl.uniform1f(gl.getUniformLocation(prog, "u_span"), span);

    // Tam ekran dörtgen
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
    return canvas;
  } catch {
    return null;
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  return p;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

/** WebGL2 yolu etkin mi? (ortam bayrağı + yetenek) */
export function webglEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_WEBGL_VIEWPORT !== "1") return false;
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export const WINDOW_SHADERS = { VERT, FRAG_INT, FRAG_FLOAT };

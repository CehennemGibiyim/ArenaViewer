/**
 * GPU pencereleme (v-perf) — büyük gri kesitlerde WL/WW'yi WebGL2 ile uygular.
 *
 * Tasarım:
 *  - Kesit bir kez dokuya yüklenir; WL/WW/invert değişimi yalnız uniform
 *    güncellemesidir (CPU yolunda her değişimde tüm pikseller yeniden taranır).
 *  - Karar mantığı (`needsGpu`, `pickTextureFormat`, `gpuShadeLevel`) saftır ve
 *    test edilir.
 *  - WebGL bağlamı yoksa / bağlam kaybolursa çağıran taraf CPU yoluna döner
 *    (bu dosya hiçbir zaman hata fırlatmaz; `null` döner).
 *  - Renkli (RGBA) seriler bu yoldan geçmez; onlar doğrudan `rgbaSlices` ile çizilir.
 *  - Doku biçimleri kayıpsızdır: Int16 → R16I, Uint16 → R16UI, Float32 → R32F.
 *    Böylece shader girdisi CPU'daki HU/SI değerinin aynısıdır (kuantalama yok)
 *    ve gri seviye `windowToRGBA` + `buildWindowLUT` ile birebir eşleşir.
 */

export interface GpuDecisionInput {
  /** WebGL2 bağlamı kurulabildi mi? */
  webgl2: boolean;
  /** Görüntü renkli mi (RGBA serisi)? Renkli seriler GPU penceresinden geçmez. */
  isColor: boolean;
  width: number;
  height: number;
  /** Toplam kesit sayısı — çok kalın serilerde doku belleği sınırı için. */
  sliceCount: number;
  /** Aynı seride daha önce bağlam kaybı yaşandı mı? */
  contextLost?: boolean;
}

/** GPU yolu bu kesit için kullanılmalı mı? */
export function needsGpu(input: GpuDecisionInput): boolean {
  if (!input.webgl2 || input.isColor || input.contextLost) return false;
  if (input.width < 1 || input.height < 1) return false;
  // Küçük görüntülerde CPU zaten hızlı; doku kurulum maliyeti kazancı götürür.
  const px = input.width * input.height;
  if (px < 1024 * 1024) return false;
  // 8192² tek doku WebGL2'de çoğu cihazda başarısız olur.
  if (input.width > 8192 || input.height > 8192) return false;
  // Bellek kapısı: kesit başına ~width*height*2 bayt; 2 GB üstü seriler reddedilir.
  if (input.width * input.height * 2 * Math.max(1, input.sliceCount) > 2_000_000_000) return false;
  return true;
}

/** WebGL doku biçimi: 16-bit imzalı/işaretsiz gri ya da 32-bit float. */
export type TextureFormat = "r16ui" | "r16i" | "r32f";

/**
 * Kesit tamponuna göre kayıpsız doku biçimini seçer.
 * Float32 tamponlar için 16-bit tam sayı dokusu sessizce kesme yapardı; bu
 * yüzden R32F kullanılır (WebGL2'de örnekleme için geçerli, filtre gerekmez).
 */
export function pickTextureFormat(isInt16: boolean, isUint16: boolean): TextureFormat {
  if (isUint16) return "r16ui";
  if (isInt16) return "r16i";
  return "r32f";
}

/**
 * Shader'ın gri seviye formülünün CPU aynası — testlerde `windowToRGBA`
 * çıktısıyla karşılaştırılır. `buildWindowLUT` ile aynı sabitler:
 * span = max(1, ww), lo = wl − span/2, k = 255/span, t = trunc(v − lo).
 */
export function gpuShadeLevel(v: number, wl: number, ww: number, invert: boolean): number {
  const span = Math.max(1, ww);
  const lo = wl - span / 2;
  const k = 255 / span;
  const t = Math.floor(v - lo);
  // buildWindowLUT'ta `j >= span` → 255 özel durumu vardır; float yuvarlaması
  // (ör. 400×0.6375 = 254.9999…) aynı sonucu vermediği için burada da uygulanır.
  let g = t >= span ? 255 : Math.floor(t * k);
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  return invert ? 255 - g : g;
}

// ───────────── GL altyapısı ─────────────

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Pencere shader'ı. `read` ifadesi doku biçimine göre değişir; gri seviye
 * hesabı CPU ile aynı: t = trunc(v − lo); g = trunc(t·k); [0,255] kenetle.
 */
function frag(sampler: string, read: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
uniform ${sampler} u_tex;
uniform float u_lo;
uniform float u_scale;
uniform float u_span;
uniform int u_invert;
in vec2 v_uv;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(v_uv * vec2(textureSize(u_tex, 0)));
  float v = ${read};
  float t = floor(v - u_lo);
  // buildWindowLUT ile aynı: t >= span ise tam beyaz (float yuvarlamasına takılma).
  float g = t >= u_span ? 255.0 : floor(t * u_scale);
  g = clamp(g, 0.0, 255.0) / 255.0;
  if (u_invert == 1) g = 1.0 - g;
  outColor = vec4(g, g, g, 1.0);
}`;
}

const FRAG_INT16 = frag("isampler2D", "float(texelFetch(u_tex, p, 0).r)");
const FRAG_UINT16 = frag("usampler2D", "float(texelFetch(u_tex, p, 0).r)");
const FRAG_FLOAT = frag("sampler2D", "texelFetch(u_tex, p, 0).r");

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
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
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

export interface GpuWindowOptions {
  /** Tuvale bağlanacak WebGL2 bağlamı (mevcut değilse oluşturulur). */
  canvas?: HTMLCanvasElement;
}

/**
 * GPU pencereleyici. Tek örnek, seri/kesit değişiminde doku yeniden yüklenir.
 * `render` çağrısı başarısız olursa `null` döner ve çağıran CPU yolunu kullanır.
 */
export class GpuWindower {
  private gl: WebGL2RenderingContext | null;
  private canvas: HTMLCanvasElement | null;
  private progs: Record<TextureFormat, WebGLProgram | null> = { r16i: null, r16ui: null, r32f: null };
  private tex: WebGLTexture | null = null;
  private texKey = "";
  private fmt: TextureFormat = "r16i";
  private lost = false;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? null;
    this.gl = null;
    if (typeof document === "undefined") return;
    try {
      const c = canvas ?? document.createElement("canvas");
      this.canvas = c;
      const gl = c.getContext("webgl2", {
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
      });
      if (gl) {
        this.gl = gl;
        this.progs = {
          r16i: link(gl, VERT, FRAG_INT16),
          r16ui: link(gl, VERT, FRAG_UINT16),
          r32f: link(gl, VERT, FRAG_FLOAT),
        };
        if (!this.progs.r16i || !this.progs.r16ui || !this.progs.r32f) this.gl = null;
        gl.canvas.addEventListener("webglcontextlost", () => {
          this.lost = true;
          this.gl = null;
          this.tex = null;
          this.texKey = "";
        });
      }
    } catch {
      this.gl = null;
    }
  }

  get available(): boolean {
    return !!this.gl && !this.lost;
  }

  get contextLost(): boolean {
    return this.lost;
  }

  /**
   * Kesiti GPU'ya yükler ve çizer. `key` (seri kimliği + kesit no) aynıysa doku
   * yeniden yüklenmez — yalnız pencere uniform'ları değişir.
   */
  render(opts: {
    key: string;
    pixels: ArrayLike<number>;
    width: number;
    height: number;
    wl: number;
    ww: number;
    invert: boolean;
    isInt16: boolean;
    isUint16: boolean;
  }): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || this.lost || !this.canvas) return null;
    const { key, pixels, width, height, wl, ww, invert, isInt16, isUint16 } = opts;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (key !== this.texKey) {
      const fmt = pickTextureFormat(isInt16, isUint16);
      this.fmt = fmt;
      if (!this.tex) this.tex = gl.createTexture();
      if (!this.tex) return null;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (fmt === "r16i") {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, width, height, 0, gl.RED_INTEGER, gl.SHORT, toInt16(pixels));
      } else if (fmt === "r16ui") {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, toUint16(pixels));
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, toFloat32(pixels));
      }
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        // Biçim sürücüde desteklenmiyor: doku geçersiz, CPU yoluna dön.
        this.texKey = "";
        return null;
      }
      this.texKey = key;
    }
    const prog = this.progs[this.fmt];
    if (!prog) return null;
    gl.useProgram(prog);
    gl.viewport(0, 0, width, height);
    // Tam ekran üçgen şeridi
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    // buildWindowLUT ile aynı sabitler (span = max(1, ww)).
    const span = Math.max(1, ww);
    gl.uniform1f(gl.getUniformLocation(prog, "u_lo"), wl - span / 2);
    gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), 255 / span);
    gl.uniform1f(gl.getUniformLocation(prog, "u_span"), span);
    gl.uniform1i(gl.getUniformLocation(prog, "u_invert"), invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteBuffer(buf);
    if (gl.getError() !== gl.NO_ERROR) return null;
    return this.canvas;
  }

  /** Doku önbelleğini bırakır (seri değişimi / bellek baskısı). */
  dispose(): void {
    const gl = this.gl;
    if (gl && this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
    this.texKey = "";
  }
}

function toInt16(src: ArrayLike<number>): Int16Array {
  if (src instanceof Int16Array) return src;
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] | 0;
  return out;
}

function toUint16(src: ArrayLike<number>): Uint16Array {
  if (src instanceof Uint16Array) return src;
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.max(0, Math.min(65535, src[i] | 0));
  return out;
}

function toFloat32(src: ArrayLike<number>): Float32Array {
  if (src instanceof Float32Array) return src;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

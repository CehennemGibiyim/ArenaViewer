/**
 * GPU pencereleme (v-perf): 16 bitlik kesitler WebGL2 dokusuna yüklenir ve
 * WL/WW dönüşümü parçacık gölgelendiricisinde yapılır. Ana iş parçacığında
 * piksel başına döngü kalmaz; sonuç tuvali diğer katmanlarla aynı dönüşümden
 * geçirilerek çizilir.
 *
 * Güvenlik ağı: her yeni doku boyutunda gölgelendirici çıktısı `readPixels` ile
 * CPU referansına (`windowSampleGray`) karşı örneklenir. Uyuşmazlık, bağlam
 * kaybı veya destek yokluğunda `draw` false döner ve çağıran CPU/Worker yoluna
 * düşer — yanlış görüntü gösterilmez.
 */
import { gpuWindowCompatible, windowSampleGray } from "./windowFrame";

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform isampler2D uTex;
uniform int uH;
uniform int uLo;
uniform int uSpan;
uniform int uInvert;
out vec4 outColor;
void main() {
  int x = int(gl_FragCoord.x);
  int y = uH - 1 - int(gl_FragCoord.y);
  int v = texelFetch(uTex, ivec2(x, y), 0).r;
  int t = v - uLo;
  int g;
  if (t <= 0) g = 0;
  else if (t >= uSpan) g = 255;
  else g = int(float(t) * (255.0 / float(uSpan)));
  if (g > 255) g = 255;
  if (uInvert == 1) g = 255 - g;
  outColor = vec4(float(g) / 255.0, float(g) / 255.0, float(g) / 255.0, 1.0);
}
`;

const FRAG_UNSIGNED = FRAG
  .replace("uniform isampler2D uTex;", "uniform usampler2D uTex;")
  .replace("int v = texelFetch(uTex, ivec2(x, y), 0).r;", "int v = int(texelFetch(uTex, ivec2(x, y), 0).r);");

export interface WindowGpuRenderer {
  /** Güncel kesiti çizer; başarısızsa false (çağıran CPU yoluna düşer). */
  draw(pixels: Int16Array | Uint16Array, w: number, h: number, wl: number, ww: number, invert: boolean): boolean;
  canvas: HTMLCanvasElement;
  dispose(): void;
}

/** Gölgelendirici kaynağı (test/teşhis için dışa açık). */
export const WINDOW_SHADER_SOURCE = { vert: VERT, frag: FRAG, fragUnsigned: FRAG_UNSIGNED };

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * GPU çizici oluşturur. WebGL2 yoksa veya program derlenemezse null döner;
 * bu durumda çağıran CPU yolunu kullanır (özellik kaybı yok, yalnızca hız).
 */
export function createWindowGpuRenderer(maxTexture = 4096): WindowGpuRenderer | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const makeProgram = (fragSrc: string): WebGLProgram | null => {
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
  };
  const prog = makeProgram(FRAG);
  const progU = makeProgram(FRAG_UNSIGNED);
  if (!prog || !progU) return null;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const newTexture = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  // İşaretli (R16I/SHORT) ve işaretsiz (R16UI/UNSIGNED_SHORT) kesitler ayrı doku
  // kullanır: doku iç biçimi sonradan değiştirilemez.
  const texS = newTexture();
  const texU = newTexture();

  const uniforms = (p: WebGLProgram) => ({
    uH: gl.getUniformLocation(p, "uH"),
    uLo: gl.getUniformLocation(p, "uLo"),
    uSpan: gl.getUniformLocation(p, "uSpan"),
    uInvert: gl.getUniformLocation(p, "uInvert"),
  });
  const uS = uniforms(prog);
  const uU = uniforms(progU);
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
  gl.useProgram(progU);
  gl.uniform1i(gl.getUniformLocation(progU, "uTex"), 0);

  const sizes = { s: { w: 0, h: 0 }, u: { w: 0, h: 0 } };
  let verified = false;
  let verifiedSize = "";
  let failed = false;

  const draw: WindowGpuRenderer["draw"] = (pixels, w, h, wl, ww, invert) => {
    if (failed || w <= 0 || h <= 0 || w > maxTexture || h > maxTexture) return false;
    if (!(pixels instanceof Int16Array) && !(pixels instanceof Uint16Array)) return false;
    if (!gpuWindowCompatible(wl, ww)) return false;
    const span = Math.max(1, Math.round(ww));
    const lo = Math.round(wl - ww / 2);
    if (pixels.length < w * h) return false;

    const unsigned = pixels instanceof Uint16Array;
    const program = unsigned ? progU : prog;
    const tex = unsigned ? texU : texS;
    const size = unsigned ? sizes.u : sizes.s;
    const u = unsigned ? uU : uS;

    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (size.w !== w || size.h !== h) {
      size.w = w; size.h = h;
      gl.texImage2D(gl.TEXTURE_2D, 0, unsigned ? gl.R16UI : gl.R16I, w, h, 0, gl.RED_INTEGER, unsigned ? gl.UNSIGNED_SHORT : gl.SHORT, pixels);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, unsigned ? gl.UNSIGNED_SHORT : gl.SHORT, pixels);
    }

    gl.viewport(0, 0, w, h);
    gl.uniform1i(u.uH, h);
    gl.uniform1i(u.uLo, lo);
    gl.uniform1i(u.uSpan, span);
    gl.uniform1i(u.uInvert, invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!verified || verifiedSize !== `${w}x${h}`) {
      verified = true;
      verifiedSize = `${w}x${h}`;
      const px = new Uint8Array(4);
      const probe = (x: number, y: number) => {
        gl.readPixels(x, h - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px[0];
      };
      const counts = [0, (h >> 1) * w + (w >> 1), (h - 1) * w + (w - 1), Math.floor(h / 3) * w + Math.floor(w / 3)];
      for (const idx of counts) {
        const expected = windowSampleGray(pixels[idx], wl, ww, invert);
        const got = probe(idx % w, Math.floor(idx / w));
        if (Math.abs(got - expected) > 1) { failed = true; return false; }
      }
    }
    return true;
  };

  return {
    canvas,
    draw,
    dispose: () => {
      gl.deleteTexture(texS);
      gl.deleteTexture(texU);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

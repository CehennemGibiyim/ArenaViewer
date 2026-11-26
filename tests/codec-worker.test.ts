/**
 * v-perf: sıkıştırılmış DICOM codec'lerinin Web Worker'a taşınması — testler.
 *
 * Üç katman:
 *  1) `runCodecJob` (codecWorker.ts) fixture dosyaları üzerinde, eşzamanlı yol
 *     `decodeEncapsulatedFrames` ile karşılaştırılır (aynı kod — kayma olamaz).
 *  2) WASM yükleyici Worker kapsamındayken importScripts yolunu kullanır
 *     (kaynak denetimi) ve normal sayfada <script> yolunu kullanır (kaynak denetimi).
 *  3) dicom.ts artık `decodeEncapsulated` (codecClient) üzerinden gider;
 *     client başarısızlıkta eşzamanlı yola düşer (kaynak denetimi).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseDicom } from "dicom-parser";
import {
  decodeEncapsulatedFrames,
  setWasmLoader,
  type FrameInfo,
} from "../src/lib/codecs";
import { runCodecJob, deserializeFrame } from "../src/lib/codecWorker";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, "fixtures", "codecs");
const PUB_CODECS = path.join(process.cwd(), "public", "codecs");
const PUB_WASM = path.join(process.cwd(), "public", "wasm");

type WasmName = "openjpeg" | "charls";
const ASSETS: Record<WasmName, { js: string; wasm: string; global: string }> = {
  openjpeg: { js: path.join(PUB_CODECS, "openjpegwasm_decode.js"), wasm: path.join(PUB_WASM, "openjpegwasm_decode.wasm"), global: "OpenJPEGWASM" },
  charls: { js: path.join(PUB_CODECS, "charlswasm_decode.js"), wasm: path.join(PUB_WASM, "charlswasm_decode.wasm"), global: "CharLSWASM" },
};

async function nodeLoader(name: WasmName): Promise<unknown> {
  const a = ASSETS[name];
  const code = fs.readFileSync(a.js, "utf8");
  const sandbox: Record<string, unknown> = {
    module: { exports: {} }, exports: {}, require, process, console,
    __dirname: path.dirname(a.js), __filename: a.js,
    window: undefined, document: undefined,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: a.js });
  const factory = sandbox[a.global] as ((o: { locateFile: (f: string) => string }) => Promise<unknown>) | undefined;
  if (!factory) throw new Error(`${a.global} üretilmedi`);
  return factory({ locateFile: (f) => (f.endsWith(".wasm") ? a.wasm : f) });
}

setWasmLoader(nodeLoader);

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function loadDcm(name: string) {
  const buf = fs.readFileSync(path.join(FIX, name));
  const ds = parseDicom(new Uint8Array(buf));
  const ts = (ds.string("x00020010") ?? "").trim();
  const el = ds.elements["x7fe00010"];
  if (!el) throw new Error(`${name}: x7fe00010 yok`);
  const info: FrameInfo = {
    rows: ds.uint16("x00280010")!,
    cols: ds.uint16("x00280011")!,
    bitsAllocated: ds.uint16("x00280100") ?? 16,
    bitsStored: ds.uint16("x00280101") ?? 16,
    pixelRep: ds.uint16("x00280103") ?? 0,
    samples: ds.uint16("x00280002") ?? 1,
    frames: Math.max(1, ds.intString("x00280008") ?? 1),
  };
  return { ds, el, ts, info };
}

const equalFrames = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

async function main() {
  // ── 1) runCodecJob ≡ decodeEncapsulatedFrames (fixture'lar) ──
  for (const name of ["MR_small_RLE.dcm", "SC_rgb_rle.dcm", "JPEG2000.dcm", "JPEG-lossy.dcm"]) {
    const { ds, el, ts, info } = loadDcm(name);
    const expected = await decodeEncapsulatedFrames(ds, el, ts, info);
    const result = await runCodecJob({
      id: 1,
      byteArray: ds.byteArray.slice(),
      encapsulatedPixelData: !!el.encapsulatedPixelData,
      hadUndefinedLength: !!el.hadUndefinedLength,
      dataOffset: el.dataOffset,
      fragments: el.fragments?.map((f) => ({ offset: f.offset, position: f.position, length: f.length })),
      basicOffsetTable: el.basicOffsetTable ? Array.from(el.basicOffsetTable as ArrayLike<number>) : [],
      ts,
      info,
    });
    if ("error" in result) { ok(false, `${name}: codec işi hata verdi: ${result.error}`); continue; }
    const got = result.frames.map(deserializeFrame);
    ok(got.length === expected.length, `${name}: kare sayısı eşit (${expected.length})`);
    let same = true;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].length !== got[i].length || !equalFrames(expected[i], got[i])) { same = false; break; }
    }
    ok(same, `${name}: worker yolu pikselleri birebir üretiyor`);
  }

  // bozuk iş bekleyen isteği kilitlemez, hata alan sertifika döner
  const bad = await runCodecJob({
    id: 7, byteArray: new Uint8Array(0), encapsulatedPixelData: true, hadUndefinedLength: true, dataOffset: 132,
    fragments: [], basicOffsetTable: [], ts: "1.2.840.10008.1.2.4.91",
    info: { rows: 8, cols: 8, bitsAllocated: 8, bitsStored: 8, pixelRep: 0, samples: 1, frames: 1 },
  });
  ok("error" in bad && bad.id === 7, "geçersiz iş hata ile döner (asılı kalmaz)");

  // ── 2) WASM yükleyici ortam ayrımı (kaynak) ──
  const codecs = fs.readFileSync(path.join(process.cwd(), "src/lib/codecs.ts"), "utf8");
  ok(codecs.includes("importScripts") && codecs.includes("isWorkerScope"),
    "codecs.ts worker kapsamında importScripts yolu kullanır");
  ok(codecs.includes("document.createElement(\"script\")"),
    "codecs.ts normal sayfada <script> yolu korunur");

  // ── 3) entegrasyon kabloları (kaynak) ──
  const dicom = fs.readFileSync(path.join(process.cwd(), "src/lib/dicom.ts"), "utf8");
  ok(dicom.includes("decodeEncapsulated"), "dicom.ts kapsüllenmiş çözümü codecClient üzerinden yapar");
  ok(!dicom.includes("decodeEncapsulatedFrames("), "dicom.ts codecs'i doğrudan çağırmaz");
  const client = fs.readFileSync(path.join(process.cwd(), "src/lib/codecClient.ts"), "utf8");
  ok(client.includes("codecWorker.bundle.js"), "client public/codecs/codecWorker.bundle.js worker'ını kurar");
  ok(!client.includes("import.meta.url"), "client Turbopack'in derlemediği new URL(import.meta.url) desenini kullanmaz");
  ok(client.includes("decodeEncapsulatedFrames(ds, el, ts, info)"), "client başarısızsa eşzamanlı yola düşer");

  // ── 2b) gömülü worker: bundle'ı sanal tarayıcıda (vm) çalıştır ──
  const bundlePath = path.join(process.cwd(), "public/codecs", "codecWorker.bundle.js");
  ok(fs.existsSync(bundlePath), "public/codecs/codecWorker.bundle.js depoda mevcut");
  const bundle = fs.readFileSync(bundlePath, "utf8");
  const messages: { message: { id?: number; frames?: { kind: string; length: number; buffer: ArrayBuffer }[]; error?: string }; transfer: unknown[] }[] = [];
  const vm2 = await import("node:vm");
  const sandbox: Record<string, unknown> = {
    console,
    importScripts: () => { throw new Error("RLE için importScripts çağrılmamalı"); },
    setTimeout, clearTimeout, queueMicrotask,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;
  sandbox.document = undefined;
  sandbox.postMessage = (message: unknown, transfer: unknown[]) => { messages.push({ message: message as (typeof messages)[number]["message"], transfer: transfer ?? [] }); };
  vm2.createContext(sandbox);
  vm2.runInContext(bundle, sandbox, { filename: "codecWorker.bundle.js" });
  ok(typeof (sandbox as { onmessage?: unknown }).onmessage === "function", "bundle worker kapsamında installCodecWorker'ı çalıştırır");
  {
    const { ds, el, ts, info } = loadDcm("MR_small_RLE.dcm");
    const expected = await decodeEncapsulatedFrames(ds, el, ts, info);
    // vm kapsamı kendi realm'inin Uint8Array'ini ister (dicom-parser instanceof denetimi);
    // gerçek tarayıcıda tek realm olduğu için sorun yok — burada kopyalayıp aktarıyoruz.
    const vmUint8 = vm2.runInContext("Uint8Array", sandbox) as new (n: number | ArrayLike<number>) => Uint8Array;
    const vmBytes = new vmUint8(ds.byteArray.slice());
    (sandbox as { onmessage: (e: { data: unknown }) => void }).onmessage({
      data: {
        id: 99,
        byteArray: vmBytes,
        encapsulatedPixelData: !!el.encapsulatedPixelData,
        hadUndefinedLength: !!el.hadUndefinedLength,
        dataOffset: el.dataOffset,
        fragments: el.fragments?.map((f) => ({ offset: f.offset, position: f.position, length: f.length })),
        basicOffsetTable: el.basicOffsetTable ? Array.from(el.basicOffsetTable as ArrayLike<number>) : [],
        ts,
        info,
      },
    });
    // runCodecJob async çalışır — mesajı bekle
    for (let i = 0; i < 200 && messages.length === 0; i++) await new Promise((r) => setImmediate(r));
    const got = messages.find((m) => m.message?.id === 99)?.message;
    ok(!!got && !got.error, `bundle worker MR_small_RLE'yi çözebiliyor${got?.error ? " (hata: " + got.error + ")" : ""}`);
    if (got && !got.error && got.frames) {
      ok(got.frames.length === expected.length, "bundle worker kare sayısı doğru");
      const g = got.frames[0];
      const e = expected[0];
      const gu = new Uint8Array(g.buffer, 0, g.buffer.byteLength);
      const eu = new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
      ok(gu.length === eu.length && gu.every((v, i) => v === eu[i]), "bundle worker pikselleri birebir üretiyor");
    }
  }
  const workerSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/codecWorker.ts"), "utf8");
  for (const marker of ["runCodecJob", "decodeEncapsulatedFrames", "installCodecWorker"]) {
    ok(workerSrc.includes(marker), `codecWorker "${marker}" içerir`);
  }

  // ── 2c) bundle tazeliği: kaynaktan birebir yeniden üretilebilmeli ──
  try {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [path.join(process.cwd(), "src/lib/codecWorker.ts")],
      bundle: true, format: "iife", platform: "browser", target: "es2020",
      minify: true, write: false, logLevel: "silent",
      define: { "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify("") },
    });
    ok(result.outputFiles[0].text === bundle, "codecWorker.bundle.js src/lib/codecWorker.ts ile güncel (yoksa: node scripts/build-codec-worker.mjs)");
  } catch (e) {
    console.error("esbuild ile tazelik denetimi yapılamadı:", e);
    failed++;
  }

  if (failed) { console.error(`${failed} codec-worker testi başarısız`); process.exit(1); }
  console.log("Tüm codec-worker testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

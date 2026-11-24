/**
 * Sıkıştırılmış DICOM çözme (f-codec) testleri.
 *
 * Gerçek hasta verisi KULLANILMAZ: fixture'lar herkese açık test kaynaklarındandır
 * (cornerstonejs/codecs MIT · pydicom örnek dosyaları).
 *
 * JPEG 2000 ve JPEG-LS için WASM modülleri Node'da da yüklenir; tarayıcı yolundaki
 * script-tag yükleyicisi bu testin kapsamı dışındadır (public/codecs/*.js + *.wasm).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseDicom } from "dicom-parser";
import {
  decodeEncapsulatedFrames,
  isCodecSupported,
  codecName,
  setWasmLoader,
  type RawFrame,
} from "../src/lib/codecs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, "fixtures", "codecs");
const PUB_CODECS = path.join(process.cwd(), "public", "codecs");
const PUB_WASM = path.join(process.cwd(), "public", "wasm");

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ───────────── Node için WASM yükleyici ─────────────
type WasmName = "openjpeg" | "charls";
const ASSETS: Record<WasmName, { js: string; wasm: string; global: string }> = {
  openjpeg: { js: path.join(PUB_CODECS, "openjpegwasm_decode.js"), wasm: path.join(PUB_WASM, "openjpegwasm_decode.wasm"), global: "OpenJPEGWASM" },
  charls: { js: path.join(PUB_CODECS, "charlswasm_decode.js"), wasm: path.join(PUB_WASM, "charlswasm_decode.wasm"), global: "CharLSWASM" },
};

async function nodeLoader(name: WasmName): Promise<unknown> {
  const a = ASSETS[name];
  if (!fs.existsSync(a.js) || !fs.existsSync(a.wasm)) {
    throw new Error(`WASM varlığı eksik: ${a.js} / ${a.wasm}`);
  }
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

// ───────────── Yardımcılar ─────────────
interface Info { rows: number; cols: number; bitsAllocated: number; bitsStored: number; pixelRep: number; samples: number; frames: number }

function readInfo(ds: ReturnType<typeof parseDicom>): Info {
  return {
    rows: ds.uint16("x00280010")!,
    cols: ds.uint16("x00280011")!,
    bitsAllocated: ds.uint16("x00280100") ?? 16,
    bitsStored: ds.uint16("x00280101") ?? 16,
    pixelRep: ds.uint16("x00280103") ?? 0,
    samples: ds.uint16("x00280002") ?? 1,
    frames: Math.max(1, ds.intString("x00280008") ?? 1),
  };
}

function loadDcm(name: string) {
  const buf = fs.readFileSync(path.join(FIX, name));
  const ds = parseDicom(new Uint8Array(buf));
  const ts = (ds.string("x00020010") ?? "").trim();
  const el = ds.elements["x7fe00010"];
  if (!el) throw new Error(`${name}: x7fe00010 yok`);
  return { ds, ts, el, info: readInfo(ds) };
}

/** Ham JPEG-LS/CHARLS karesini çözer (codecs.ts katmanını değil doğrudan decoder'ı kullanır). */
async function decodeJlsRaw(bytes: Uint8Array): Promise<{ w: number; h: number; bits: number; data: Uint8Array }> {
  const mod = (await nodeLoader("charls")) as { JpegLSDecoder: new () => any };
  const dec = new mod.JpegLSDecoder();
  try {
    dec.getEncodedBuffer(bytes.length).set(bytes);
    dec.decode();
    const fi = dec.getFrameInfo();
    return { w: fi.width, h: fi.height, bits: fi.bitsPerSample, data: dec.getDecodedBuffer().slice() };
  } finally {
    dec.delete();
  }
}

async function main() {
  // ── WASM varlıkları ──
  for (const n of ["openjpeg", "charls"] as const) {
    const a = ASSETS[n];
    ok(fs.existsSync(a.wasm), `${n} .wasm depoda mevcut (${path.basename(a.wasm)})`);
    ok(fs.existsSync(a.js), `${n} JS köprüsü depoda mevcut`);
  }
  ok(fs.existsSync(path.join(PUB_CODECS, "LICENSE.openjpeg.txt")) && fs.existsSync(path.join(PUB_CODECS, "LICENSE.charls.txt")),
    "codec lisans/bildirim dosyaları var");
  // JS ve WASM dizinleri ayrı: tüm .wasm'ler /wasm altında olmalı.
  const wasmFiles = fs.readdirSync(PUB_WASM).filter((f) => f.endsWith(".wasm"));
  ok(wasmFiles.length === 2, `public/wasm'de 2 codec ikilisi (${wasmFiles.join(", ")})`);
  ok(fs.readdirSync(PUB_CODECS).every((f) => !f.endsWith(".wasm")), "public/codecs'de .wasm yok (MIME ayrımı)");

  // ── Transfer syntax desteği ──
  ok(isCodecSupported("1.2.840.10008.1.2.5"), "RLE destekliyor");
  ok(isCodecSupported("1.2.840.10008.1.2.4.90"), "JPEG 2000 destekliyor");
  ok(isCodecSupported("1.2.840.10008.1.2.4.80"), "JPEG-LS destekliyor");
  ok(!isCodecSupported("1.2.840.10008.1.2.4.100"), "MPEG desteklenmiyor");
  ok(codecName("1.2.840.10008.1.2.4.90") === "JPEG 2000", "codec adı doğru");

  // ── JPEG-LS: lossless → ham RAW ile birebir eşleşmeli ──
  const jlsBytes = fs.readFileSync(path.join(FIX, "CT2.JLS"));
  const jls = await decodeJlsRaw(jlsBytes);
  const raw = fs.readFileSync(path.join(FIX, "CT2.RAW"));
  ok(jls.w === 512 && jls.h === 512, `JLS kare 512×512 (gelen ${jls.w}×${jls.h})`);
  ok(jls.bits === 16, `JLS 16-bit (gelen ${jls.bits})`);
  ok(jls.data.length === raw.length, `JLS çözülen uzunluk RAW ile aynı (${jls.data.length}/${raw.length})`);
  let same = jls.data.length === raw.length;
  for (let i = 0; same && i < raw.length; i++) if (jls.data[i] !== raw[i]) same = false;
  ok(same, "JLS lossless: çözülen pikseller RAW ile birebir eşleşiyor");

  // ── JPEG-LS renkli (US, sample interleaved) ──
  const us = await decodeJlsRaw(fs.readFileSync(path.join(FIX, "US1-color-ilv-sample.jls")));
  const usBytes = Math.ceil(us.bits / 8);
  ok(us.w > 0 && us.h > 0 && us.data.length === us.w * us.h * 3 * usBytes,
    `JLS renkli: ${us.w}×${us.h} RGB ${us.bits}-bit (${us.data.length} bayt)`);

  // ── JPEG 2000 DICOM ──
  const j2k = loadDcm("JPEG2000.dcm");
  ok(j2k.ts === "1.2.840.10008.1.2.4.91", `J2K transfer syntax doğru (${j2k.ts})`);
  const j2kOut = await decodeEncapsulatedFrames(j2k.ds, j2k.el, j2k.ts, j2k.info);
  const needJ2k = j2k.info.rows * j2k.info.cols;
  ok(j2kOut.length === 1 && j2kOut[0].length >= needJ2k, `J2K kare çözüldü (${j2kOut[0].length} piksel, gerekli ${needJ2k})`);

  // ── RLE gri (MR_small_RLE.dcm) ──
  const rleG = loadDcm("MR_small_RLE.dcm");
  ok(rleG.ts === "1.2.840.10008.1.2.5", `RLE TS doğru (${rleG.ts})`);
  const rleGOut = await decodeEncapsulatedFrames(rleG.ds, rleG.el, rleG.ts, rleG.info);
  ok(rleGOut.length === 1 && rleGOut[0].length >= rleG.info.rows * rleG.info.cols,
    `RLE gri kare çözüldü (${rleG.info.rows}×${rleG.info.cols})`);
  const vals = new Set<number>();
  for (let i = 0; i < (rleGOut[0] as Uint16Array).length; i += 997) vals.add((rleGOut[0] as Uint16Array)[i]);
  ok(vals.size > 4, `RLE gri piksel varyasyonu var (${vals.size} farklı örnek)`);

  // ── RLE renkli (SC_rgb_rle.dcm) ──
  const rleC = loadDcm("SC_rgb_rle.dcm");
  const rleCOut = await decodeEncapsulatedFrames(rleC.ds, rleC.el, rleC.ts, rleC.info);
  ok(rleC.info.samples === 3 && rleCOut[0].length >= rleC.info.rows * rleC.info.cols * 3,
    `RLE renkli RGB çözüldü (${rleC.info.rows}×${rleC.info.cols} ×3)`);

  // ── JPEG lossy (baseline/extended) ──
  const jpg = loadDcm("JPEG-lossy.dcm");
  const jpgOut = await decodeEncapsulatedFrames(jpg.ds, jpg.el, jpg.ts, jpg.info);
  ok(jpgOut.length === 1 && jpgOut[0].length >= jpg.info.rows * jpg.info.cols * jpg.info.samples,
    `JPEG lossy kare çözüldü (${jpg.info.rows}×${jpg.info.cols}, ${jpg.info.samples} örnek)`);

  // ── Desteklenmeyen TS reddedilir ──
  let rejected = false;
  try { await decodeEncapsulatedFrames(j2k.ds, j2k.el, "1.2.840.10008.1.2.4.100", j2k.info); } catch { rejected = true; }
  ok(rejected, "Desteklenmeyen codec hata fırlatır");

  if (failed) { console.error(`${failed} codec testi başarısız`); process.exit(1); }
  console.log("Tüm codec testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

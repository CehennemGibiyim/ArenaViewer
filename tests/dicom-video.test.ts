/**
 * f-objects: DICOM video (MPEG-2 / MPEG-4 AVC/H.264 / HEVC) desteği testleri.
 *
 * Gerçek (sentetik ama yapısal olarak geçerli) P10 fixture kullanılır:
 *   tests/fixtures/video/video-h264.dcm — Video Endoscopic Image Storage,
 *   TS 1.2.840.10008.1.2.4.102 (AVC/H.264), 150 kare, CineRate 30,
 *   payload: VideoEndoscopic fixture gövdesi (ftyp/mdat kutuları).
 * Oynatma <video>'ya devredildiği için tarayıcı codec desteği test kapsamı DIŞINDADIR;
 * bu test payload çıkarma, sınıflandırma ve kablolamayı denetler.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDicom } from "dicom-parser";
import {
  isVideoTransferSyntax,
  videoInfo,
  extractVideoPayload,
  parseDicomVideo,
  videoFileExtension,
  VIDEO_TRANSFER_SYNTAXES,
} from "../src/lib/dicomVideo";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIX = path.join(HERE, "fixtures", "video");

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── TS sınıflandırması ──
for (const ts of VIDEO_TRANSFER_SYNTAXES) {
  ok(isVideoTransferSyntax(ts), `video TS kabul edilir: ${ts}`);
  ok(!!videoInfo(ts)?.mime, `video TS'nin MIME'ı var: ${ts}`);
}
ok(!isVideoTransferSyntax("1.2.840.10008.1.2.4.50"), "JPEG Baseline video DEĞİL");
ok(!isVideoTransferSyntax("1.2.840.10008.1.2.4.90"), "JPEG 2000 video DEĞİL");
ok(!isVideoTransferSyntax("1.2.840.10008.1.2"), "Implicit VR LE video DEĞİL");
ok(!isVideoTransferSyntax(undefined) && !isVideoTransferSyntax("") && !isVideoTransferSyntax(null), "boş/undefined TS video DEĞİL");
ok(isVideoTransferSyntax(" 1.2.840.10008.1.2.4.102 "), "boşluklu TS trim ile kabul edilir");
ok(videoInfo("1.2.840.10008.1.2.4.100")?.mime === "video/mpeg", "MPEG-2 → video/mpeg");
ok(videoInfo("1.2.840.10008.1.2.4.102")?.mime === "video/mp4", "AVC/H.264 → video/mp4");
ok(videoInfo("1.2.840.10008.1.2.4.106")?.mime === "video/mp4", "HEVC → video/mp4");
ok(videoFileExtension("video/mpeg") === ".mpg" && videoFileExtension("video/mp4") === ".mp4", "indirme uzantıları doğru");

// ── Fixture ayrıştırma ──
const buf = fs.readFileSync(path.join(FIX, "video-h264.dcm"));
const expectedPayload = fs.readFileSync(path.join(FIX, "video-h264.payload.bin"));
const ds = parseDicom(new Uint8Array(buf));

ok(ds.string("x00020010")?.trim() === "1.2.840.10008.1.2.4.102", "fixture TS AVC/H.264");
ok(ds.uint16("x00280010") === 128 && ds.uint16("x00280011") === 224, "fixture boyutları 224×128");

const payload = extractVideoPayload(ds);
assert.ok(payload, "payload çıkarılabilmeli");
ok(payload.length === expectedPayload.length, `payload uzunluğu ${expectedPayload.length} bayt (gelen ${payload.length})`);
ok(payload.every((b, i) => b === expectedPayload[i]), "payload baytları birebir eşleşiyor (ftyp/mdat gövdesi)");

const video = parseDicomVideo(ds);
assert.ok(video, "video ayrıştırılabilmeli");
ok(video.title === "Test video (H.264)", `başlık SeriesDescription'dan alınır (${video.title})`);
ok(video.totalFrames === 150, `kare sayısı 150 (gelen ${video.totalFrames})`);
ok(video.frameRate === 30, `CineRate 30 fps (gelen ${video.frameRate})`);
ok(video.mimeType === "video/mp4", "MIME video/mp4");
ok(video.codecLabel.includes("H.264"), `codec etiketi H.264 içerir (${video.codecLabel})`);
ok(video.payload.length === payload.length, "video.payload extract çıktısıyla aynı");

// ── Bozulmuş/eksik nesne ──
const broken = parseDicom(new Uint8Array(buf).slice());
broken.elements["x7fe00010"].fragments = [];
ok(parseDicomVideo(broken) === null, "fragment'sız nesne null döner (çökme yok)");
ok(isVideoTransferSyntax(undefined) === false && isVideoTransferSyntax("") === false, "TS okunamayan nesne video sayılmaz");

// ── Kaynak denetimi: kablolama ──
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const dicom = read("src/lib/dicom.ts");
const videoBranch = dicom.indexOf("isVideoTransferSyntax(ts)");
const unsupported = dicom.indexOf("!UNCOMPRESSED.has(ts) && !isCodecSupported(ts)");
ok(videoBranch > 0 && unsupported > 0 && videoBranch < unsupported,
  "dicom.ts: video dalı desteklenmeyen-TS sayacından ÖNCE çalışır");
ok(dicom.includes('specialType: "video"'), "dicom.ts: video serisi specialType:\"video\" ile üretilir");
const workstation = read("src/components/Workstation.tsx");
ok(workstation.includes("<VideoViewer video={series.videoData} />"), "Workstation: video özel dalı VideoViewer'a bağlar");
ok(workstation.includes('"Video"'), "Workstation: seri listesinde 'Video' etiketi var");
ok(workstation.includes("DICOM video"), "Workstation: bırak-yükle ipucu videoyu yazar");
const viewer = read("src/components/VideoViewer.tsx");
for (const marker of ["createObjectURL", "revokeObjectURL", "onError", "download=", "çözemiyor", "payload.slice()", "<video"]) {
  ok(viewer.includes(marker), `VideoViewer "${marker}" içerir`);
}

if (failed) { console.error(`${failed} video testi başarısız`); process.exit(1); }
console.log("Tüm DICOM video testleri geçti.");

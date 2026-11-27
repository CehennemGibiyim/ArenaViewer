/**
 * f-share — süreli paylaşımda görüntü (anonim JPEG kesit) testleri.
 *
 * Kapsam:
 *  1) paket doğrulama (JPEG imzası, boyut, adet, kopya, sıralama, hasta alanı reddi)
 *  2) seçim/stride yardımcıları
 *  3) paylaşım türü kaydı (image) + TTL listesi
 *  4) sunucu uçlarının sözleşmesi (statik denetim: no-store, image/jpeg, 410, blob silme)
 *  5) i18n anahtarlarının 83 pakette bulunması + yer tutucu tutarlılığı
 *  6) kılavuz satırı (Dışa aktar menüsündeki yeni öğe belgelenmiş mi)
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  MAX_SHARE_IMAGES, MAX_SHARE_FRAME_BYTES, MAX_SHARE_IMAGE_BYTES, SHARE_IMAGE_MAX_SIDE,
  MAX_SELECTION_SPAN, buildShareImagePackage, formatBytes, jpegByteLength, looksJpeg, packageFrame,
  parseShareImagePackage, sampleSelection, selectionToSlices, uniformStride,
} from "../src/lib/shareImage";
import { SHARE_KINDS, SHARE_TTL_HOURS, isShareKind } from "../src/lib/share";
import { translate, interpolate } from "../src/lib/i18n";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** Gerçek bir JPEG: SOI(FFD8FF) + dolgu. Testte kod çözme yok, imza yeter. */
const jpeg = (bytes = 512) => {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const body = Buffer.alloc(Math.max(0, bytes - head.length - 2), 0x20);
  const tail = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, body, tail]).toString("base64");
};
const frame = (slice: number, extra: Partial<{ width: number; height: number; b64: string }> = {}) =>
  ({ slice, width: extra.width ?? 512, height: extra.height ?? 512, b64: extra.b64 ?? jpeg() });

async function main() {
  // ── 1. JPEG kapısı ──
  ok(looksJpeg(jpeg()), "JPEG imzası kabul edilir");
  ok(!looksJpeg(Buffer.from("<?php echo 1; ?>").toString("base64")), "PHP gövdesi JPEG sayılmaz");
  ok(!looksJpeg(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")), "SVG JPEG sayılmaz");
  ok(!looksJpeg(""), "boş değer JPEG sayılmaz");
  ok(!looksJpeg("!!!!"), "base64 olmayan metin reddedilir");

  // ── 2. Paket kurma ──
  const good = buildShareImagePackage({
    label: "TORAKS BT 1.25mm SANAL", modality: "ct", studyDate: "2026-11-27",
    frames: [frame(4), frame(1), frame(2)],
  });
  ok(good.ok, "geçerli paket kurulur");
  if (good.ok) {
    ok(good.pkg.frames.map((f) => f.slice).join(",") === "1,2,4", "kareler kesit sırasına göre dizilir");
    ok(good.pkg.images.length === 3 && good.pkg.images.every(looksJpeg), "görüntüler karelerle eşleşir ve JPEG'dir");
    ok(good.pkg.modality === "CT", "modalite büyük harfe çevrilir");
    ok(good.pkg.sliceCount === 3, "sliceCount = kare sayısı");
    ok(good.pkg.version === 1, "paket sürümü 1");
    ok(good.pkg.frames.every((f) => f.bytes === jpegByteLength(jpeg())), "bayt hesabı base64 uzunluğuyla tutarlı");
  }

  const noFrames = buildShareImagePackage({ label: "X", modality: "CT", studyDate: "", frames: [] });
  ok(!noFrames.ok && /kesit seçilmedi/i.test(noFrames.error), "boş seçim reddedilir");

  const tooMany = buildShareImagePackage({
    label: "X", modality: "CT", studyDate: "",
    frames: Array.from({ length: MAX_SHARE_IMAGES + 1 }, (_, i) => frame(i)),
  });
  ok(!tooMany.ok && /en fazla/i.test(tooMany.error), `en fazla ${MAX_SHARE_IMAGES} kesit`);

  const dup = buildShareImagePackage({ label: "X", modality: "CT", studyDate: "", frames: [frame(3), frame(3)] });
  ok(!dup.ok && /birden fazla/i.test(dup.error), "aynı kesit iki kez gönderilemez");

  const big = buildShareImagePackage({ label: "X", modality: "CT", studyDate: "", frames: [frame(0, { width: SHARE_IMAGE_MAX_SIDE + 1 })] });
  ok(!big.ok && /kenarı/i.test(big.error), `en uzun kenar ≤ ${SHARE_IMAGE_MAX_SIDE}`);

  const notJpeg = buildShareImagePackage({ label: "X", modality: "CT", studyDate: "", frames: [frame(0, { b64: "aGVsbG8gd29ybGQ=" })] });
  ok(!notJpeg.ok && /JPEG/i.test(notJpeg.error), "JPEG olmayan kare reddedilir");

  const hugeFrame = buildShareImagePackage({
    label: "X", modality: "CT", studyDate: "", frames: [frame(0, { b64: jpeg(MAX_SHARE_FRAME_BYTES + 4096) })],
  });
  ok(!hugeFrame.ok && /boyut sınırı/i.test(hugeFrame.error), "tek kare boyut tavanı uygulanır");

  const hugeTotal = buildShareImagePackage({
    label: "X", modality: "CT", studyDate: "",
    frames: Array.from({ length: 12 }, (_, i) => frame(i, { b64: jpeg(Math.floor(MAX_SHARE_FRAME_BYTES * 0.9)) })),
  });
  ok(!hugeTotal.ok, "toplam paket tavanı uygulanır");

  const badSlice = buildShareImagePackage({ label: "X", modality: "CT", studyDate: "", frames: [frame(-1)] });
  ok(!badSlice.ok && /kesit numarası/i.test(badSlice.error), "negatif kesit reddedilir");

  const cleared = buildShareImagePackage({ label: "<b>KÖTÜ</b> & 'seri'", modality: "ct!", studyDate: "2026-11-27", frames: [frame(0)] });
  ok(cleared.ok && !/[<>'"&!]/.test(cleared.pkg.label + cleared.pkg.modality), "etiket/modalite temizlenir (HTML kaçışı yok)");

  const noLabel = buildShareImagePackage({ label: "   ", modality: "", studyDate: "", frames: [frame(0)] });
  ok(noLabel.ok && noLabel.pkg.label === "SERİ" && noLabel.pkg.modality === "OT", "boş etiket/modalite güvenli varsayılana düşer");

  // ── 3. Depodan okuma (parse) ──
  if (good.ok) {
    const round = parseShareImagePackage(JSON.stringify(good.pkg));
    ok(!!round && round.frames.length === 3 && round.images[0] === good.pkg.images[0], "paket gidiş-dönüş kayıpsız");
    ok(parseShareImagePackage("{bozuk") === null, "bozuk JSON null döner");
    ok(parseShareImagePackage(JSON.stringify({ ...good.pkg, version: 2 })) === null, "bilinmeyen sürüm reddedilir");
    ok(parseShareImagePackage(JSON.stringify({ ...good.pkg, images: good.pkg.images.slice(0, 2) })) === null, "kare/görüntü sayısı uyuşmazlığı reddedilir");
    ok(parseShareImagePackage(JSON.stringify({ ...good.pkg, images: ["PHN2Zz48L3N2Zz4="] })) === null, "depodaki JPEG olmayan içerik reddedilir (bozuk depo)");

    const f2 = packageFrame(good.pkg, 2);
    ok(!!f2 && f2.meta.slice === 2 && looksJpeg(f2.b64), "kare numarası 1 tabanlı ve sıralı çalışır");
    ok(packageFrame(good.pkg, 0) === null && packageFrame(good.pkg, 4) === null, "sınır dışı kare null");
    ok(packageFrame(good.pkg, 1.5) === null, "tam sayı olmayan kare null");
  }

  // ── 4. Seçim / stride ──
  const s1 = selectionToSlices(40, 3, 6);
  ok(!s1.error && s1.slices.join(",") === "2,3,4,5", "1 tabanlı aralık → 0 tabanlı kesitler");
  ok(!!selectionToSlices(40, 0, 5).error, "0 kesit numarası reddedilir");
  ok(!!selectionToSlices(40, 5, 3).error, "ters aralık reddedilir");
  ok(!!selectionToSlices(40, 1, 41).error, "seri dışı aralık reddedilir");
  ok(!!selectionToSlices(0, 1, 1).error, "boş seri reddedilir");
  ok(!!selectionToSlices(MAX_SELECTION_SPAN + 1, 1, MAX_SELECTION_SPAN + 1).error, "bellek koruması: çok geniş aralık reddedilir");
  const edge = selectionToSlices(MAX_SHARE_IMAGES, 1, MAX_SHARE_IMAGES);
  ok(!edge.error && edge.slices.length === MAX_SHARE_IMAGES, "tam sınır kabul edilir");

  // sampleSelection: dar aralıkta hiçbir kesit atlanmaz, geniş aralık seyreltilir.
  const narrow = sampleSelection(40, 3, 6);
  ok(!narrow.error && narrow.stride === 1 && narrow.slices.join(",") === "2,3,4,5", "dar aralıkta örnekleme yok");
  const wide = sampleSelection(1000, 1, 1000);
  ok(!wide.error && wide.slices.length <= MAX_SHARE_IMAGES && wide.stride === Math.ceil(1000 / MAX_SHARE_IMAGES), "geniş aralık eşit aralıkla seyreltilir");
  ok(wide.slices.every((s) => s % wide.stride === 0), "seyreltme düzenli (her stride. kesit)");
  ok(wide.slices.length >= MAX_SHARE_IMAGES - 1, "seyreltme sınırın altına gereksiz düşmez");
  const exact = sampleSelection(MAX_SHARE_IMAGES, 1, MAX_SHARE_IMAGES);
  ok(exact.stride === 1 && exact.slices.length === MAX_SHARE_IMAGES, "tam sınırda seyreltme yapılmaz");
  ok(!!sampleSelection(10, 5, 3).error, "sampleSelection hataları iletir");

  ok(uniformStride(0).stride === 1 && uniformStride(0).effective === 0, "boş seride stride 1 / 0 kare");
  ok(uniformStride(10).stride === 1 && uniformStride(10).effective === 10, "kısa seride atlama yok");
  const st = uniformStride(500);
  ok(st.stride === Math.ceil(500 / MAX_SHARE_IMAGES) && st.effective <= MAX_SHARE_IMAGES * 1, "uzun seride eşit aralıklı örnekleme");

  // ── 5. Paylaşım türü ve TTL ──
  ok(SHARE_KINDS.includes("image") && SHARE_KINDS.includes("report"), "paylaşım türlerine 'image' eklendi");
  ok(isShareKind("image") && isShareKind("report") && !isShareKind("study"), "isShareKind dar tutulur");
  ok(SHARE_TTL_HOURS.includes(24) && SHARE_TTL_HOURS.includes(720), "TTL listesi korunur");

  // ── 6. Sunucu ucu sözleşmesi (statik) ──
  const imgRoute = read("src/app/api/share/[token]/image/[n]/route.ts");
  ok(/image\/jpeg/.test(imgRoute), "kare ucu Content-Type: image/jpeg sabitler");
  ok(/no-store/.test(imgRoute), "kare ucu önbelleğe alınmaz");
  ok(/nosniff/.test(imgRoute), "kare ucu nosniff gönderir");
  ok(/packageFrame/.test(imgRoute), "kare ucu sınır denetimi yapar");
  ok(/status: 410/.test(imgRoute), "kare ucu kapatılmış/süresi dolmuş bağlantıda 410 döner");
  ok(!/openImageShare/.test(imgRoute), "kare ucu hata yolunda sayaç artırmaz (openImageShare çağırmaz)");
  ok(/Number\(n\) === 1/.test(imgRoute) && /share\.image_access/.test(imgRoute), "denetim kare başına değil görüntüleme oturumu başına (ilk kare)");
  ok(/^[0-9a-f]{48}\$/.test(imgRoute.replace(/\n/g, "")) || /\[0-9a-f\]\{48\}/.test(imgRoute), "kare ucu token biçimini doğrular");

  const deleteRoute = read("src/app/api/shares/[token]/route.ts");
  ok(/deleteShareImages/.test(deleteRoute), "kapatma görüntü blob'unu siler");
  ok(/imagesDeleted/.test(deleteRoute), "kapatma yanıtı silme durumunu bildirir");

  const createRoute = read("src/app/api/shares/route.ts");
  ok(/putShareImages/.test(createRoute), "oluşturma ucu paketi depoya yazar");
  ok(/patient/i.test(createRoute) && /400/.test(createRoute), "hasta kimliği alanı reddedilir");
  ok(/shareLinks/.test(createRoute) && /delete\(shareLinks\)/.test(createRoute), "depolama hatasında bağlantı satırı geri alınır");

  const repo = read("src/lib/server/shareRepo.ts");
  ok(/deleteShareImages\(token\)/.test(repo), "repo: süresi dolmuş paket silinir");
  ok(/openImageShare/.test(repo), "repo: görüntü paylaşımı açma yolu var");
  ok(/revokedAt/.test(repo) && /410/.test(repo), "repo: kapatılmış/süresi dolmuş → 410");

  const page = read("src/app/paylas/[token]/page.tsx");
  ok(/SharedImageView/.test(page) && /openImageShare/.test(page), "paylaşım sayfası görüntü türünü ayırır");
  ok(/audit\(null, "share\.access"/.test(page), "görüntü sayfası açılışı denetime yazılır");

  const view = read("src/components/SharedImageView.tsx");
  ok(/\/api\/share\/\$\{token\}\/image\//.test(view), "görünüm kareleri API ucundan yükler");
  ok(/onContextMenu/.test(view), "görünüm sağ tık indirmeyi engeller");
  ok(!/download/i.test(view), "görünüm indirme düğmesi sunmaz");

  // ── 7. i18n: 83 paket + yer tutucu tutarlılığı ──
  const packs = readdirSync(path.join(root, "src/i18n")).filter((f) => f.endsWith(".json") && f !== "catalog.json");
  ok(packs.length >= 83, `dil paketi sayısı (${packs.length})`);
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>;
  const shareKeys = Object.keys(en).filter((k) => k.startsWith("share."));
  ok(shareKeys.length >= 25, `share.* anahtarı (${shareKeys.length})`);
  let missing = 0, empty = 0, placeholderMismatch = 0;
  for (const f of packs) {
    const d = JSON.parse(read(`src/i18n/${f}`)) as Record<string, string>;
    for (const k of shareKeys) {
      if (!(k in d)) { missing++; continue; }
      if (!d[k].trim()) empty++;
      const a = (en[k].match(/\{\w+\}/g) ?? []).sort().join(",");
      const b = (d[k].match(/\{\w+\}/g) ?? []).sort().join(",");
      if (a !== b) placeholderMismatch++;
    }
  }
  ok(missing === 0, `tüm paketlerde share anahtarları var (eksik ${missing})`);
  ok(empty === 0, `share değerleri boş değil (boş ${empty})`);
  ok(placeholderMismatch === 0, `yer tutucular diller arası tutarlı (uyuşmazlık ${placeholderMismatch})`);

  ok(translate("tr", "share.menu").startsWith("Anonim"), "tr çevirisi gerçek Türkçe");
  // de paketi tembel yüklenir; `translate` yalnız yüklü paketleri çözer → doğrudan dosyadan okunur.
  const de = JSON.parse(read("src/i18n/de.json")) as Record<string, string>;
  ok(de["share.title"].includes("Zeitlich") && de["share.warning"].includes("DICOM"), "de çevirisi gerçek Almanca (kopya değil)");
  const az = JSON.parse(read("src/i18n/az.json")) as Record<string, string>;
  ok(/kəsik/i.test(az["share.plan"]) && az["share.image"] !== en["share.image"], "az çevirisi gerçek Azerice (İngilizce kopya değil)");
  ok(interpolate("a {x} b {y}", { x: 1 }) === "a 1 b {y}", "eksik yer tutucu görünür kalır (sessiz boşaltma yok)");
  ok(interpolate("sade {yok}") === "sade {yok}", "değişkensiz interpolate metni bozmaz");

  // ── 8. Kılavuz + dışa aktarma menüsü ──
  const menu = read("src/components/ExportMenu.tsx");
  ok(/ShareImageDialog/.test(menu) && /share\.menu/.test(menu), "dışa aktarma menüsünde paylaşım öğesi var");
  const dialog = read("src/components/ShareImageDialog.tsx");
  ok(/sampleSelection/.test(dialog), "diyalog seyreltmeyi örnekleme yardımcısıyla yapar (belgelenen davranış = kod)");
  ok(/CH_QUALITY|SHARE_IMAGE_QUALITY/.test(dialog) && /maxSide: ?SHARE_IMAGE_MAX_SIDE/.test(dialog), "diyalog paylaşılan sabitleri kullanır");
  ok(/kind: "image"/.test(dialog), "diyalog görüntü türüyle gönderir");
  ok(!/patient/i.test(dialog.replace(/Hasta kimliği BİLİNÇLİ|hasta kimliği/gi, "")), "diyalog hasta kimliği alanı göndermez");
  const guide = read("docs/MENU_KILAVUZU.md");
  ok(/Anonim kesit paylaş/i.test(guide), "kılavuzda 'Anonim kesit paylaş' satırı var");

  // ── 9. Depolama: şifreli yazma + silme (gerçek FsStorage, geçici dizin) ──
  // Modül yüklemesinden ÖNCE ortam kurulur: db/index ve crypto anahtar ister.
  const { randomBytes } = await import("node:crypto");
  const os = await import("node:os");
  process.env.DATA_ENCRYPTION_KEYS = randomBytes(32).toString("base64");
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/app_db";
  const tmp = await import("node:fs").then((fs) => fs.mkdtempSync(path.join(os.tmpdir(), "share-img-")));
  const storageMod = await import("../src/lib/server/storage");
  const { FsStorage } = await import("../src/lib/storageAdapter");
  storageMod.setStorage(new FsStorage(tmp));
  const repoMod = await import("../src/lib/server/shareRepo");
  const { decryptBuffer } = await import("../src/lib/server/crypto");
  const { shareImageKey } = await import("../src/lib/shareImage");

  const token = "a".repeat(48);
  const sample = good.ok ? good.pkg : null;
  if (sample) {
    await repoMod.putShareImages(token, sample);
    const rawFile = storageMod.fileStorage();
    const stored = await rawFile.get(shareImageKey(token));
    ok(!!stored && stored.length > 0, "paket depoya yazılır");
    if (stored) {
      const json = stored.toString("latin1");
      ok(!json.includes('"frames"') && !json.includes('"version"'), "depodaki içerik düz metin JSON değil (şifreli)");
      ok(!json.includes(sample.images[0].slice(0, 40)), "depodaki içerikte JPEG base64'ü görünmez");
      const plain = decryptBuffer(stored).toString("utf8");
      ok(!!parseShareImagePackage(plain), "depodaki içerik anahtarla çözülünce geçerli paket verir");
    }
    await repoMod.deleteShareImages(token);
    ok((await rawFile.get(shareImageKey(token))) === null, "deleteShareImages blob'u gerçekten siler");
    ok((await rawFile.get(shareImageKey(token))) === null, "silme idempotent (ikinci çağrı hata vermez)");
    await repoMod.deleteShareImages("kisa"); // biçimsiz token: sessiz geçer
    await repoMod.deleteShareImages(token);
    ok(true, "geçersiz token ile silme sessiz geçer (kapatmayı engellemez)");
    ok(/share-image\//.test(shareImageKey(token)) && shareImageKey(token).includes(token), "depo anahtarı önek + token");
  }

  console.log(`\nshare-images: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

/**
 * c-seg-rtstruct: kontur izleme (kenar takibi) + düzenleme yardımcıları.
 *
 * Kritik iddia: halka alanı **piksel sayısına eşit** olmalı (satır taraması dış
 * zarfı bunu başaramaz), konkav bölgeler ve delikler korunmalı, düzeltme
 * sonrası alan sapması sessizce kabul edilmemeli.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRtStruct, maskContour, maskContours, ringPoints } from "../src/lib/dicomSeg";
import {
  areaMm2,
  chaikin,
  combineMasks,
  dedupeRing,
  dice,
  editSummary,
  makeMask,
  maskGet,
  pixelCount,
  removeIslands,
  ringAreaPx,
  ringOrientation,
  ringToMm,
  simplifyRing,
  smoothRing,
  traceContours,
  volumeMl,
  type Mask2D,
} from "../src/lib/segEditing";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function fromRows(rows: string[]): Mask2D {
  const h = rows.length, w = rows[0].length;
  const m = makeMask(w, h);
  rows.forEach((r, y) => {
    for (let x = 0; x < w; x++) if (r[x] === "#") m.data[y * w + x] = 1;
  });
  return m;
}

function main() {
  // ── 1) Maske temel işlemleri ────────────────────────────────────────
  assert.throws(() => makeMask(0, 5), /boyutu geçersiz/, "sıfır boyut reddedilir");
  assert.throws(() => makeMask(3, 3, new Uint8Array(5)), /9 bayt olmalı/, "boyut uyuşmazlığı");
  const m1 = makeMask(4, 4);
  assert.equal(pixelCount(m1), 0, "boş maske");
  assert.equal(maskGet(m1, -1, 0), 0, "dış piksel 0");
  assert.equal(maskGet(m1, 4, 0), 0, "sınır dışı 0");
  assert.equal(areaMm2(fromRows(["##", "##"]), 0.5, 0.5), 1, "4 piksel × 0.25 mm² = 1 mm²");
  console.log("PASS maske temelleri (boyut/bayt denetimi, alan)");

  // ── 2) Kontur izleme: alan = piksel sayısı ──────────────────────────
  const tek = fromRows(["...", ".#.", "..."]);
  const c1 = traceContours(tek, 0);
  assert.equal(c1.length, 1, "tek piksel tek halka");
  assert.equal(ringAreaPx(c1[0].ring), 1, "alan tam 1 piksel");
  assert.equal(c1[0].orientation, 1, "dış halka saat yönü tersi");
  assert.equal(c1[0].hole, false, "delik değil");

  const blok = fromRows(["....", ".##.", ".##.", "...."]);
  const c2 = traceContours(blok, 0);
  assert.equal(c2.length, 1, "2x2 blok tek halka");
  assert.equal(ringAreaPx(c2[0].ring), 4, "alan 4 piksel");

  // L şekli: satır taraması 8 piksel alanlı dış zarf verir; gerçek alan 4.
  const L = fromRows(["....", ".##.", ".#..", ".#.."]);
  const cL = traceContours(L, 0);
  assert.equal(ringAreaPx(cL[0].ring), pixelCount(L), "konkav şekilde alan korunur");
  assert.equal(pixelCount(L), 4, "L dört piksel");
  assert.equal(ringAreaPx(cL[0].ring), pixelCount(L), "yeni yöntem konkav alanı korur");

  // Eski satır taraması iki ayrık bölgeyi tek poligonda birleştirir: aradaki
  // boş satır da konturun içine girer (alan şişer).
  const kopuk = fromRows(["#...#", ".....", "#...#"]);
  const eski = maskContour(kopuk.data, kopuk.width, kopuk.height);
  assert.equal(pixelCount(kopuk), 4, "gerçek segment 4 piksel");
  assert.ok(ringAreaPx(eski) > pixelCount(kopuk), `eski yöntem ${ringAreaPx(eski)} piksel² veriyor (şişirme)`);
  const cKopuk = traceContours(kopuk, 0);
  assert.ok(cKopuk.length >= 2, "yeni yöntem ayrık bölgeleri ayrı halkalarda verir");
  assert.equal(cKopuk.reduce((n, c) => n + ringAreaPx(c.ring), 0), 4, "toplam alan = piksel sayısı (şişme yok)");
  const rtYol = maskContours(L.data, 4, 4);
  assert.equal(rtYol.length, 1, "RTSTRUCT yolu tek halka verir");
  assert.equal(ringAreaPx(rtYol[0].pts), pixelCount(L), "RTSTRUCT konturu da alanı korur (sadeleştirme sonrası)");

  // Delik: dış halka + ters yönlü iç halka
  const halka = fromRows(["#####", "#####", "##.##", "#####", "#####"]);
  const c3 = traceContours(halka, 0);
  assert.equal(c3.length, 2, "iki halka (dış + delik)");
  const outer = c3.find((c) => !c.hole)!;
  const hole = c3.find((c) => c.hole)!;
  assert.equal(ringAreaPx(outer.ring), 25, "dış halka 25 piksel");
  assert.equal(ringAreaPx(hole.ring), 1, "delik 1 piksel");
  assert.equal(hole.orientation, -1, "delik saat yönünde");
  assert.equal(ringAreaPx(outer.ring) - ringAreaPx(hole.ring), pixelCount(halka), "net alan = piksel - delik");

  // Çoklu ada: iki ayrı halka
  const adalar = fromRows(["#....#", "#....#", "......", "#....#", "#....#"]);
  const c4 = traceContours(adalar, 0);
  assert.equal(c4.length, 4, "dört ayrı 2x2 ada");
  // Her ada 1 sütun × 2 satır = 2 piksel.
  assert.ok(c4.every((c) => ringAreaPx(c.ring) === 2), "her ada 2 piksel");
  assert.equal(c4.reduce((n, c) => n + ringAreaPx(c.ring), 0), pixelCount(adalar), "toplam alan piksel sayısına eşit");

  // Sınırda pikseller (kenara değen) halka kapatabilmeli
  const kenar = fromRows(["##", "##"]);
  assert.equal(traceContours(kenar, 0).length, 1, "kenardaki 2x2 blok tek halka");
  assert.equal(traceContours(makeMask(3, 3), 0).length, 0, "boş maskede halka yok");
  console.log("PASS kontur izleme (alan = piksel, konkav, delik, çoklu ada)");

  // ── 3) Sadeleştirme ve yumuşatma ────────────────────────────────────
  const kare = fromRows(["#####", "#####", "#####", "#####", "#####"]);
  const ring = traceContours(kare, 0)[0].ring;
  assert.equal(ring.length, 20, "5x5 blok 20 köşe noktası");
  const simple = simplifyRing(ring, 1.1);
  assert.equal(simple.length, 4, "düz kenarlar dört köşeye iner");
  assert.equal(ringAreaPx(simple), 25, "sadeleştirme alanı korur");
  assert.equal(dedupeRing([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }]).length, 2, "yinelenen ve kapalı bitiş temizlenir");
  assert.equal(simplifyRing([{ x: 0, y: 0 }], 1).length, 1, "küçük halka dokunulmadan döner");

  const yumusak = chaikin([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 1);
  assert.equal(yumusak.length, 8, "Chaikin nokta sayısını ikiye katlar");
  assert.ok(yumusak.every((p) => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10), "yumuşatma kutu içinde kalır");
  assert.ok(ringAreaPx(yumusak) < 100, "yumuşatma köşeleri keser (alan küçülür)");

  const rapor = smoothRing(ring, { tolerance: 1.1, iterations: 2 });
  assert.ok(rapor.pointsAfter < rapor.pointsBefore, "düzeltme nokta sayısını azaltır");
  assert.ok(rapor.areaDriftPct < 0.35, "köşe kesme sapması ölçülür");
  assert.equal(typeof rapor.warning, "string", "sapma eşiği aşıldığında uyarı verilir");
  const sertUyari = smoothRing(
    traceContours(fromRows(["##.....", "##.....", ".......", ".....##", ".....##"]), 0)[0].ring,
    { iterations: 4, maxDriftPct: 0.001 },
  );
  assert.match(sertUyari.warning ?? "", /Alan sapması %/, "dar eşikte uyarı");
  assert.equal(smoothRing(ring, { tolerance: 1.1 }).warning, null, "eşik altında uyarı yok");
  console.log("PASS sadeleştirme/yumuşatma (alan sapması raporlanır)");

  // ── 4) mm dönüşümü ve hacim ─────────────────────────────────────────
  const mm = ringToMm([{ x: 2, y: 4 }], 0.5, 0.25);
  assert.deepEqual(mm, [{ x: 1, y: 1 }], "piksel → mm");
  const g = { pxMm: 0.5, pyMm: 0.5, dz: 2, origin: [0, 0, 0] as [number, number, number] };
  const pts = ringPoints(simple, g, 3, 200);
  assert.equal(pts.length % 3, 0, "üçlü koordinat");
  assert.equal(pts[2], 6, "z = origin + kesit × dz");
  // 5×5 blok = 25 piksel; iki kesit → 50 piksel × 0.25 mm² × 2 mm = 25 mm³ = 0,03 mL
  assert.equal(volumeMl([kare, kare], 0.5, 0.5, 2), 0.03, "50 piksel × 0.25 mm² × 2 mm = 25 mm³");
  assert.equal(volumeMl([], 1, 1, 1), 0, "boş hacim 0");
  console.log("PASS mm dönüşümü + hacim");

  // ── 5) Kesitler arası tutarlılık ────────────────────────────────────
  const s0 = fromRows(["#.", ".."]), s1 = fromRows(["#.", ".."]), s2 = fromRows([".#", ".."]);
  const bosKesit = removeIslands([s0, s1, makeMask(2, 2)], 1);
  assert.deepEqual(bosKesit.removed, [], "boş kesit 'adacık' sayılmaz (silinecek bir şey yok)");
  const ada = removeIslands([makeMask(2, 2), s0, makeMask(2, 2)], 1);
  assert.deepEqual(ada.removed, [1], "tek kesitlik adacık silinir");
  assert.equal(pixelCount(ada.slices[1]), 0, "silinen kesit boş");
  assert.equal(pixelCount(ada.slices[0]), 0, "komşusuz boş kesitler değişmez");
  const koru = removeIslands([s0, s2], 1);
  assert.deepEqual(koru.removed, [], "komşu kesit varsa silinmez");

  const a = fromRows(["##..", "##..", "....", "...."]), b = fromRows(["..##", "..##", "....", "...."]);
  assert.equal(dice(a, a), 1, "kendisiyle Dice 1");
  assert.equal(dice(a, b), 0, "ayrık maskeler Dice 0");
  assert.equal(dice(makeMask(2, 2), makeMask(2, 2)), null, "boş/boş → null");
  assert.throws(() => dice(a, makeMask(2, 2)), /aynı boyutta/, "boyut uyuşmazlığı");
  const yarim = fromRows(["##..", "##..", "....", "...."]), yarim2 = fromRows(["##..", "....", "....", "...."]);
  assert.equal(dice(yarim, yarim2), Math.round((2 * 2) / 6 * 1000) / 1000, "kısmi örtüşme 2/3");

  const birlesim = combineMasks(a, b, "union");
  assert.equal(pixelCount(birlesim), 8, "birleşim 8 piksel");
  assert.equal(pixelCount(combineMasks(a, b, "intersect")), 0, "kesişim boş");
  const fark = combineMasks(fromRows(["##..", "##..", "....", "...."]), fromRows(["#...", "....", "....", "...."]), "difference");
  assert.equal(pixelCount(fark), 3, "fark 3 piksel");
  console.log("PASS kesit tutarlılığı (adacık, Dice, birleştirme)");

  // ── 6) Özet ve RTSTRUCT yazımı ──────────────────────────────────────
  const ozet = editSummary([kare], [1, 3], [rapor]);
  assert.match(ozet, /tek kesitlik adacık silindi: 2, 4/, "silinen kesitler 1-tabanlı");
  assert.match(ozet, /Kontur düzeltmesi: 1 halka/, "halka sayısı");
  assert.match(ozet, /hekim düzeltmesine tabidir/, "sorumluluk notu");

  const rt = buildRtStruct({
    patientName: "AYSE YILMAZ", patientId: "P1", patientSex: "F",
    studyUid: "1.2.840.1", studyDate: "2026-03-04", institution: "Test",
    source: { seriesUid: "1.2.840.2", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.840.3"] },
    geometry: { pxMm: 0.7, pyMm: 0.7, dz: 1.5, origin: [-10, -20, 5] },
    width: 5, height: 5,
    rois: [{ def: { segmentNumber: 1, label: "Lezyon", color: [255, 0, 0], algorithmType: "MANUAL", algorithmName: "AtikViewer" }, mask: { slices: new Map([[0, halka.data]]), width: 5, height: 5 } }],
  });
  assert.ok(rt.length > 500, "RTSTRUCT üretildi");
  const text = Buffer.from(rt).toString("latin1");
  assert.ok(text.includes("CLOSED_PLANAR"), "kontur tipi yazıldı");
  assert.ok(text.includes("Lezyon"), "ROI adı yazıldı");
  assert.ok(text.includes("1.2.840.10008.5.1.4.1.1.481.5"), "SOP Class UID");
  console.log("PASS özet + RTSTRUCT (delikli maskeden kontur)");

  // ── 7) Kaynak sözleşmesi ────────────────────────────────────────────
  const seg = read("src/lib/dicomSeg.ts");
  assert.ok(seg.includes("maskContours") && seg.includes("traceContours"), "RTSTRUCT gerçek izlemeyi kullanır");
  assert.ok(seg.includes("c.hole ? [...c.pts].reverse()"), "delik halkası ters yönde yazılır");
  assert.ok(seg.includes("maskContour("), "eski fonksiyon geriye dönük uyumluluk için duruyor");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "c-seg-rtstruct"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:segedit"]?.includes("seg-editing"), "test betiği kayıtlı");
  console.log("PASS kaynak sözleşmesi");

  console.log("Tüm c-seg-rtstruct (kontur izleme + düzenleme) testleri geçti.");
}

main();

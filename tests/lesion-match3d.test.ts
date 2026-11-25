/**
 * c-recist-full: 3B lezyon eşleştirme (rijit hizalama + karşılıklı eşleşme).
 *
 * Sınanan: Horn kuaterniyon hizalamasının doğruluğu (bilinen dönme+ötelenme geri
 * kazanımı), yansıma üretmemesi, az noktada dönme belirsizliğinin raporlanması,
 * karşılıklı olmayan eşleşmenin **belirsiz** sayılması, eşik dışının "kayboldu"
 * olması, yeni lezyonların yakalanması ve anatomi uyuşmazlığı.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ALIGN_GATE,
  alignmentAcceptable,
  applyRigid,
  centroid,
  jacobiEigenSymmetric,
  MATCH_DEFAULTS,
  matchCsv,
  matchLesions3d,
  quaternionToRotation,
  rigidAlign,
  type Lesion3D,
  type Vec3,
} from "../src/lib/lesionMatch3d";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const L = (id: string, x: number, y: number, z: number, extra: Partial<Lesion3D> = {}): Lesion3D => ({ id, x, y, z, ...extra });

/** Bilinen dönme (z ekseni 90°) + ötelenme uygular. */
const rotZ90 = (p: Vec3): Vec3 => ({ x: -p.y, y: p.x, z: p.z });
const shift = (p: Vec3, d: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });

function main() {
  // ── 1) Jacobi + kuaterniyon dönüşümü ────────────────────────────────
  const diag = jacobiEigenSymmetric([[3, 0, 0], [0, 1, 0], [0, 0, 2]]);
  assert.deepEqual(diag.values, [3, 2, 1], "özdeğerler azalan");
  const known = [[2, 1, 0], [1, 2, 0], [0, 0, 5]];
  const eig = jacobiEigenSymmetric(known);
  assert.ok(Math.abs(eig.values[0] - 5) < 1e-9, "en büyük özdeğer 5");
  assert.ok(Math.abs(eig.values[1] - 3) < 1e-9, "ikinci 3");
  assert.ok(Math.abs(eig.values[2] - 1) < 1e-9, "üçüncü 1");
  // Özvektör denetimi: A v = λ v
  const v = eig.vectors[0];
  const av = [0, 1, 2].map((r) => known[r][0] * v[0] + known[r][1] * v[1] + known[r][2] * v[2]);
  assert.ok(av.every((x, i) => Math.abs(x - eig.values[0] * v[i]) < 1e-6), "özvektör denklemi sağlar");

  const r90 = quaternionToRotation(Math.cos(Math.PI / 4), 0, 0, Math.sin(Math.PI / 4));
  assert.ok(Math.abs(r90[0][0]) < 1e-9 && Math.abs(r90[0][1] + 1) < 1e-9, "z ekseninde 90° dönme");
  const det = r90[0][0] * (r90[1][1] * r90[2][2] - r90[1][2] * r90[2][1]) - r90[0][1] * (r90[1][0] * r90[2][2] - r90[1][2] * r90[2][0]) + r90[0][2] * (r90[1][0] * r90[2][1] - r90[1][1] * r90[2][0]);
  assert.ok(Math.abs(det - 1) < 1e-9, "dönme matrisi determinantı +1 (yansıma yok)");
  assert.deepEqual(centroid([{ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 }]), { x: 1, y: 2, z: 3 }, "ağırlık merkezi");
  assert.deepEqual(centroid([]), { x: 0, y: 0, z: 0 }, "boş küme");
  console.log("PASS Jacobi + kuaterniyon dönüşümü (determinant +1)");

  // ── 2) Rijit hizalama: bilinen dönüşümü geri kazan ──────────────────
  const src: Vec3[] = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 },
    { x: 0, y: 0, z: 10 }, { x: 10, y: 10, z: 10 }, { x: 5, y: -3, z: 7 },
  ];
  const D = { x: 12, y: -8, z: 25 };
  const tgt = src.map((p) => shift(rotZ90(p), D));
  const T = rigidAlign(src, tgt);
  assert.ok(T, "hizalama hesaplandı");
  assert.equal(T!.rmsMm, 0, "artık 0 mm (tam uyum)");
  assert.equal(T!.scale, 1, "ölçek 1");
  assert.match(T!.note, /Rijit hizalama: 6 nokta, artık 0 mm/, "not bilgi verir");
  for (const p of src) {
    const q = applyRigid(T!, p);
    const e = shift(rotZ90(p), D);
    assert.ok(Math.abs(q.x - e.x) < 1e-6 && Math.abs(q.y - e.y) < 1e-6 && Math.abs(q.z - e.z) < 1e-6, `nokta geri kazanıldı (${JSON.stringify(p)})`);
  }
  // Yansıma tuzağı: nokta kümesi kendi ayna görüntüsüyle eşleşmeye çalışılırsa determinant +1 kalmalı.
  const mirror = src.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
  const Tm = rigidAlign(src, mirror)!;
  const detM = Tm.rotation[0][0] * (Tm.rotation[1][1] * Tm.rotation[2][2] - Tm.rotation[1][2] * Tm.rotation[2][1]) - Tm.rotation[0][1] * (Tm.rotation[1][0] * Tm.rotation[2][2] - Tm.rotation[1][2] * Tm.rotation[2][0]) + Tm.rotation[0][2] * (Tm.rotation[1][0] * Tm.rotation[2][1] - Tm.rotation[1][1] * Tm.rotation[2][0]);
  assert.ok(detM > 0, "yansıma yerine dönme tercih edilir (det +1)");

  // Az noktada dönme belirsiz
  const T1 = rigidAlign([{ x: 0, y: 0, z: 0 }], [{ x: 5, y: 5, z: 5 }])!;
  assert.match(T1.note, /yalnız ötelenme hesaplandı; dönme belirsiz/, "tek noktada uyarı");
  assert.equal(T1.translation.x, 5, "ötelenme doğru");
  const T2 = rigidAlign([src[0], src[1]], [tgt[0], tgt[1]])!;
  assert.match(T2.note, /2 nokta ile yalnız ötelenme/, "iki noktada uyarı");
  assert.equal(rigidAlign([], []), null, "nokta yoksa null");

  // Hizalama kapısı: artık hata ve ölçek denetimi
  assert.equal(alignmentAcceptable(null).ok, false, "hizalama yoksa kapı kapalı");
  assert.equal(alignmentAcceptable({ rotation: [[1,0,0],[0,1,0],[0,0,1]], translation: { x:0,y:0,z:0 }, rmsMm: 3, scale: 1, note: "n" }).ok, true, "küçük artık kabul");
  assert.match(alignmentAcceptable({ rotation: [[1,0,0],[0,1,0],[0,0,1]], translation: { x:0,y:0,z:0 }, rmsMm: 40, scale: 1, note: "n" }).reason, /artık hata 40 mm/, "büyük artık reddedilir");
  assert.match(alignmentAcceptable({ rotation: [[1,0,0],[0,1,0],[0,0,1]], translation: { x:0,y:0,z:0 }, rmsMm: 1, scale: 1.4, note: "n" }).reason, /ölçek farkı 1.4/, "ölçek farkı reddedilir");
  assert.equal(ALIGN_GATE.maxRmsMm, 10, "artık eşiği 10 mm");
  assert.equal(ALIGN_GATE.maxScaleDrift, 0.15, "ölçek eşiği %15");

  // Ölçek farkı yakalanır (rijit varsayım ihlali)
  const scaled = src.map((p) => ({ x: p.x * 1.5, y: p.y * 1.5, z: p.z * 1.5 }));
  const Ts = rigidAlign(src, scaled)!;
  assert.equal(Ts.scale, 1.5, "ölçek 1.5");
  assert.match(Ts.note, /Ölçek farkı 1.5/, "ölçek farkı uyarısı");
  console.log("PASS rijit hizalama (tam geri kazanım, yansıma yok, ölçek uyarısı)");

  // ── 3) Eşleştirme: bazal/izlem ──────────────────────────────────────
  const base = [
    L("B1", -40, 10, 0, { longMm: 20, volumeMm3: 4000, anatomy: "Akciger" }),
    L("B2", 0, 10, 0, { longMm: 15, volumeMm3: 1800, anatomy: "Akciger" }),
    L("B3", 40, 10, 0, { longMm: 25, volumeMm3: 8000, anatomy: "Karaciger" }),
  ];
  // Aynı lezyonlar + küçük ötelenme (yeni çalışma, farklı çerçeve) + B2 büyümüş
  const follow = [
    L("F1", -39, 26, 0, { longMm: 22, volumeMm3: 5300, anatomy: "Akciger" }),
    L("F2", 1, 26, 0, { longMm: 18, volumeMm3: 2900, anatomy: "Akciger" }),
    L("F3", 41, 26, 0, { longMm: 25, volumeMm3: 8000, anatomy: "Karaciger" }),
  ];
  const res = matchLesions3d(base, follow);
  assert.equal(res.matches.filter((m) => m.status === "eslesti").length, 3, "üç kesin eşleşme");
  assert.equal(res.ambiguous, 0, "belirsiz yok");
  const b2 = res.matches.find((m) => m.baseline?.id === "B2")!;
  assert.equal(b2.followUp?.id, "F2", "büyüyen lezyon eşleşti");
  assert.equal(b2.sizeRatio, 1.2, "çap oranı 18/15");
  assert.equal(b2.volumeRatio, Math.round((2900 / 1800) * 1000) / 1000, "hacim oranı");
  assert.ok((b2.distanceMm ?? 99) <= 2, "hizalama sonrası mesafe küçük");
  assert.match(res.note, /3 kesin, 0 belirsiz/, "özet notu");
  console.log("PASS eşleştirme (hizalama + çap/hacim oranı)");

  // ── 4) Yeni ve kaybolan lezyonlar ───────────────────────────────────
  const base2 = [L("B1", 0, 0, 0, { longMm: 10 }), L("B2", 50, 0, 0, { longMm: 12 }), L("B3", 100, 0, 0, { longMm: 14 })];
  const follow2 = [L("F1", 0, 0, 0, { longMm: 10 }), L("F3", 100, 0, 0, { longMm: 14 }), L("F9", 300, 0, 0, { longMm: 8 })];
  const r2 = matchLesions3d(base2, follow2);
  assert.equal(r2.matches.filter((m) => m.status === "yeni").length, 1, "bir yeni lezyon");
  assert.equal(r2.matches.find((m) => m.status === "yeni")!.followUp?.id, "F9", "yeni lezyon F9");
  // Lezyon kümeleri karşılıklı değilken (kayboldu/yeni varken) hizalama
  // REDDEDİLMELİ; aksi halde tüm noktalar yanlış yere taşınır.
  assert.equal(r2.transform, null, "güvenilmez hizalama uygulanmaz");
  assert.match(r2.rejected, /Hizalama reddedildi: artık hata/, "ret gerekçesi yazılır");
  assert.match(r2.note, /reddedildi/, "özet notu reddi içerir");
  assert.equal(r2.matches.find((m) => m.baseline?.id === "B1")!.status, "eslesti", "ham koordinatla doğru eşleşme");

  const kayip = r2.matches.filter((m) => m.status === "kayboldu");
  assert.ok(kayip.some((m) => m.baseline?.id === "B2"), "B2 kayboldu olarak raporlanır");
  assert.equal(kayip.find((m) => m.baseline?.id === "B2")!.followUp, null, "kaybolmuş eşleşmede izlem yok");
  console.log("PASS yeni/kayboldu (sessiz düşürme yok)");

  // ── 5) Belirsiz eşleşme politikası ──────────────────────────────────
  // İki bazal lezyon, tek izlem lezyonu: karşılıklılık bozulur.
  const base3 = [L("B1", 0, 0, 0, { longMm: 10 }), L("B2", 6, 0, 0, { longMm: 11 })];
  const follow3 = [L("F1", 3, 0, 0, { longMm: 10.5 })];
  const r3 = matchLesions3d(base3, follow3);
  const belirsiz = r3.matches.filter((m) => m.status === "belirsiz");
  assert.ok(belirsiz.length >= 1, "en az bir belirsiz eşleşme");
  assert.ok(belirsiz.some((m) => m.note.includes("karşılıklı değil")), "karşılıklılık gerekçesi yazılır");
  assert.equal(r3.ambiguous, belirsiz.length, "belirsiz sayacı tutarlı");

  // Anatomi zorunluluğu: farklı anatomide yakın lezyon belirsiz olur.
  const r4 = matchLesions3d([L("B1", 0, 0, 0, { anatomy: "Akciger" })], [L("F1", 1, 0, 0, { anatomy: "Karaciger" })], { requireAnatomy: true });
  assert.equal(r4.matches[0].status, "belirsiz", "anatomi uyuşmazlığı belirsiz");
  assert.match(r4.matches[0].note, /anatomi etiketi uyuşmuyor/, "gerekçe");
  const r5 = matchLesions3d([L("B1", 0, 0, 0, { anatomy: "Akciger" })], [L("F1", 1, 0, 0, { anatomy: "Karaciger" })]);
  assert.equal(r5.matches[0].status, "eslesti", "anatomi zorunlu değilse mesafe yeter");

  // Eşik ayarı: daraltılınca kesin eşleşme belirsize düşer.
  const r6 = matchLesions3d([L("B1", 0, 0, 0)], [L("F1", 12, 0, 0)], { maxMm: 5, ambiguousMm: 30 });
  assert.equal(r6.matches[0].status, "belirsiz", "eşik dışı → belirsiz (kayboldu değil, 30 mm içinde)");
  const r7 = matchLesions3d([L("B1", 0, 0, 0)], [L("F1", 80, 0, 0)], { maxMm: 5, ambiguousMm: 30 });
  assert.equal(r7.matches[0].status, "kayboldu", "eşik çok dışı → kayboldu");
  assert.equal(MATCH_DEFAULTS.maxMm, 15, "varsayılan kesin eşik 15 mm");
  assert.equal(MATCH_DEFAULTS.ambiguousMm, 25, "varsayılan belirsiz eşiği 25 mm");
  console.log("PASS belirsiz eşleşme politikası (karşılıklılık, anatomi, eşik)");

  // ── 6) CSV ve boş durumlar ──────────────────────────────────────────
  const csv = matchCsv(res.matches);
  assert.match(csv.split("\n")[0], /^Bazal;İzlem;Durum;Mesafe \(mm\);Çap oranı;Hacim oranı;Not$/, "CSV başlığı");
  assert.equal(csv.split("\n").length, 4, "başlık + üç satır");
  assert.match(csv, /B2;F2;eslesti/, "eşleşme satırı");
  assert.equal(matchCsv([]).split("\n").length, 1, "boş CSV yalnız başlık");

  const bos = matchLesions3d([], []);
  assert.deepEqual(bos.matches, [], "boş giriş");
  assert.equal(bos.transform, null, "hizalama yok");
  assert.match(bos.note, /Hizalama yapılamadı/, "gerekçe");
  const tekTaraf = matchLesions3d([L("B1", 0, 0, 0)], []);
  assert.equal(tekTaraf.matches[0].status, "kayboldu", "izlem yoksa bazal kayboldu");
  const tekIzlem = matchLesions3d([], [L("F1", 0, 0, 0)]);
  assert.equal(tekIzlem.matches[0].status, "yeni", "bazal yoksa yeni");
  console.log("PASS CSV + boş/tek taraflı durumlar");

  // ── 7) Kaynak sözleşmesi ────────────────────────────────────────────
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "c-recist-full"[\s\S]{0,3200}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:lesion3d"]?.includes("lesion-match3d"), "test betiği kayıtlı");
  const src3d = read("src/lib/lesionMatch3d.ts");
  assert.ok(src3d.includes("quaternionToRotation") && src3d.includes("jacobiEigenSymmetric"), "kuaterniyon yolu");
  assert.ok(src3d.includes("mutual") && src3d.includes("ambiguous"), "karşılıklılık ve belirsizlik ele alınır");
  console.log("PASS kaynak sözleşmesi");

  console.log("Tüm c-recist-full (3B eşleştirme) testleri geçti.");
}

main();

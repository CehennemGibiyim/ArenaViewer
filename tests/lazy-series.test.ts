/**
 * Tam lazy-pixel Adım 1: QIDO instance ayrıştırma + kesit sıralaması + iskelet dizi tahsisi.
 * Bu adım görüntüleyici davranışını DEĞİŞTİRMEZ; saf birim testleri.
 */
import { groupInstancesBySeries, orderInstances, buildSeriesSkeleton, SKELETON_MAX_BYTES } from "../src/lib/lazySeries";
import { parseQidoInstances } from "../src/lib/server/pacs";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── parseQidoInstances: alanlar güvenli çıkarılır, eksikler atlanır ──
const arr = [
  { "0020000E": { Value: ["1.2.3.S1"] }, "00080018": { Value: ["1.2.3.I1"] }, "00200013": { Value: ["3"] }, "00200032": { Value: ["10", "-20", "12.5"] }, "00180050": { Value: ["1.5"] }, "00280010": { Value: [512] }, "00280011": { Value: [512] } },
  { "0020000E": { Value: ["1.2.3.S1"] }, "00080018": { Value: ["1.2.3.I2"] }, "00200013": { Value: ["1"] }, "00200032": { Value: ["10", "-20", "-5.5"] }, "00180050": { Value: ["1.5"] }, "00280010": { Value: [512] }, "00280011": { Value: [512] } },
  { "0020000E": { Value: ["1.2.3.S1"] }, "00080018": { Value: ["1.2.3.I3"] }, "00200013": { Value: ["2"] }, "00200032": { Value: ["10", "-20", "3.0"] }, "00180050": { Value: ["1.5"] }, "00280010": { Value: [512] }, "00280011": { Value: [512] } },
  { "0020000E": { Value: ["1.2.3.S1"] }, "00080018": { Value: ["1.2.3.I4"] } }, // künye yok
];
const parsed = parseQidoInstances(arr as never);
ok(parsed.length === 4, "4 örnek ayrıştırıldı");
ok(parsed[0].instanceNumber === 3 && parsed[0].sliceLocation === 12.5 && parsed[0].sliceThickness === 1.5, "InstanceNumber/z/thickness çıkarıldı");
ok(parsed[3].instanceNumber === undefined && parsed[3].sliceLocation === undefined && parsed[3].rows === undefined, "eksik alanlar undefined (NaN değil)");

// string sayılar ve dize olmayan değer
const p2 = parseQidoInstances([
  { "0020000E": { Value: ["1.2.S"] }, "00080018": { Value: ["1.2.S.1"] }, "00200013": { Value: ["7"] }, "00200032": { Value: ["0", "0", "abc"] } },
] as never);
ok(p2[0].instanceNumber === 7 && p2[0].sliceLocation === undefined, "IPP z sayıya çevrilemezse undefined (sessiz 0 yok)");
ok(parseQidoInstances(null as never).length === 0, "null dizi güvenli");

// ── sıralama: z varsa z, yoksa InstanceNumber, yoksa ham sıra ──
const unordered = [
  { seriesUid: "S", sopUid: "c", instanceNumber: 3, sliceLocation: 12.5, rows: 4, cols: 4 },
  { seriesUid: "S", sopUid: "a", instanceNumber: 1, sliceLocation: -5.5, rows: 4, cols: 4 },
  { seriesUid: "S", sopUid: "b", instanceNumber: 2, sliceLocation: 3.0, rows: 4, cols: 4 },
];
ok(orderInstances(unordered).map((i) => i.sopUid).join() === "a,b,c", "z küçükten büyüğe sıralandı");
const byNumber = unordered.map((i) => ({ ...i, sliceLocation: undefined }));
ok(orderInstances(byNumber).map((i) => i.sopUid).join() === "a,b,c", "z yoksa InstanceNumber'a göre sıralanır");
const noKeys = [
  { seriesUid: "S", sopUid: "x", rows: 4, cols: 4 },
  { seriesUid: "S", sopUid: "y", rows: 4, cols: 4 },
];
ok(orderInstances(noKeys).map((i) => i.sopUid).join() === "x,y", "hiçbir anahtar yoksa ham sıra korunur (kararlı)");
const mixed = [
  { seriesUid: "S", sopUid: "z1", sliceLocation: 5, rows: 4, cols: 4 },
  { seriesUid: "S", sopUid: "n1", instanceNumber: 1, rows: 4, cols: 4 },
  { seriesUid: "S", sopUid: "z0", sliceLocation: -5, rows: 4, cols: 4 },
];
const mx = orderInstances(mixed).map((i) => i.sopUid);
ok(mx[0] === "z0" && mx[1] === "z1" && mx[2] === "n1", "z'li örnekler öne, z'sizler InstanceNumber'a göre sona");

// ── grup: seri bazında ayrılır ──
const grouped = groupInstancesBySeries([
  { seriesUid: "A", sopUid: "1", rows: 2, cols: 2 },
  { seriesUid: "B", sopUid: "2", rows: 2, cols: 2 },
  { seriesUid: "A", sopUid: "3", rows: 2, cols: 2 },
]);
ok(grouped.size === 2 && grouped.get("A")!.map((i) => i.sopUid).join() === "1,3", "seri gruplaması");

// ── iskelet: künye + sıfır Int16Array slices ──
const sk = buildSeriesSkeleton({
  instances: [
    { seriesUid: "1.2.S", sopUid: "1.2.S.2", instanceNumber: 2, sliceLocation: 10, sliceThickness: 1.5, rows: 4, cols: 4 },
    { seriesUid: "1.2.S", sopUid: "1.2.S.1", instanceNumber: 1, sliceLocation: 0, sliceThickness: 1.5, rows: 4, cols: 4 },
  ],
  studyUid: "1.2.STUDY",
  modality: "CT",
  description: "Toraks",
  defaultWL: 40, defaultWW: 400, pixelSpacing: 0.75,
});
ok(sk.slices.length === 2 && sk.sopUids.join() === "1.2.S.1,1.2.S.2", "dilimler z sırasıyla, sopUids hizalı");
ok(sk.slices[0] instanceof Int16Array && sk.slices[0].length === 16, "sıfır Int16Array tahsisli");
ok(sk.slices.every((s) => s.every((v) => v === 0)), "tüm pikseller sıfır (yerinde doldurulacak)");
ok(sk.slicePositions.join() === "0,10" && sk.sliceThickness === 1.5, "kesit konumları ve kalınlık");
ok(sk.width === 4 && sk.height === 4 && sk.allocatedBytes === 2 * 16 * 2, "boyut ve bayt muhasebesi");
ok(sk.modality === "CT" && sk.defaultWL === 40 && sk.pixelSpacing === 0.75, "künye alanları");

// bir kesitte z eksikse positions boş kalır (kısmi dizi yazılmaz)
const skNoZ = buildSeriesSkeleton({ instances: [
  { seriesUid: "S", sopUid: "1", instanceNumber: 1, rows: 2, cols: 2 },
  { seriesUid: "S", sopUid: "2", instanceNumber: 2, sliceLocation: 3, rows: 2, cols: 2 },
], studyUid: "ST" });
ok(skNoZ.slicePositions.length === 0, "kısmi z varsa slicePositions boş (karışık veri yazılmaz)");

// boyut bilinmiyorsa / bellek tavanı aşılırsa açık hata
try { buildSeriesSkeleton({ instances: [{ seriesUid: "S", sopUid: "1" }], studyUid: "ST" }); ok(false, "boyutsuz iskelet hatası fırlatmalı"); }
catch (e) { ok(String((e as Error).message).includes("Rows/Columns"), "boyutsuz iskelette açık hata"); }
try { buildSeriesSkeleton({ instances: [{ seriesUid: "S", sopUid: "1", rows: 512, cols: 512 }], studyUid: "ST", maxBytes: 1024 }); ok(false, "bellek tavanı hatası fırlatmalı"); }
catch (e) { ok(String((e as Error).message).includes("çok büyük"), "bellek tavanı açık hata"); }
ok(SKELETON_MAX_BYTES > 0, "varsayılan tavan tanımlı");

if (failed) { console.error(`${failed} lazy-series testi başarısız`); process.exit(1); }
console.log("Tüm lazy-series (Adım 1) testleri geçti.");

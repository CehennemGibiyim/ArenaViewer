/**
 * e-stow seçimli gönderme: nesne türü seçiminin yanı sıra «kesit aralığı» (seri parçası)
 * seçiminin istemcide kırpıldığını ve sunucuda doğrulandığını sınar.
 * Kanıt zinciri: subSeriesForRange → buildAnonymizedDicom → planAnonStow →
 * parseAnonSelection → selectionInstanceCountError → rota sözleşmesi.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { subSeriesForRange, rangeLength } from "../src/lib/anonRange";
import { parseAnonSelection, selectionInstanceCountError, planAnonStow } from "../src/lib/stowPayload";
import { buildAnonymizedDicom } from "../src/lib/dicomWrite";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const dsOf = (n: number) => String(+n.toFixed(4)).slice(0, 16);

// ── 1) subSeriesForRange: dilim, konum ve UID'ler birlikte kesilir ──
const positions = [-140, -130, -120, -110, -100, -90, -80, -70];
const sops = positions.map((_, i) => `1.2.826.0.1.3680043.8.498.${100 + i}`);
const mkSeries = (): SeriesData => ({
  id: "s1", modality: "CT", description: "Toraks", bodyPart: "TORAKS",
  patientName: "GİZLİ^HASTA", patientId: "TC-123456", patientAge: "050Y", patientSex: "M",
  studyDate: "2026-11-20", institution: "TEST", studyUid: "1.2.3.4",
  width: 4, height: 4, pixelSpacing: 0.7, sliceThickness: 1, defaultWL: 40, defaultWW: 400, unit: "HU",
  slices: positions.map((_, i) => new Int16Array(16).fill(i * 10)),
  slicePositions: [...positions],
  sopUids: [...sops],
  sopClassUid: "1.2.840.10008.5.1.4.1.1.2", seriesUid: "1.2.3.4.5.6.7",
} as unknown as SeriesData);

const full = mkSeries();
const sub = subSeriesForRange(full, 3, 5);
ok(sub.slices.length === 3 && sub.sopUids?.length === 3 && sub.slicePositions?.length === 3, "seçili 3 kesit kesildi (dilim+UID+konum birlikte)");
ok(sub.sopUids?.[0] === sops[2] && sub.sopUids?.[2] === sops[4], "UID dilimleme doğru kesitlere işaret ediyor");
ok(sub.slicePositions?.[0] === -120 && sub.slicePositions?.[2] === -100, "kesit konumları korunarak kesildi");
ok(sub.slices[0][0] === 20, "piksel içeriği seçili aralığa ait");
ok(full.slices.length === 8 && full.sopUids?.length === 8, "orijinal seri nesnesi değişmeden kalır");
ok(sub.studyUid === full.studyUid && sub.modality === "CT", "seri üst verileri korunur");
ok(rangeLength(3, 5, 8) === 3 && sub.slices.length === rangeLength(3, 5, 8), "rangeLength ile tutarlı");

// Sınırlar: taşma, ters sıra, sonlu olmayan girişler
ok(subSeriesForRange(full, 0, 2).slicePositions?.[0] === positions[0], "from < 1 → 1'e kırpılır");
ok(subSeriesForRange(full, 7, 99).slicePositions?.join() === [positions[6], positions[7]].join(), "to > total → toplam'a kırpılır");
ok(subSeriesForRange(full, 6, 2).slices.length === 1, "from > to → tek kesit (from)");
ok(subSeriesForRange(full, NaN, NaN).slices.length === 8, "sonlu olmayan girişler tüm seriye düşer");
ok(rangeLength(NaN, NaN, 8) === 8 && rangeLength(5, 2, 8) === 1 && rangeLength(0, 0, 0) === 0, "rangeLength sınırları");
const empty = subSeriesForRange({ ...full, slices: [], slicePositions: [], sopUids: [] }, 1, 5);
ok(empty.slices.length === 0 && empty.slicePositions!.length === 0 && empty.sopUids!.length === 0, "boş seride tanımsız kesit üretilmez");

// ── 2) Uçtan uca: yalnız seçili parçadan bayt üretilir ──
const src = mkSeries();
const all = buildAnonymizedDicom(src, "STEST");
ok(all.length === 8, "tüm seride 8 anonim dosya");
const rangeSeries = subSeriesForRange(src, 3, 5);
const rangeFiles = buildAnonymizedDicom(rangeSeries, "STEST");
ok(rangeFiles.length === 3, "aralık seçiminde yalnız 3 anonim dosya üretildi");
const body = Buffer.concat(rangeFiles.map((f) => Buffer.from(f.bytes))).toString("latin1");
for (const i of [2, 3, 4]) ok(body.includes(dsOf(positions[i])), `seçili kesit ${i + 1} konumu baytlarda var`);
for (const i of [0, 1, 5, 6, 7]) ok(!body.includes(dsOf(positions[i])), `seçili OLMAYAN kesit ${i + 1} konumu baytlarda YOK`);
ok(!body.includes("GİZLİ") && !body.includes("1.2.3.4.5.6.7"), "kimlik ve orijinal seri UID'i yine taşınmaz");
const plan = planAnonStow(rangeFiles.map((f) => ({ name: f.name, bytes: f.bytes })), rangeSeries.sopUids);
ok(plan.ok && plan.count === 3, "plan yalnız seçili 3 kesitle oluşturuldu");
ok(planAnonStow(rangeFiles.map((f) => ({ name: f.name, bytes: f.bytes })), undefined).ok === false, "kaynağı UID'siz parçada gönderim reddedilir");

// ── 3) parseAnonSelection: hiç yoksa serbest, varsa sıkı doğrulama ──
const none = parseAnonSelection(undefined);
ok(none.ok && none.value === null, "selection yok → kabul (eski istemciler)");
const good = parseAnonSelection({ from: 3, to: 5, total: 8 });
ok(good.ok && good.value?.from === 3 && good.value.to === 5 && good.value.total === 8, "geçerli seçim kabul edilir");
for (const bad of [
  ["nesne değil", 5],
  ["sayısal değil", { from: "x", to: 5, total: 8 }],
  ["from < 1", { from: 0, to: 5, total: 8 }],
  ["to < from", { from: 6, to: 2, total: 8 }],
  ["total < to", { from: 1, to: 9, total: 8 }],
  ["total taşma", { from: 1, to: 2, total: 100_001 }],
] as const) {
  const r = parseAnonSelection(bad[1]);
  ok(!r.ok, `seçim reddi: ${bad[0]}`);
}
ok(parseAnonSelection(null).ok, "açık null → seçim yok sayılır");

// ── 4) Seçim ↔ örnek sayısı bire bir eşleşmesi (seçim dışı örnek sunucu reddeder) ──
const sel = { from: 3, to: 5, total: 8 };
ok(selectionInstanceCountError(sel, 3) === null, "aralıkla eşleşen 3 örnek kabul edilir");
ok(selectionInstanceCountError(sel, 4) !== null, "seçim dışı fazladan örnek reddedilir");
ok(selectionInstanceCountError(sel, 2) !== null, "eksik örnek reddedilir");
ok(selectionInstanceCountError(sel, 3) === null && selectionInstanceCountError({ from: 1, to: 1, total: 1 }, 1) === null, "tek kesitlik seçim desteklenir");

// ── 5) Rota sözleşmesi: seçim denetimi STOW'dan ÖNCE, denetime yazılır ──
const root = path.resolve(__dirname, "..");
const route = readFileSync(path.join(root, "src/app/api/pacs/stow/route.ts"), "utf8");
ok(route.includes("parseAnonSelection") && route.includes("selectionInstanceCountError"), "rota seçim doğrulamasını çağırıyor");
const anonIdx = route.indexOf("async function stowAnon");
const anonBody = anonIdx >= 0 ? route.slice(anonIdx) : "";
ok(anonBody.includes("selectionInstanceCountError(sel.value") && anonBody.indexOf("selectionInstanceCountError(sel.value") < anonBody.indexOf("stowInstance(cfg, bytes)"), "seçim denetimi anonim gönderimde PACS\'ten ÖNCE");
ok(/audit\(user, sum\.ok \? "pacs\.send_anon"[^]*?selection: sel\.value/.test(route), "gönderim denetim kaydına seçim yazılıyor");
const menu = readFileSync(path.join(root, "src/components/ExportMenu.tsx"), "utf8");
ok(menu.includes("subSeriesForRange") && menu.includes('kind: "anon"'), "arayüz anon gönderiminde parçayı kesiyor");
ok(menu.includes("selection: { from, to, total }"), "arayüz seçimi sunucuya bildiriyor");
ok(menu.includes("stow-type") && menu.includes("anon-range"), "arayüzde nesne türü + aralık seçim diyaloğu var");

if (failed) { console.error(`${failed} seçimli e-stow testi başarısız`); process.exit(1); }
console.log("Tüm e-stow seçimli gönderme testleri geçti.");

/**
 * e-hl7-mwl: Modality Worklist (DICOMweb + DIMSE C-FIND köprüsü) testleri.
 *
 * Sahte MWL sunucusuna karşı gerçek HTTP ile çalışır; ayrıca Implicit VR
 * ayrıştırıcı, süzme/sıralama ve "MWL → çalışma" eşlemesi saf fonksiyon olarak
 * sınanır. Köprü süreci (`scripts/mwl-cfind-proxy.ts`) ise `bin` arka ucu ile
 * uçtan uca çalıştırılır: HTTP → süreç → ham bayt → DICOM JSON.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fetchMwl } from "../src/lib/server/pacs";
import type { PacsConfig } from "../src/lib/pacsPresets";
import {
  ageFromBirthDate,
  filterMwl,
  formatDicomDateTime,
  formatPersonName,
  datasetToDicomJson,
  mwlFromDicomJson,
  mwlSummary,
  mwlToOrder,
  parseImplicitVr,
  sortMwl,
  findElement,
  isUsableMwlItem,
  MWL_STATUS_LABEL,
  type MwlItem,
} from "../src/lib/mwl";

let ROOT = "";
const cfg = (): PacsConfig =>
  ({
    kind: "custom",
    name: "mock",
    qidoRoot: `${ROOT}/dicom-web`,
    wadoRoot: "",
    auth: { type: "basic", username: "atik", password: "atik123", token: "", headerName: "", headerValue: "" },
    allowSelfSigned: false,
    limit: 50,
    includefield: false,
    notes: "",
  }) as PacsConfig;

function waitFor(child: ChildProcess, re: RegExp, label: string, ms = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} hazır olmadı`)), ms);
    child.stdout?.on("data", (b: Buffer) => {
      const m = re.exec(b.toString());
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.stderr?.on("data", (b: Buffer) => process.stderr.write(b));
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`${label} erken kapandı (${c})`)); });
  });
}

async function main() {
  // ── 1) Saf fonksiyonlar ────────────────────────────────────────────────
  assert.equal(formatPersonName("YILMAZ^AHMET"), "AHMET YILMAZ", "PN sırası");
  assert.equal(formatPersonName("KAYA^AYŞE^NUR"), "AYŞE NUR KAYA", "ikinci ad korunur");
  assert.equal(formatPersonName(""), "", "boş PN");
  assert.equal(formatDicomDateTime("20260115", "103000"), "2026-01-15T10:30:00", "DA+TM");
  assert.equal(formatDicomDateTime("20260115"), "2026-01-15", "yalnız DA");
  assert.equal(formatDicomDateTime("20260231"), "", "taşan tarih reddedilir");
  assert.equal(formatDicomDateTime("", "1030"), "", "tarih yoksa boş");
  assert.equal(formatDicomDateTime("2026011", "1030"), "", "eksik DA boş");
  assert.equal(ageFromBirthDate("1980-01-01", new Date("2026-01-01T00:00:00Z")), "46", "yaş tam gün");
  assert.equal(ageFromBirthDate("1980-06-01", new Date("2026-01-01T00:00:00Z")), "45", "doğum günü gelmedi");
  assert.equal(ageFromBirthDate("2026-02-31"), "", "geçersiz doğum tarihi");
  console.log("PASS ad/tarih/yaş biçimlendirme");

  // ── 2) DICOM JSON → MwlItem ────────────────────────────────────────────
  const sampleJson = [
    {
      "00100010": { vr: "PN", Value: [{ Alphabetic: "YILMAZ^AHMET" }] },
      "00100020": { vr: "LO", Value: ["H-1001"] },
      "00100030": { vr: "DA", Value: ["19800101"] },
      "00100040": { vr: "CS", Value: ["M"] },
      "00080050": { vr: "SH", Value: ["ACC-1001"] },
      "00080060": { vr: "CS", Value: ["CT"] },
      "00321060": { vr: "LO", Value: ["BEYIN BT (KONTRASLI)"] },
      "00400100": {
        vr: "SQ",
        Value: [{
          "00400001": { vr: "AE", Value: ["BT1"] },
          "00400002": { vr: "DA", Value: ["20260115"] },
          "00400003": { vr: "TM", Value: ["103000"] },
          "00400005": { vr: "SH", Value: ["STAT"] },
          "00400009": { vr: "SH", Value: ["SPS-1"] },
          "00400020": { vr: "CS", Value: ["SCHEDULED"] },
        }],
      },
      "0020000D": { vr: "UI", Value: ["1.2.3.4.5.6"] },
    },
    // Hasta kimliği yok → atılır
    { "00080060": { vr: "CS", Value: ["CT"] }, "00080050": { vr: "SH", Value: ["ACC-X"] } },
    // Kimlik var, ne accession ne işlem kimliği var → atılır
    { "00100020": { vr: "LO", Value: ["H-9"] } },
    // İptal edilmiş, accession var → tutulur
    {
      "00100020": { vr: "LO", Value: ["H-3"] },
      "00080050": { vr: "SH", Value: ["ACC-3"] },
      "00080060": { vr: "CS", Value: ["MR"] },
      "00400100": { vr: "SQ", Value: [{ "00400020": { vr: "CS", Value: ["CANCELLED"] } }] },
    },
  ];
  const items = mwlFromDicomJson(sampleJson);
  assert.equal(items.length, 2, "kullanılamaz ögeler atılır");
  const first = items[0];
  assert.equal(first.patientName, "AHMET YILMAZ", "hasta adı");
  assert.equal(first.modality, "CT", "modalite");
  assert.equal(first.scheduledStart, "2026-01-15T10:30:00", "planlanan başlangıç");
  assert.equal(first.status, "SCHEDULED", "durum");
  assert.equal(first.stepId, "SPS-1", "işlem adımı kimliği");
  assert.equal(first.studyInstanceUid, "1.2.3.4.5.6", "çalışma UID");
  assert.equal(items[1].status, "CANCELLED", "iptal durumu tanınır");
  assert.ok(isUsableMwlItem(first) && !isUsableMwlItem({ ...first, patientId: "" }), "kullanılabilirlik kuralı");
  assert.equal(mwlFromDicomJson(null).length, 0 && 0, "boş girdi");
  assert.equal(mwlFromDicomJson({}).length, 0, "dizi olmayan girdi");
  console.log("PASS DICOM JSON → worklist ögesi (+ geçersiz öge ayıklama)");

  // ── 3) Süzme / sıralama / özet ─────────────────────────────────────────
  const mk = (over: Partial<MwlItem>): MwlItem => ({
    accession: "A", patientId: "P", patientName: "AD SOYAD", patientBirthDate: "", patientSex: "",
    modality: "CT", bodyPart: "", description: "", scheduledStart: "2026-01-15T09:00:00",
    stationAeTitle: "", scheduledAeTitle: "", status: "SCHEDULED", stepId: "S", studyInstanceUid: "", priority: "", ...over,
  });
  const list = [
    mk({ accession: "A1", patientName: "YILMAZ AHMET", scheduledStart: "2026-01-15T11:00:00", modality: "MR" }),
    mk({ accession: "A2", patientName: "KAYA AYŞE", scheduledStart: "2026-01-15T09:00:00" }),
    mk({ accession: "A3", patientName: "DEMİR ÖMER", scheduledStart: "", status: "COMPLETED" }),
    mk({ accession: "A4", patientName: "IŞIK İLKER", scheduledStart: "2026-01-16T08:00:00", status: "CANCELLED" }),
  ];
  assert.deepEqual(sortMwl(list).map((i) => i.accession), ["A2", "A1", "A4", "A3"], "boş tarih sona");
  assert.deepEqual(filterMwl(list, { modality: "CT" }).map((i) => i.accession), ["A2", "A3", "A4"], "modalite süzgeci");
  assert.deepEqual(filterMwl(list, { date: "2026-01-15" }).map((i) => i.accession), ["A1", "A2"], "tarih süzgeci");
  assert.deepEqual(filterMwl(list, { onlyOpen: true }).map((i) => i.accession), ["A1", "A2"], "açık işler");
  // Türkçe büyük/küçük harf: "ı" ve "İ" doğru eşleşmeli.
  assert.deepEqual(filterMwl(list, { query: "ışık" }).map((i) => i.accession), ["A4"], "Türkçe küçültme (IŞIK)");
  assert.deepEqual(filterMwl(list, { query: "ayşe" }).map((i) => i.accession), ["A2"], "Türkçe küçültme (AYŞE)");
  assert.deepEqual(filterMwl(list, { query: "a3" }).map((i) => i.accession), ["A3"], "accession ile arama");
  assert.deepEqual(mwlSummary(list), { total: 4, open: 2, done: 1, cancelled: 1 }, "özet sayıları");
  assert.equal(MWL_STATUS_LABEL.CANCELLED, "İptal", "durum etiketi");
  console.log("PASS süzme + sıralama + özet");

  // ── 4) MWL → çalışma kaydı ─────────────────────────────────────────────
  const order = mwlToOrder(items[0]);
  assert.ok(order, "eşleme üretildi");
  assert.equal(order?.accessionNumber, "ACC-1001", "accession");
  assert.equal(order?.modality, "CT", "modalite");
  assert.equal(order?.patientAge, ageFromBirthDate("1980-01-01"), "yaş aktarılır");
  assert.equal(order?.studyUid, "1.2.3.4.5.6", "DICOM çalışma UID'si korunur");
  const noUid = mwlToOrder({ ...items[0], studyInstanceUid: "" });
  assert.equal(noUid?.studyUid, "mwl.ACC-1001", "UID yoksa accession'dan türetilir");
  assert.equal(mwlToOrder({ ...items[0], patientId: "" }), null, "kimliksiz öge eşlenmez");
  const noAccession = mwlToOrder({ ...items[0], accession: "" });
  assert.equal(noAccession?.accessionNumber, "SPS-1", "accession yoksa işlem kimliği kullanılır");
  console.log("PASS MWL → çalışma eşlemesi");

  // ── 5) Implicit VR ayrıştırıcı ─────────────────────────────────────────
  const el = (tag: number, text: string) => {
    const b = Buffer.from(text, "utf8");
    const pad = b.length % 2 ? Buffer.concat([b, Buffer.from(" ")]) : b;
    const h = Buffer.alloc(8);
    h.writeUInt32LE(tag, 0);
    h.writeUInt32LE(pad.length, 4);
    return Buffer.concat([h, pad]);
  };
  const sps = Buffer.concat([
    el(0x00400001, "BT1"),
    el(0x00400002, "20260115"),
    el(0x00400009, "SPS-42"),
  ]);
  // SQ değeri öge başlığı (FFFE,E000) ile sarılır — DICOM'da zorunlu.
  const itemHead = Buffer.alloc(8);
  itemHead.writeUInt32LE(0xfffee000, 0);
  itemHead.writeUInt32LE(sps.length, 4);
  const spsItem = Buffer.concat([itemHead, sps]);
  const spsHeader = Buffer.alloc(8);
  spsHeader.writeUInt32LE(0x00400100, 0);
  spsHeader.writeUInt32LE(spsItem.length, 4);
  const raw = Buffer.concat([
    el(0x00080050, "ACC-77"),
    el(0x00080060, "CT"),
    el(0x00100010, "ÖZTÜRK^ÇAĞLA"),
    el(0x00100020, "H-77"),
    el(0x0020000D, "1.2.3.77"),
    spsHeader,
    spsItem,
  ]);
  const parsed = parseImplicitVr(new Uint8Array(raw));
  assert.equal(findElement(parsed, 0x00100020)?.text, "H-77", "LO değeri");
  assert.equal(findElement(parsed, 0x00100010)?.text, "ÖZTÜRK^ÇAĞLA", "UTF-8 PN çözülür");
  const spsEl = findElement(parsed, 0x00400100);
  assert.equal(spsEl?.vr, "SQ", "SQ tanınır");
  assert.equal(spsEl?.items.length, 1, "SQ tek öge");
  assert.equal(findElement(spsEl!.items[0], 0x00400009)?.text, "SPS-42", "dizi içi değer");
  const json = datasetToDicomJson(parsed);
  const asItems = mwlFromDicomJson([json]);
  assert.equal(asItems.length, 1, "ham veri kümesi worklist ögesine dönüşür");
  assert.equal(asItems[0].scheduledStart, "2026-01-15", "SQ içindeki tarih okunur");
  assert.equal(asItems[0].modality, "CT", "modalite ham veriden");
  assert.equal(asItems[0].stepId, "SPS-42", "işlem kimliği ham veriden");
  // Bozuk/kesik mesaj: hata fırlatmaz, okunabilen kadarı döner.
  const truncated = parseImplicitVr(new Uint8Array(raw.subarray(0, raw.length - 5)));
  assert.ok(truncated.length >= 3, "kesik mesaj güvenli okunur");
  assert.deepEqual(parseImplicitVr(new Uint8Array(0)), [], "boş gövde");
  console.log("PASS Implicit VR ayrıştırıcı (dizi + UTF-8 + kesik mesaj)");

  // ── 6) Gerçek HTTP: DICOMweb MWL ───────────────────────────────────────
  const mock = spawn(process.execPath, [path.join(__dirname, "mockMwlServer.cjs"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitFor(mock, /mock-mwl-ready (\d+)/, "mock MWL");
  ROOT = `http://127.0.0.1:${port}`;
  const base = cfg();
  try {
    const j = await fetchMwl(base, { date: "20260115" }, {});
    assert.equal(j.length, 3, "DICOMweb yanıtı ham olarak 3 öge (biri kullanılamaz)");
    assert.equal(mwlFromDicomJson(j).length, 2, "kullanılamaz öge ayıklanır");
    console.log("PASS DICOMweb MWL sorgusu");

    // Modalite parametresi PACS'e geçer
    const mrOnly = await fetchMwl(base, { modality: "MR", date: "20260115" }, {});
    assert.equal(mwlFromDicomJson(mrOnly).length, 1, "modalite parametresi sunucuya iletilir");
    console.log("PASS modalite parametresi");

    // Boş yanıt (204) → boş dizi, hata değil
    const empty = await fetchMwl({ ...base, qidoRoot: `${ROOT}/bos` }, {}, {});
    assert.deepEqual(empty, [], "204 boş liste");
    console.log("PASS boş worklist (204)");

    // 401 → Türkçe ve kimlik odaklı hata
    await assert.rejects(() => fetchMwl({ ...base, qidoRoot: `${ROOT}/bozuk` }, {}, {}), /401/);
    const authErr = await fetchMwl({ ...base, qidoRoot: `${ROOT}/bozuk` }, {}, {}).catch((e: Error) => e.message);
    assert.match(String(authErr), /MWL sorgusu başarısız/, "hata mesajı bağlam taşır");
    console.log("PASS 401 → anlaşılır hata");

    // DIMSE köprüsü: ham Implicit VR yanıtı JSON'a çevrilir
    // Köprü JSON konuşur: DICOMweb kökü bozuk olsa bile `dimseUrl` devreye girer.
    const viaDimse = await fetchMwl({ ...base, qidoRoot: `${ROOT}/yok` }, {}, { dimseUrl: `${ROOT}/bridge/cfind` });
    const dimseItems = mwlFromDicomJson(viaDimse);
    assert.equal(dimseItems.length, 1, "DIMSE yanıtı kullanılabilir öge verir");
    assert.equal(dimseItems[0].patientName, "MEHMET ACAR", "DIMSE hasta adı");
    assert.equal(dimseItems[0].modality, "CT", "DIMSE modalite");
    // Ham bayt döndüren bir adres `dimseUrl` olarak verilirse hata anlaşılır olmalı
    // (köprü JSON'a çevirmekle yükümlüdür) — sessizce boş liste dönmemeli.
    const rawErr = await fetchMwl({ ...base, qidoRoot: `${ROOT}/yok` }, {}, { dimseUrl: `${ROOT}/dimse/cfind` })
      .catch((e: Error) => e.message);
    assert.match(String(rawErr), /JSON değil|başarısız/, "ham bayt köprüsü anlaşılır hata verir");
    console.log("PASS DIMSE C-FIND köprüsü (JSON köprüsü + ham bayt hatası)");
  } finally {
    mock.kill();
  }

  // ── 7) Köprü süreci uçtan uca (bin arka ucu) ───────────────────────────
  // `findscu` bu ortamda yok; `MWL_BACKEND=bin` ile sahte bir C-FIND ikilisi
  // çalıştırıp köprünün HTTP → süreç → JSON zincirini sınıyoruz.
  // Sahte C-FIND ikilisi kendi yanıtını üretir: depoda ikili fixture tutmuyoruz
  // (test çalışma dizini `.arena` gibi geçici alanlarda da çalışabilmeli).
  const binPath = path.join(__dirname, "..", ".mwl-fake-cfind.cjs");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const body = fs.readFileSync(path.join(__dirname, ".mwl-fake-cfind.bin"));',
      "process.stdout.write(body);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const elBin = (tag: number, text: string) => {
    const b = Buffer.from(text, "utf8");
    const pad = b.length % 2 ? Buffer.concat([b, Buffer.from(" ")]) : b;
    const h = Buffer.alloc(8);
    h.writeUInt32LE(tag, 0);
    h.writeUInt32LE(pad.length, 4);
    return Buffer.concat([h, pad]);
  };
  const spsBin = Buffer.concat([elBin(0x00400002, "20260120"), elBin(0x00400009, "SPS-BIN")]);
  const spsBinHead = Buffer.alloc(8);
  spsBinHead.writeUInt32LE(0x00400100, 0);
  spsBinHead.writeUInt32LE(spsBin.length, 4);
  const binData = path.join(__dirname, "..", ".mwl-fake-cfind.bin");
  fs.writeFileSync(
    binData,
    Buffer.concat([elBin(0x00100010, "ACAR^MEHMET"), elBin(0x00100020, "H-BIN"), elBin(0x00080050, "ACC-BIN"), elBin(0x00080060, "CT"), spsBinHead, spsBin]),
  );

  const proxy = spawn(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "..", "scripts", "mwl-cfind-proxy.ts")],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MWL_LISTEN_PORT: "0",
        MWL_PACS_HOST: "127.0.0.1",
        MWL_PACS_AET: "TEST",
        MWL_BACKEND: "bin",
        MWL_BIN: binPath,
      },
    },
  );
  try {
    const pport = await waitFor(proxy, /C-FIND köprüsü: http:\/\/[^:]+:(\d+)\/cfind/, "C-FIND köprüsü");
    const r = await fetch(`http://127.0.0.1:${pport}/cfind?modality=CT&scheduled-date=20260120&limit=10`);
    assert.equal(r.status, 200, "köprü 200 döner");
    const body = (await r.json()) as unknown[];
    const proxied = mwlFromDicomJson(body);
    assert.equal(proxied.length, 1, "köprü worklist ögesi döndürür");
    assert.equal(proxied[0].patientName, "MEHMET ACAR", "köprü hasta adı");
    assert.equal(proxied[0].accession, "ACC-BIN", "köprü accession");
    const bad = await fetch(`http://127.0.0.1:${pport}/yanlis`);
    assert.equal(bad.status, 404, "bilinmeyen yol 404");
    console.log("PASS köprü süreci uçtan uca (HTTP → C-FIND → DICOM JSON)");
  } finally {
    proxy.kill();
    fs.rmSync(binPath, { force: true });
    fs.rmSync(binData, { force: true });
  }

  // ── 8) Uç sözleşmesi ───────────────────────────────────────────────────
  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "src/app/api/his/mwl/route.ts"), "utf8");
  assert.ok(routeSrc.includes("fetchMwl") && routeSrc.includes("loadMwlEndpoints"), "uç MWL istemcisini kullanıyor");
  assert.ok(routeSrc.includes("his.mwl_query") && routeSrc.includes("his.mwl_to_study"), "sorgu ve çalışmaya alma denetime yazılıyor");
  assert.ok(routeSrc.includes("mwlToOrder"), "uç eşleme fonksiyonunu kullanıyor");
  assert.ok(routeSrc.includes('authorize(req, ["radyolog", "yonetici", "teknisyen"])'), "çalışmaya alma yetki ister");
  const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "src/lib/server/pacsConfig.ts"), "utf8");
  assert.ok(cfgSrc.includes("loadMwlEndpoints") && cfgSrc.includes("pacs.mwl"), "MWL ek uçları ayarlardan okunur");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["mwl:cfind"]?.includes("mwl-cfind-proxy"), "köprü betiği kayıtlı");
  assert.ok(pkg.scripts["test:mwl"]?.includes("mwl.test"), "test betiği kayıtlı");
  console.log("PASS uç sözleşmesi (yetki + denetim + ayar)");

  console.log("Tüm e-hl7-mwl (Modality Worklist) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

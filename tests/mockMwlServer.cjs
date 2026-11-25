/**
 * Mock MWL sunucusu — `e-hl7-mwl` testleri için.
 *
 * Üç ayrı yol sunar (gerçek kurulumlarda görülen üç farklı entegrasyon):
 *   /dicom-web/modality-worklist   DICOMweb MWL (dcm4chee/Orthanc eklentisi)
 *   /dimse/cfind                   DIMSE köprüsü (ham Implicit VR baytları)
 *   /bozuk/modality-worklist       401 → kimlik hatası senaryosu
 *
 * Başlangıçta `mock-mwl-ready <port>` yazar; test bu satırı bekler.
 */
const http = require("node:http");

/** Implicit VR Little Endian kodlayıcı: [tag, VR, değer]. */
function el(tag, vr, value) {
  const text = Buffer.from(String(value), "utf8");
  const padded = text.length % 2 ? Buffer.concat([text, Buffer.from(" ", "utf8")]) : text;
  const head = Buffer.alloc(8);
  head.writeUInt32LE(tag, 0);
  head.writeUInt32LE(padded.length, 4);
  return Buffer.concat([head, padded]);
}

/** (FFFE,E000) öge başlığı + içerik. */
function item(content) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0xfffee000, 0);
  head.writeUInt32LE(content.length, 4);
  return Buffer.concat([head, content]);
}

/** DICOM JSON modeli: bir MWL ögesi. */
function mwlJson(over = {}) {
  const base = {
    "00100010": { vr: "PN", Value: [{ Alphabetic: "YILMAZ^AHMET" }] },
    "00100020": { vr: "LO", Value: ["H-1001"] },
    "00100030": { vr: "DA", Value: ["19800101"] },
    "00100040": { vr: "CS", Value: ["M"] },
    "00080050": { vr: "SH", Value: ["ACC-1001"] },
    "00080060": { vr: "CS", Value: ["CT"] },
    "00321060": { vr: "LO", Value: ["BEYIN BT (KONTRASLI)"] },
    "00400100": {
      vr: "SQ",
      Value: [
        {
          "00400001": { vr: "AE", Value: ["BT1"] },
          "00400002": { vr: "DA", Value: ["20260115"] },
          "00400003": { vr: "TM", Value: ["103000"] },
          "00400005": { vr: "SH", Value: ["STAT"] },
          "00400007": { vr: "LO", Value: ["BEYIN BT"] },
          "00400009": { vr: "SH", Value: ["SPS-1"] },
          "00400010": { vr: "SH", Value: ["BT1"] },
          "00400020": { vr: "CS", Value: ["SCHEDULED"] },
        },
      ],
    },
    "0020000D": { vr: "UI", Value: ["1.2.3.4.5.6"] },
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  return base;
}

/** Ham Implicit VR C-FIND yanıtı: hasta + SPS dizisi (tanımlı uzunluk). */
function rawDataset({ name = "KAYA^AYSE", pid = "H-2002", acc = "ACC-2002", modality = "MR" } = {}) {
  const sps = Buffer.concat([
    el(0x00400001, "AE", "MR1"),
    el(0x00400002, "DA", "20260116"),
    el(0x00400003, "TM", "113000"),
    el(0x00400007, "LO", "KRANIAL MR"),
    el(0x00400009, "SH", "SPS-9"),
    el(0x00400020, "CS", "SCHEDULED"),
  ]);
  const spsHead = Buffer.alloc(8);
  spsHead.writeUInt32LE(0x00400100, 0);
  spsHead.writeUInt32LE(item(sps).length, 4);
  return Buffer.concat([
    el(0x00080050, "SH", acc),
    el(0x00080060, "CS", modality),
    el(0x00100010, "PN", name),
    el(0x00100020, "LO", pid),
    el(0x0020000D, "UI", "1.2.3.9.9"),
    spsHead,
    item(sps),
  ]);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/dicom+json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/dicom-web/modality-worklist") {
    const modality = url.searchParams.get("modality") ?? "";
    const items = [
      mwlJson(),
      mwlJson({
        "00100010": { vr: "PN", Value: [{ Alphabetic: "KAYA^AYSE" }] },
        "00100020": { vr: "LO", Value: ["H-2002"] },
        "00080050": { vr: "SH", Value: ["ACC-2002"] },
        "00080060": { vr: "CS", Value: ["MR"] },
      }),
      // Kullanılamaz öge: hasta kimliği yok → istemci atmalı.
      mwlJson({ "00100020": null }),
    ];
    const filtered = modality ? items.filter((i) => (i["00080060"]?.Value?.[0] ?? "") === modality) : items;
    return json(200, filtered);
  }
  if (url.pathname === "/bozuk/modality-worklist") {
    res.writeHead(401, { "Content-Type": "text/plain" });
    return res.end("unauthorized");
  }
  if (url.pathname === "/dimse/cfind") {
    const body = rawDataset();
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return res.end(body);
  }
  // C-FIND köprüsünün (JSON konuşan) beklenen yanıt biçimi.
  if (url.pathname === "/bridge/cfind") {
    return json(200, [
      mwlJson({
        "00100010": { vr: "PN", Value: [{ Alphabetic: "ACAR^MEHMET" }] },
        "00100020": { vr: "LO", Value: ["H-BIN"] },
        "00080050": { vr: "SH", Value: ["ACC-BIN"] },
        "00080060": { vr: "CS", Value: ["CT"] },
      }),
    ]);
  }
  if (url.pathname === "/bos/modality-worklist") {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(Number(process.argv[2] || 0), "127.0.0.1", () => {
  console.log(`mock-mwl-ready ${server.address().port}`);
});

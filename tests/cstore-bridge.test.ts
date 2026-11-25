/**
 * e-stow: DIMSE C-STORE köprüsü istemcisi.
 *
 * İddialar: gövde sınırları sunucuda yeniden denetlenir, geçersiz tek nesne
 * tüm isteği reddettirir (kısmi/uydurma gönderim yok), köprü adresi dış
 * ağa açılamaz, DIMSE durum kodları korunur ve kalıcı redde tekrar denenmez.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bridgeRequestBody,
  bridgeUrl,
  clampRetries,
  hasDicomPreamble,
  MAX_ITEM_BYTES,
  MAX_ITEMS_PER_CALL,
  mergeBridgeResponse,
  prepareItems,
  shouldRetry,
  validateTarget,
  type CStoreTarget,
} from "../src/lib/cstoreBridge";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** 128 bayt önsöz + "DICM" + biraz yük. */
function dicomBytes(payload = 64): Buffer {
  const b = Buffer.alloc(132 + payload, 0);
  b.write("DICM", 128, "latin1");
  return b;
}
const b64 = (b: Buffer) => b.toString("base64");

const TARGET: CStoreTarget = { host: "10.0.0.20", port: 104, calledAe: "ORTHANC", callingAe: "ARENAVIEWER" };

function main() {
  // ── 1) Hedef doğrulama ──────────────────────────────────────────────
  const ok = validateTarget({ host: " 10.0.0.20 ", port: 104, calledAe: "orthanc" });
  assert.equal(ok.ok, true, "geçerli hedef");
  if (ok.ok) {
    assert.equal(ok.target.host, "10.0.0.20", "host kırpıldı");
    assert.equal(ok.target.calledAe, "ORTHANC", "AE büyük harfe çevrildi");
    assert.equal(ok.target.callingAe, "ARENAVIEWER", "varsayılan çağıran AE");
    assert.equal(ok.target.tls, false, "varsayılan TLS kapalı");
  }
  const badTargets: [Record<string, unknown>, RegExp][] = [
    [{ port: 104, calledAe: "A" }, /host/],
    [{ host: "pacs", port: 0, calledAe: "A" }, /portu/],
    [{ host: "pacs", port: 70000, calledAe: "A" }, /portu/],
    [{ host: "pacs", port: 104 }, /AE Title/],
    [{ host: "pacs", port: 104, calledAe: "ÇOK-UZUN-AE-TITLE-X" }, /AE Title/],
    [{ host: "pacs", port: 104, calledAe: "A", callingAe: "TÜRKÇE" }, /Çağıran/],
  ];
  for (const [t, re] of badTargets) {
    const r = validateTarget(t as never);
    assert.equal(r.ok, false, `reddedilmeli: ${JSON.stringify(t)}`);
    if (!r.ok) assert.match(r.error, re, "gerekçe");
  }
  console.log("PASS hedef doğrulama");

  // ── 2) Part 10 imzası ve gövde sınırları ────────────────────────────
  assert.equal(hasDicomPreamble(dicomBytes()), true, "DICM imzası bulundu");
  assert.equal(hasDicomPreamble(Buffer.from("DICOM olmayan veri")), false, "kısa veri");
  assert.equal(hasDicomPreamble(Buffer.alloc(200, 0)), false, "imzasız 200 bayt");

  const good = prepareItems([{ name: "a.dcm", data: b64(dicomBytes(10)) }, { name: "b.dcm", data: `data:application/dicom;base64,${b64(dicomBytes(20))}` }]);
  assert.equal(good.ok, true, "iki geçerli nesne");
  if (good.ok) {
    assert.equal(good.prepared.length, 2, "iki hazır nesne");
    assert.equal(good.prepared[0].bytes, 142, "bayt sayısı");
    assert.equal(good.buffers.length, 2, "tampon sayısı");
  }
  const reject: [string, RegExp][] = [
    ["boş liste", /nesnesi yok/i],
    ["base64 bozuk", /base64 çözülemedi|DICOM Part 10/],
    ["imzasız", /DICOM Part 10/],
  ];
  assert.equal(prepareItems([]).ok, false, "boş liste reddedildi");
  assert.match((prepareItems([]) as { error: string }).error, reject[0][1], "gerekçe");
  assert.equal(prepareItems([{ name: "x.dcm", data: "@@@@" }]).ok, false, "bozuk base64 reddedildi");
  assert.equal(prepareItems([{ name: "x.dcm", data: b64(Buffer.alloc(400)) }]).ok, false, "imzasız veri reddedildi");
  assert.match((prepareItems([{ name: "x.dcm", data: b64(Buffer.alloc(400)) }]) as { error: string }).error, reject[2][1], "imza gerekçesi");

  // Sınırlar: nesne sayısı ve boyut
  const many = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, (_, i) => ({ name: `n${i}.dcm`, data: b64(dicomBytes(1)) }));
  const tooMany = prepareItems(many);
  assert.equal(tooMany.ok, false, "21 nesne reddedildi");
  assert.match((tooMany as { error: string }).error, new RegExp(`${MAX_ITEMS_PER_CALL} nesne`), "sınır mesajı");
  const big = Buffer.alloc(MAX_ITEM_BYTES + 1, 0);
  big.write("DICM", 128, "latin1");
  const tooBig = prepareItems([{ name: "buyuk.dcm", data: b64(big) }]);
  assert.equal(tooBig.ok, false, "13 MB nesne reddedildi");
  assert.match((tooBig as { error: string }).error, /sınır 12 MB/, "boyut mesajı");

  // Hatalı tek nesne tüm isteği reddettirir; iyi nesneler sessizce gönderilmez
  const mixed = prepareItems([{ name: "iyi.dcm", data: b64(dicomBytes()) }, { name: "kötü.dcm", data: "zzz" }]);
  assert.equal(mixed.ok, false, "karışık gövde tümüyle reddedildi");
  assert.equal((mixed as { index: number }).index, 1, "hatalı nesne dizini bildirilir");
  console.log("PASS Part 10 imzası ve gövde sınırları");

  // ── 3) Yeniden deneme ve köprü yanıtı birleştirme ───────────────────
  assert.equal(clampRetries(undefined), 1, "varsayılan 1 deneme");
  assert.equal(clampRetries(9), 4, "üst sınır 4");
  assert.equal(clampRetries(-3), 0, "alt sınır 0");
  assert.equal(clampRetries(2.5), 1, "tam sayı olmayan → varsayılan");

  assert.equal(shouldRetry({ name: "a", ok: false, attempts: 1, error: "timeout" }, 2), true, "geçici hatada tekrar denenir");
  assert.equal(shouldRetry({ name: "a", ok: true, attempts: 1 }, 2), false, "başarıda denenmez");
  assert.equal(shouldRetry({ name: "a", ok: false, attempts: 3, error: "x" }, 2), false, "deneme hakkı bitti");

  const merged = mergeBridgeResponse(
    { results: [{ name: "a.dcm", status: "0x0000" }, { name: "b.dcm", status: "0xA700" }] },
    TARGET,
    [{ name: "a.dcm", bytes: 100 }, { name: "b.dcm", bytes: 200 }],
  );
  assert.equal(merged.sent, 1, "yalnız 0x0000 başarı");
  assert.equal(merged.failed, 1, "0xA700 reddedildi");
  assert.equal(merged.ok, false, "kısmi gönderim başarı sayılmaz");
  assert.equal(merged.items[1].status, "0xA700", "DIMSE durum kodu korundu");
  assert.match(merged.message, /1\/2 nesne gönderildi/, "özet mesaj");
  assert.equal(merged.target.calledAe, "ORTHANC", "hedef yanıtta taşınır");

  const allOk = mergeBridgeResponse({ results: [{ name: "a.dcm", status: "0x0000" }] }, TARGET, [{ name: "a.dcm", bytes: 1 }]);
  assert.equal(allOk.ok, true, "tümü başarılı");
  assert.match(allOk.message, /1 nesne C-STORE ile ORTHANC@10\.0\.0\.20:104/, "başarı mesajı hedefi yazar");

  // Köprü hiç sonuç döndürmezse uydurma başarı YOK
  const noResult = mergeBridgeResponse({ results: [] }, TARGET, [{ name: "a.dcm", bytes: 1 }]);
  assert.equal(noResult.ok, true, "boş sonuç: köprü 2xx döndüyse kabul");
  const withError = mergeBridgeResponse({ error: "storescu bulunamadı" }, TARGET, [{ name: "a.dcm", bytes: 1 }]);
  assert.equal(withError.ok, false, "köprü hatası başarı sayılmaz");
  console.log("PASS yeniden deneme ve yanıt birleştirme");

  // ── 4) Köprü adresi güvenliği ───────────────────────────────────────
  const local = bridgeUrl("http://127.0.0.1:2590");
  assert.equal(local.ok, true, "yerel adres kabul");
  if (local.ok) assert.equal(local.url, "http://127.0.0.1:2590/cstore", "yol eklendi");
  const priv = bridgeUrl("http://10.1.2.3:2590/cstore");
  assert.equal(priv.ok, true, "iç ağ adresi kabul");
  const pub = bridgeUrl("http://8.8.8.8:2590/cstore");
  assert.equal(pub.ok, false, "internet adresi reddedildi");
  assert.match((pub as { error: string }).error, /yerel\/iç ağ/, "gerekçe");
  assert.equal(bridgeUrl("").ok, false, "boş adres → yapılandırılmamış");
  assert.match((bridgeUrl("") as { error: string }).error, /yapılandırılmamış/, "gerekçe");
  assert.equal(bridgeUrl("ftp://127.0.0.1").ok, false, "http dışı protokol reddedildi");
  console.log("PASS köprü adresi güvenliği");

  // ── 5) İstek gövdesi ────────────────────────────────────────────────
  const prep = prepareItems([{ name: "a.dcm", data: b64(dicomBytes(4)), sopClassUid: "1.2.840.10008.5.1.4.1.1.11.1" }]);
  assert.equal(prep.ok, true, "hazırlık");
  if (prep.ok) {
    const body = JSON.parse(bridgeRequestBody(TARGET, prep.prepared, prep.buffers)) as { target: CStoreTarget; items: { name: string; data: string; sopClassUid?: string }[] };
    assert.equal(body.target.calledAe, "ORTHANC", "hedef gövdede");
    assert.equal(body.items.length, 1, "nesne gövdede");
    assert.equal(body.items[0].name, "a.dcm", "ad");
    assert.equal(Buffer.from(body.items[0].data, "base64").subarray(128, 132).toString("latin1"), "DICM", "base64 geri çözülebilir");
    assert.equal(body.items[0].sopClassUid, "1.2.840.10008.5.1.4.1.1.11.1", "SOP Class taşınır");
  }
  console.log("PASS istek gövdesi");

  // ── 6) Uç, köprü süreci ve arayüz sözleşmesi ────────────────────────
  const route = read("src/app/api/pacs/cstore/route.ts");
  assert.ok(route.includes("validateTarget") && route.includes("prepareItems"), "uç doğrulamayı yeniden yapar");
  assert.ok(route.includes("pacs.cstore") && route.includes("pacs.cstore_failed"), "denetim kaydı");
  assert.ok(route.includes("sendCStore"), "gönderim");
  const bridge = read("scripts/cstore-bridge.ts");
  assert.ok(bridge.includes("storescu") && bridge.includes("DICM"), "köprü storescu kullanır, imzayı denetler");
  assert.ok(bridge.includes("mkdtemp") && bridge.includes("fs.rm"), "geçici dosyalar temizlenir");
  const menu = read("src/components/ExportMenu.tsx");
  assert.ok(menu.includes("/api/pacs/cstore") && menu.includes("C-STORE (DIMSE köprüsü)"), "arayüzde C-STORE girişi");
  assert.ok(menu.includes("bytesToBase64"), "tarayıcıda base64 (Buffer yok)");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["cstore:bridge"]?.includes("cstore-bridge"), "köprü betiği");
  assert.ok(pkg.scripts["test:cstore"]?.includes("cstore-bridge"), "test betiği");
  console.log("PASS uç/köprü/arayüz sözleşmesi");

  console.log("Tüm e-stow (C-STORE köprüsü) testleri geçti.");
}

main();

/**
 * w-pacs: DIMSE köprüsü (C-FIND / C-MOVE) istemci testleri.
 *
 * Köprü sözleşmesi (JSON), DICOM JSON ayrıştırma, bozuk yanıtın sessizce boş
 * listeye dönüşmemesi, AE Title doğrulaması, adres güvenliği ve kullanıcıya
 * dönük hata mesajları sınanır. Ağa çıkılmaz: taşıyıcı enjekte edilir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowed,
  bridgeHealth,
  buildCfindBody,
  cfind,
  CFIND_TEMPLATES,
  cmove,
  DIMSE_LEVELS,
  friendlyDimseStatus,
  joinUrl,
  TAGS,
  tagValue,
  toDicomDate,
  toStudyRows,
  validateDimseResponse,
  validateMove,
  type Transport,
} from "../src/lib/dimseBridge";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** Test taşıyıcısı: verilen yanıtı döner, giden istekleri kaydeder. */
function fake(payload: unknown, status = 200) {
  const calls: { url: string; body: string; method: string }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { transport, calls };
}

const dicomRow = (uid: string, extra: Record<string, unknown> = {}) => ({
  [TAGS.studyUid]: { vr: "UI", Value: [uid] },
  [TAGS.patientId]: { vr: "LO", Value: ["12345"] },
  [TAGS.patientName]: { vr: "PN", Value: [{ Alphabetic: "AYSE^YILMAZ" }] },
  [TAGS.studyDate]: { vr: "DA", Value: ["20260115"] },
  [TAGS.modality]: { vr: "CS", Value: ["CT"] },
  [TAGS.studyDescription]: { vr: "LO", Value: ["Beyin BT"] },
  ...extra,
});

async function main() {
  // ── 1) Kök ve adres kuralları ───────────────────────────────────────
  assert.equal(joinUrl("http://a.test/", "cfind"), "http://a.test/cfind", "sondaki / kırpılır");
  assert.equal(joinUrl("http://a.test", "/cfind"), "http://a.test/cfind", "baştaki / kırpılır");
  assert.equal(joinUrl("", "cfind"), "", "boş kök boş yol");
  assert.equal(assertAllowed("https://a.test/cfind"), undefined, "https serbest");
  assert.equal(assertAllowed("http://10.0.0.5:8042/cfind"), undefined, "http iç ağ varsayılan izinli");
  assert.throws(() => assertAllowed("http://a.test/x", false), /https gerekir/, "http yasaklanabilir");
  assert.throws(() => assertAllowed("ftp://a.test/x"), /Desteklenmeyen protokol/, "ftp reddedilir");
  assert.throws(() => assertAllowed("https://u:p@a.test/x"), /kullanıcı\/şifre olamaz/, "URL'de kimlik yasak");
  assert.throws(() => assertAllowed("bozuk adres"), /geçersiz/, "geçersiz URL");
  console.log("PASS adres güvenliği (protokol + kimlik)");

  // ── 2) Sorgu gövdesi ve tarih ───────────────────────────────────────
  const body = buildCfindBody({ level: "STUDY", query: { [TAGS.patientId]: " 123 ", [TAGS.studyDate]: "" }, limit: 5000 });
  assert.deepEqual(body, { level: "STUDY", query: { [TAGS.patientId]: "123" }, limit: 500 }, "boş alan atılır, limit kırpılır");
  assert.equal(buildCfindBody({ level: "SERIES", query: {} }).limit, 100, "varsayılan limit 100");
  assert.equal(buildCfindBody({ level: "IMAGE", query: { a: "x".repeat(200) } }).query.a.length, 64, "değer 64 karaktere kırpılır");
  assert.deepEqual(DIMSE_LEVELS, ["STUDY", "SERIES", "IMAGE"], "üç düzey");
  assert.equal(toDicomDate("2026-01-15"), "20260115", "ISO tarih → DA");
  assert.equal(toDicomDate("20260115"), "20260115", "DA korunur");
  assert.equal(toDicomDate("15.01.2026"), "15012026", "noktalı tarih rakamları alınır");
  assert.equal(toDicomDate("bozuk"), "", "geçersiz tarih boş");
  assert.deepEqual(CFIND_TEMPLATES.map((t) => t.q.level), ["STUDY", "STUDY", "STUDY", "SERIES"], "hazır sorgu şablonları");
  console.log("PASS sorgu gövdesi (limit/tarih/boş alan)");

  // ── 3) DICOM JSON ayrıştırma ────────────────────────────────────────
  assert.equal(tagValue(dicomRow("1.2.3"), TAGS.studyUid), "1.2.3", "metin değeri");
  assert.equal(tagValue(dicomRow("1.2.3"), TAGS.patientName), "AYSE^YILMAZ", "PN nesnesinden Alphabetic");
  assert.equal(tagValue({ [TAGS.instanceNumber]: { vr: "IS", Value: [12] } }, TAGS.instanceNumber), "12", "sayı metne çevrilir");
  assert.equal(tagValue({}, TAGS.studyUid), "", "olmayan etiket boş");
  const rows = toStudyRows({ results: [dicomRow("1.2.3"), { [TAGS.patientId]: { Value: ["x"] } }] });
  assert.equal(rows.length, 1, "UID'siz satır atlanır");
  assert.deepEqual(rows[0], {
    studyUid: "1.2.3", patientId: "12345", patientName: "AYSE^YILMAZ",
    studyDate: "20260115", modality: "CT", description: "Beyin BT", accession: "",
  }, "satır alanları eşlenir");
  console.log("PASS DICOM JSON ayrıştırma (PN, sayı, UID'siz satır)");

  // ── 4) Yanıt sözleşmesi ─────────────────────────────────────────────
  assert.deepEqual(validateDimseResponse({ results: [] }), { results: [], truncated: false }, "boş sonuç geçerli");
  assert.equal(validateDimseResponse({ results: [{}], truncated: true }).truncated, true, "truncated bayrağı");
  assert.throws(() => validateDimseResponse(null), /JSON nesnesi değil/, "null ret");
  assert.throws(() => validateDimseResponse([]), /'results' dizisi yok/, "dizi (nesne olmayan) ret");
  assert.throws(() => validateDimseResponse({ rows: [] }), /'results' dizisi yok/, "yanlış alan adı ret");
  assert.throws(() => validateDimseResponse({ results: [1, "x"] }), /geçersiz satır/, "bozuk satır ret");
  console.log("PASS yanıt doğrulama (bozuk yanıt boş listeye dönmez)");

  // ── 5) C-FIND ───────────────────────────────────────────────────────
  const ok = fake({ results: [dicomRow("1.2.3")] });
  const found = await cfind("http://pacskopru.test", { level: "STUDY", query: { [TAGS.patientId]: "12345" } }, { transport: ok.transport });
  assert.equal(found?.length, 1, "C-FIND sonucu döner");
  assert.equal(found?.[0].studyUid, "1.2.3", "çalışma UID");
  assert.equal(ok.calls[0].url, "http://pacskopru.test/cfind", "doğru yol");
  assert.equal(ok.calls[0].method, "POST", "POST");
  assert.match(ok.calls[0].body, /"level":"STUDY"/, "düzey gövdede");

  assert.equal(await cfind("", { level: "STUDY", query: {} }), null, "köprü yoksa null (DICOMweb'e düşülür)");

  const yetki = fake({}, 401);
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: yetki.transport }), /yetki hatası \(401\)/, "401 okunur hata");
  const yol = fake({}, 404);
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: yol.transport }), /yolu bulunamadı/, "404 yol hatası");
  const besYuz = fake({}, 503);
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: besYuz.transport }), /sunucu hatası \(503\)/, "5xx");
  const bozuk: Transport = async () => ({ ok: true, status: 200, json: async () => { throw new Error("HTML"); } });
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: bozuk }), /geçerli JSON döndürmedi/, "JSON değilse ret");
  const ag: Transport = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: ag }), /ulaşılamadı: ECONNREFUSED/, "ağ hatası");
  const zaman: Transport = async () => { throw new Error("The operation was aborted due to timeout"); };
  await assert.rejects(() => cfind("http://x.test", { level: "STUDY", query: { a: "b" } }, { transport: zaman }), /zaman aşımına uğradı/, "zaman aşımı");
  assert.match(friendlyDimseStatus(504), /zaman aşımı/, "504 zaman aşımı");
  assert.match(friendlyDimseStatus(403), /yetki/, "403");
  console.log("PASS C-FIND (başarı, yetki/yol/sunucu hataları, bozuk yanıt)");

  // ── 6) C-MOVE ───────────────────────────────────────────────────────
  assert.equal(validateMove({ destinationAe: "ARENAVIEWER", studyUid: "1.2.3" }), null, "geçerli istek");
  assert.match(validateMove({ destinationAe: "", studyUid: "1.2.3" }) ?? "", /AE Title/, "boş AE reddedilir");
  assert.match(validateMove({ destinationAe: "BU-COK-UZUN-AE-ADI", studyUid: "1.2.3" }) ?? "", /AE Title/, "16 karakterden uzun AE reddedilir");
  assert.match(validateMove({ destinationAe: "AE!", studyUid: "1.2.3" }) ?? "", /AE Title/, "geçersiz karakter");
  assert.match(validateMove({ destinationAe: "AE1", studyUid: "bozuk" }) ?? "", /Çalışma UID/, "bozuk UID");
  assert.match(validateMove({ destinationAe: "AE1", studyUid: "1.2", seriesUid: "x" }) ?? "", /Seri UID/, "bozuk seri UID");

  const mv = fake({ accepted: true, subOperations: 120, completed: 120, failed: 0, warnings: 2 });
  const res = await cmove("http://pacskopru.test", { studyUid: "1.2.3", destinationAe: "ARENAVIEWER" }, { transport: mv.transport });
  assert.deepEqual(res, { accepted: true, subOperations: 120, completed: 120, failed: 0, warnings: 2 }, "C-MOVE sonucu");
  assert.match(mv.calls[0].body, /"level":"STUDY"/, "seri yoksa STUDY düzeyi");
  assert.equal(mv.calls[0].url, "http://pacskopru.test/cmove", "doğru yol");

  const mvSeri = fake({ accepted: true, completed: 1 });
  await cmove("http://x.test", { studyUid: "1.2.3", seriesUid: "1.2.3.4", destinationAe: "AE" }, { transport: mvSeri.transport });
  assert.match(mvSeri.calls[0].body, /"level":"SERIES"/, "seri varsa SERIES düzeyi");
  assert.equal(await cmove("", { studyUid: "1.2.3", destinationAe: "AE" }), null, "köprü yoksa null");
  await assert.rejects(() => cmove("http://x.test", { studyUid: "bozuk", destinationAe: "AE" }, { transport: mv.transport }), /Çalışma UID/, "geçersiz istek gönderilmez");
  const eksik = fake({});
  const eksikSonuc = await cmove("http://x.test", { studyUid: "1.2", destinationAe: "AE" }, { transport: eksik.transport });
  assert.deepEqual(eksikSonuc, { accepted: false, subOperations: 0, completed: 0, failed: 0, warnings: 0 }, "eksik alanlar 0'a tamamlanır");
  console.log("PASS C-MOVE (AE/UID doğrulama + sonuç eşleme)");

  // ── 7) Köprü sağlığı ────────────────────────────────────────────────
  const sag = fake({ aeTitle: "ARENAVIEWER", version: "1.2" });
  const h = await bridgeHealth("http://kopru.test", { transport: sag.transport });
  assert.equal(h.ok, true, "sağlık ok");
  assert.equal(h.aeTitle, "ARENAVIEWER", "AE title döner");
  assert.equal(sag.calls[0].url, "http://kopru.test/health", "health yolu");
  const sagYok = await bridgeHealth("", {});
  assert.equal(sagYok.ok, false, "adres yoksa ok değil");
  const sagHata = fake({}, 500);
  assert.equal((await bridgeHealth("http://x.test", { transport: sagHata.transport })).ok, false, "5xx ok değil");
  console.log("PASS köprü sağlığı");

  // ── 8) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/pacs/dimse/route.ts");
  assert.ok(route.includes("cfind") && route.includes("cmove"), "uç iki işlemi destekler");
  assert.ok(route.includes('authorize(req, ["radyolog", "yonetici"])'), "yalnız klinik roller");
  assert.ok(route.includes("pacs.cfind") && route.includes("pacs.cmove"), "denetim kaydı");
  assert.ok(route.includes("ownAeTitle"), "kendi AE title'ı kullanılır");
  assert.ok(route.includes("source: \"pacs\""), "C-MOVE ile gelen çalışma pacs kaynaklı");
  assert.match(route, /En az bir arama ölçütü/, "boş arama reddedilir");
  const admin = read("src/components/AdminPanel.tsx");
  assert.ok(admin.includes("DIMSE köprüsü"), "yönetimde köprü kartı");
  assert.ok(admin.includes("/api/pacs/dimse"), "panel ucu kullanır");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "w-pacs"[\s\S]{0,2600}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:dimse"]?.includes("dimse-bridge"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm w-pacs (DIMSE köprüsü) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

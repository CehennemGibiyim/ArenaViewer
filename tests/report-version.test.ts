/**
 * Rapor sürüm karşılaştırma ve geri yükleme (r-version) testleri.
 * Kapsam: saf metin diff (LCS), anlık görüntü ayrıştırma, alan alan rapor farkı,
 * imza kaydının ayrıntı metninden çözümlenmesi (addendum ilişkisi dahil) ve
 * API/arayüz kaynağına tel bağlantı kontrolleri.
 * Not: Gerçek PostgreSQL akışı burada yoktur; geri yükleme yolu kaynak bağlantısı
 * olarak doğrulanır (unit ortamda DB yok).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  diffTextLines, summarizeDiff, parseReportSnapshot, diffReportSnapshots,
} from "../src/lib/reportDiff";
import {
  parseSignatureDetails, signatureNote, buildSignatureRecord, canonicalSignature,
} from "../src/lib/esign";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const types = (lines: { type: string }[]) => lines.map((l) => l.type).join(",");

// ── saf satır diff ──
const same = diffTextLines("a\nb\nc", "a\nb\nc");
ok(same.every((l) => l.type === "same"), "özdeş metin: tümü 'same'");
ok(same.length === 3, "özdeş metin satır sayısı");
const repl = diffTextLines("a\nb\nc", "a\nX\nc");
ok(types(repl) === "same,del,add,same", `tek satır değişikliği hizalanıyor (${types(repl)})`);
ok(repl[1].text === "b" && repl[2].text === "X", "değişen satırlar del+add olarak basılıyor");
const ins = diffTextLines("a\nc", "a\nb\nc");
ok(types(ins) === "same,add,same", `ekleme hizalanıyor (${types(ins)})`);
const del = diffTextLines("a\nb\nc", "a\nc");
ok(types(del) === "same,del,same", `silme hizalanıyor (${types(del)})`);
const crlf = diffTextLines("a\r\nb", "a\nb");
ok(crlf.every((l) => l.type === "same"), "CRLF normalizasyonu");
const empty = diffTextLines("", "");
ok(empty.length === 1 && empty[0].type === "same", "boş metin tek same satır");
const s = summarizeDiff(repl);
ok(s.added === 1 && s.removed === 1, "summarizeDiff sayaçları");
const big = diffTextLines(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 50 }, (_, i) => `m${i}`).join("\n"));
ok(big.filter((l) => l.type !== "same").length === 100, "tamamı değişen 50 satır del+add basar (LCS kilidi yok)");

// ── anlık görüntü ayrıştırma ──
ok(parseReportSnapshot('{"technique":"BT"}')?.technique === "BT", "geçerli anlık görüntü çözümleniyor");
ok(parseReportSnapshot("topla[1]") === null, "dizi anlık görüntü reddedilir");
ok(parseReportSnapshot("{bozuk") === null, "bozuk JSON null döner");
ok(parseReportSnapshot(null) === null && parseReportSnapshot("") === null, "boş/null anlık görüntü null");

// ── alan alan rapor farkı ──
const snapA = JSON.stringify({ technique: "BT\nnonkontrast", findingsText: "Parankim doğal", impression: "Normal", recommendation: "Kontrol yok" });
const snapB = JSON.stringify({ technique: "BT\nnonkontrast", findingsText: "Parankimde 12 mm nodule", impression: "Nodül", recommendation: "Kontrol yok", findingsJson: [{ id: "f1" }] });
const fields = diffReportSnapshots(parseReportSnapshot(snapA), parseReportSnapshot(snapB));
const byField = Object.fromEntries(fields.map((f) => [f.field, f]));
ok(byField.technique.changed === false, "değişmeyen alan changed=false");
ok(byField.findingsText.changed === true && byField.impression.changed === true, "değişen alanlar changed=true");
ok(byField.recommendation.changed === false, "öneride değişiklik yok");
ok(fields.every((f) => typeof f.label === "string" && f.label.length > 0), "alan etiketleri dolu");
ok(diffReportSnapshots(null, null).length === 4, "null anlık görüntülerde de alan listesi döner");

// ── imza kaydı: ayrıntı metninden çözümleme (addendum ilişkisi) ──
const rec = buildSignatureRecord({
  reportId: 5, studyUid: "1.2.3", contentHash: "a".repeat(64), signerName: "Dr. Test",
  method: "dahili-anahtar", version: 2, addendumId: 9,
});
const details = JSON.stringify({ record: canonicalSignature(rec), qualified: false, addendumId: 9 });
const parsed = parseSignatureDetails(details);
ok(parsed !== null, "kanonik kayıt ayrıntıdan çözümleniyor");
ok(parsed?.addendumId === 9 && parsed?.version === 2 && parsed?.qualified === false, "addendumId ve sürüm korunuyor");
ok(signatureNote(rec).includes("ek #9"), "imza notu ek numarasını yazıyor");
ok(signatureNote({ ...rec, addendumId: undefined }).includes("ek #") === false, "addendumId yoksa not ek numarası yazmaz");
// record alanı nesne olarak saklanmışsa da çözümlenir (tolerans)
const flat = parseSignatureDetails(JSON.stringify({ record: { ...rec }, qualified: false }));
ok(flat?.reportId === 5 && flat?.addendumId === 9, "nesne biçimli kayıt da çözümleniyor");
// record sarmalayıcısı yoksa dış nesnenin kendisi kayıt sayılır
const bare = parseSignatureDetails(canonicalSignature(rec));
ok(bare?.reportId === 5, "çıplak kanonik kayıt çözümleniyor");
ok(parseSignatureDetails("{bozuk") === null, "bozuk ayrıntı null");
ok(parseSignatureDetails(JSON.stringify({ record: "not-json" })) === null, "bozuk iç kayıt null");
ok(parseSignatureDetails("") === null, "boş ayrıntı null");

// ── kaynak tel bağlantısı (DB'siz unit ortamında rota sözleşmesi) ──
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const saveRoute = read("src/app/api/reports/route.ts");
ok(saveRoute.includes("findingsJson: findings"), "kayıt anlık görüntüsü tam bulguları yazıyor (v2)");
const detail = read("src/app/api/reports/[id]/route.ts");
ok(detail.includes("snapshot: reportVersions.snapshot"), "GET sürümlerle birlikte anlık görüntüyü döndürüyor");
const restore = read("src/app/api/reports/[id]/restore/route.ts");
ok(restore.includes('action: "geri-yükleme"'), "geri yükleme yeni sürüm olarak yazılıyor (action geri-yükleme)");
ok(restore.includes('status: "taslak"'), "geri yükleme raporu taslağa çekiyor");
ok(restore.includes("onaylandi") && restore.includes("409"), "onaylı rapora geri yükleme 409 ile engelleniyor");
ok(restore.includes("restoredFrom"), "geri yükleme denetim ayrıntısında kaynak sürümü yazıyor");
ok(restore.includes("findingsPreserved"), "bulgu tablosu korunduğunda çağıran bilgilendiriliyor");
const sigRoute = read("src/app/api/reports/[id]/signature/route.ts");
ok(sigRoute.includes("addendumId"), "imza API'si ek (addendum) imzasını destekliyor");
ok(sigRoute.includes("parseSignatureDetails"), "imza listesi çözülmüş kayıtlar döndürüyor");
ok(sigRoute.includes("reportAddenda"), "ek imzası sahiplik denetimi yapıyor");
const modal = read("src/components/ReportPrintModal.tsx");
ok(modal.includes("Bu sürüme dön") && modal.includes("Öncekiyle fark"), "sürüm panelinde fark ve geri yükleme girişleri var");
ok(modal.includes("Bu eki imzala"), "addendum satırında imza girişi var");
ok(modal.includes("restoreVersion"), "geri yükleme istemci akışı bağlı");
const shim = read("src/components/StaticApiShim.tsx");
ok(shim.includes("K_VERSIONS") && shim.includes('/restore'), "statik demo sürüm kaydı ve geri yükleme taklidi var");
const workstation = read("src/components/Workstation.tsx");
ok(workstation.includes("onRestored"), "Workstation geri yükleme sonrası üst state'i güncelliyor");

if (failed) { console.error(`${failed} sürüm/diff testi başarısız`); process.exit(1); }
console.log("Tüm rapor sürümü (diff/geri yükleme/ek imzası) testleri geçti.");

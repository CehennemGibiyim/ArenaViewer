/**
 * w-pacs: KO/PR PACS gönderimi testleri (istemci planı + uç sözleşmesi).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { planKeyObject, presentationSummary, validStowRequest } from "../src/lib/pacsSend";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const uids = { seriesUid: "1.2.3.4", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1", "1.2.3.4.2", "1.2.3.4.3"] };

// ── anahtar kesit → SOP UID eşlemesi ──
const p1 = planKeyObject([{ slice: 0, note: "nodül" }, { slice: 2 }], uids);
ok(p1.ok && p1.items.length === 2, "iki anahtar kesit eşlendi");
ok(p1.items[0].sopUid === "1.2.3.4.1" && p1.items[0].note === "nodül", "kesit sırası korunur (0 → ilk UID)");
ok(p1.skipped.length === 0, "atlanan yok");

const p2 = planKeyObject([{ slice: 0 }, { slice: 9 }], uids);
ok(p2.ok && p2.items.length === 1 && p2.skipped[0] === 9, "aralık dışı kesit atlanır, kalan gönderilir");

const p3 = planKeyObject([{ slice: 1 }, { slice: 1 }], uids);
ok(p3.items.length === 1, "aynı kesit iki kez gönderilmez");

ok(!planKeyObject([], uids).ok, "anahtar kesit yoksa gönderim reddedilir");
ok(!planKeyObject([{ slice: 0 }], {}).ok, "UID'siz seride reddedilir");
ok(planKeyObject([{ slice: 0 }], {}).reason!.includes("SOP Instance UID"), "red gerekçesi kullanıcıya açık");
ok(!planKeyObject([{ slice: 7 }], uids).ok, "hiçbiri eşlenmezse reddedilir");

// ── PR özeti ──
ok(presentationSummary({ wl: 40, ww: 400 }) === "WL 40 / WW 400", "yalnız pencere");
ok(presentationSummary({ wl: -600, ww: 1500, rotation: 90, flipH: true }).includes("90° döndürme"), "döndürme özete girer");
ok(presentationSummary({ wl: 0, ww: 0 }).includes("WW 1"), "WW 0 → 1'e kelepçelenir");

// ── istek doğrulama ──
ok(validStowRequest({ kind: "sr", reportId: 5 }) === null, "SR: rapor kimliği yeterli");
ok(validStowRequest({ kind: "sr" }) !== null, "SR: rapor kimliği zorunlu");
ok(validStowRequest({ kind: "ko", studyUid: "1.2.3", seriesKey: "a|3" }) === null, "KO: çalışma + seri anahtarı yeterli");
ok(validStowRequest({ kind: "pr", studyUid: "1.2.3" }) !== null, "PR: seri anahtarı zorunlu");
ok(validStowRequest({ kind: "xx" as "ko" }) !== null, "geçersiz tür reddedilir");

// ── uç sözleşmesi (kaynak düzeyi) ──
const root = path.resolve(__dirname, "..");
const route = readFileSync(path.join(root, "src/app/api/pacs/stow/route.ts"), "utf8");
ok(route.includes('body.kind === "ko" || body.kind === "pr"'), "uç KO/PR dalını ayırıyor");
ok(route.includes("qidoInstances") && route.includes("known.has"), "gönderim öncesi kesit UID'leri PACS'te doğrulanıyor");
ok(route.includes("buildKeyObjectSelection") && route.includes("buildPresentationState"), "KO ve GSPS üretimi bağlı");
ok(route.includes("pacs.send_ko") && route.includes("pacs.send_pr"), "gönderim denetim kaydına yazılıyor");
ok(route.includes('"radyolog", "yonetici"'), "yetki denetimi korunuyor");
const menu = readFileSync(path.join(root, "src/components/ExportMenu.tsx"), "utf8");
ok(menu.includes('"/api/pacs/stow"') && menu.includes("sendToPacs"), "dışa aktarma menüsünden gönderim var");

if (failed) { console.error(`${failed} PACS gönderim testi başarısız`); process.exit(1); }
console.log("Tüm w-pacs (KO/PR gönderim) testleri geçti.");

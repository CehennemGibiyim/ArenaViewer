/**
 * t-automation: AI uyuşmazlık eşiği uyarısı testleri.
 *
 * Kapsam: eşik/filtre kararı (saf), gerekçe sınıflandırma (kural tabanlı),
 * sınıf özeti, ai_disagreement bildirim gövdesi, API/AdminPanel kablolaması.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  findDisagreementAlerts,
  classifyReason,
  summarizeReasonClasses,
  reasonClassDigestText,
  DISAGREEMENT_THRESHOLD,
  MIN_DECIDED,
  REASON_CLASS_LABEL,
} from "../src/lib/disagreementAlert";
import { buildRequest, type NotifyChannel } from "../src/lib/notifyChannels";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const row = (engine: string, category: string, decided: number, rejected: number, edited: number) => ({
  engine, category, decided, rejected, edited,
  approved: decided - rejected - edited,
  disagreementRate: decided > 0 ? (rejected + edited) / decided : null,
});

// ── Eşik kararı ──
ok(DISAGREEMENT_THRESHOLD === 0.3 && MIN_DECIDED === 10, "varsayılan eşik %30 / ≥10 karar");
const rows = [
  row("motor-a", "NoDül", 20, 6, 2),     // %40 → uyarı
  row("motor-a", "Matriks", 20, 3, 1),   // %20 → geçmez
  row("motor-b", "NoDül", 8, 8, 0),      // %100 ama karar < 10 → geçmez
  row("motor-c", "Kontrast", 50, 15, 0), // %30 → eşiğin tam sınırı → geçer
  row("motor-d", "Hezarfen", 30, 0, 0),  // %0 → geçmez
];
const alerts = findDisagreementAlerts(rows);
ok(alerts.length === 2, `2 uyarı (gelen ${alerts.length})`);
ok(alerts[0].category === "NoDül" && alerts[0].engine === "motor-a", "en yüksek oran önce sıralanır");
ok(alerts.some((a) => a.engine === "motor-c" && a.disagreementRate === 0.3), "%30 tam sınır eşiğe dahildir");
ok(!alerts.some((a) => a.decided < 10), "10'dan az kararlı kategori uyarmaz (küçük örnek)");
ok(findDisagreementAlerts([]).length === 0, "boş liste → uyarı yok");

// ── Gerekçe sınıflandırma ──
ok(classifyReason("Yanlış pozitif, normal parankim") === "yanlis-pozitif", "yanlış pozitif sınıfı");
ok(classifyReason("Hareket artefaktı, tekrar çekim") === "artefakt", "artefakt sınıfı");
ok(classifyReason("HU kalibrasyon şüphesi var") === "kalibrasyon", "kalibrasyon sınıfı");
ok(classifyReason("Anatomik varyasyon (aksesuar arter)") === "anatomi-varyant", "anatomik varyant sınıfı");
ok(classifyReason("Kontrast fazı protokole uymuyor") === "teknik", "teknik/protokol sınıfı");
ok(classifyReason("") === "diger" && classifyReason("karmaşık açıklama xyz") === "diger", "eşleşmeyen → diger");
ok(classifyReason("METAL artefakt") === "artefakt", "büyük/küçük harf duyarsız");

const digest = summarizeReasonClasses([
  { engine: "m", category: "c", label: "X", status: "reddedildi", reason: "yanlış pozitif" },
  { engine: "m", category: "c", label: "X", status: "reddedildi", reason: "false positive bulgu" },
  { engine: "m", category: "c", label: "X", status: "duzenlendi", reason: "hareket artefaktı" },
  { engine: "m", category: "c", label: "X", status: "duzenlendi", reason: "klasik artefakt" },
  { engine: "m", category: "c", label: "X", status: "reddedildi", reason: "bilinmeyen xyz" },
]);
ok(digest[0].count === 2, `en sık sınıf başta (artefakt=2, gelen ${digest[0]?.cls})`);
ok(digest.some((d) => d.cls === "yanlis-pozitif" && d.count === 2), "yanlış pozitif 2 adet");
ok(new Set(digest.map((d) => d.cls)).size === digest.length, "sınıflar benzersiz");
ok(summarizeReasonClasses([], 6).length === 0, "boş gerekçe → boş özet");
ok(reasonClassDigestText([]).includes("yok"), "boş özet metni açıktır");
ok(Object.keys(REASON_CLASS_LABEL).length === 6, "6 sınıf etiketi tanımlı");

// ── ai_disagreement bildirim gövdesi ──
const chans: NotifyChannel[] = [
  { id: "hook", kind: "webhook", url: "https://hooks.example/x", minSeverity: "yuksek", enabled: true },
  { id: "mail", kind: "email", url: "https://smtp-gw.example/send", to: "yonetici@example.org", minSeverity: "yuksek", enabled: true },
];
const ev = {
  kind: "ai_disagreement" as const,
  severity: "yuksek" as const,
  studyUid: "",
  message: 'AI uyuşmazlığı %40 — Motor "motor-a", kategori "Nodül" (20 karar)',
  at: "2026-11-26T09:00:00Z",
};
const wh = buildRequest(chans[0], ev);
assert.equal(wh.body.event, "ai_disagreement", "webhook event ai_disagreement");
const mail = buildRequest(chans[1], ev);
assert.match(String(mail.body.subject), /AI uyuşmazlık/, "e-posta konusu AI uyuşmazlığı der");
assert.match(String(mail.body.text), /yöneticiye/, "e-posta gövdesi yönetici uyarısıdır");
assert.ok(!String(mail.body.text).includes("kritik bulgu bildirimi"), "e-posta gövdesi kritik-bulgu gövdesi DEĞİL");
const plain = buildRequest(chans[1], { severity: "yuksek", studyUid: "1.2.3", message: "x", modality: "CT" });
assert.equal(plain.body.event, "critical_finding", "kind verilmezse eski kritik-bulgu biçimi korunur");
console.log("PASS bildirim gövdeleri (ai_disagreement / kritik bulgu)");

// ── Kablolama kaynak denetimi ──
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const route = read("src/app/api/ai/performance/route.ts");
for (const marker of ["checkAndAlertDisagreement", "alertError", "disagreement"]) {
  ok(route.includes(marker), `performance rotası "${marker}" içerir`);
}
const server = read("src/lib/server/disagreementAlert.ts");
for (const marker of ["ai.disagreement_alert", "aiDisagreementAlerted", "summarizeReasonClasses", "sendToChannels"]) {
  ok(server.includes(marker), `sunucu uyarı modülü "${marker}" içerir`);
}
const panel = read("src/components/AdminPanel.tsx");
for (const marker of ["ai-disagreement-alert", "alert.reasonClasses", "DisagreementAlertInfo"]) {
  ok(panel.includes(marker), `AdminPanel "${marker}" içerir`);
}

if (failed) { console.error(`${failed} uyuşmazlık uyarısı testi başarısız`); process.exit(1); }
console.log("Tüm uyuşmazlık uyarısı testleri geçti.");

/**
 * Elektronik imza kaydı (r-esign) testleri.
 * Not: Bu modül NES üretmez; testler bunun açık etiketlenmesini de doğrular.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSignatureRecord, canonicalSignature, isQualifiedMethod, SIGNATURE_METHODS,
  signatureNote, verifySignatureRecord, type SignatureRecord,
} from "../src/lib/esign";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── yöntem etiketleri ──
ok(isQualifiedMethod("nes-nitelikli"), "NES nitelikli işaretli");
ok(!isQualifiedMethod("hesap-parola-mfa"), "hesap onayı nitelikli değil");
ok(!isQualifiedMethod("dahili-anahtar"), "dahili anahtar nitelikli değil");
ok(SIGNATURE_METHODS.filter((m) => m.qualified).length === 1, "tek nitelikli yöntem tanımlı");

// ── kayıt oluşturma/kanoniklik ──
const input = {
  reportId: 7, studyUid: "1.2.840.113619.2.1", contentHash: "a".repeat(64),
  signerName: "Dr. A. Yılmaz", signerRegNo: "T-12345", institution: "TEST", method: "hesap-parola-mfa" as const, version: 3,
};
const rec = buildSignatureRecord(input);
ok(rec.algo === "SHA-256" && !!rec.signedAt, "kayıt SHA-256 ve zaman damgası taşıyor");
const a = canonicalSignature(rec);
const shuffled: SignatureRecord = { ...rec };
const b = canonicalSignature(shuffled);
ok(a === b, "kanonik gösterim sıralamadan bağımsız");
ok(JSON.parse(a).reportId === 7, "kanonik kayıt alanları içeriyor");

// ── doğrulama ──
ok(verifySignatureRecord(rec, input.contentHash), "doğru hash ile kayıt geçerli");
ok(!verifySignatureRecord(rec, "b".repeat(64)), "hash uyuşmazsa kayıt geçersiz");
ok(!verifySignatureRecord({ ...rec, method: "yok-boyle-yontem" } as unknown as SignatureRecord, input.contentHash), "bilinmeyen yöntem reddedilir");
ok(!verifySignatureRecord({ ...rec, contentHash: "kisa" }, input.contentHash), "kısa/hash'siz kayıt reddedilir");

// ── insan okunur not ──
const note = signatureNote(rec);
ok(note.includes("NES") && note.includes("DEĞİLDİR"), `not NES olmadığını yazıyor (${note.slice(0, 60)}…)`);
const nes = signatureNote({ ...rec, method: "nes-nitelikli" });
ok(nes.includes("Nitelikli elektronik imza (NES)."), "NES kaydı nitelikli yazısı taşır");

// ── arayüz / API sözleşmesi ──
const root = path.resolve(__dirname, "..");
const route = readFileSync(path.join(root, "src/app/api/reports/[id]/signature/route.ts"), "utf8");
ok(route.includes('"nes-nitelikli"') && route.includes("409"), "API nitelikli imza yöntemini entegre olmadan reddediyor");
ok(route.includes("report.esignature"), "API denetim eylemini kaydediyor");
ok(route.includes("contentHash") && route.includes("409"), "onaysız içeriğe kayıt engelleniyor");
const modal = readFileSync(path.join(root, "src/components/ReportPrintModal.tsx"), "utf8");
ok(modal.includes("İmza kaydı") && modal.includes("sigAck"), "rapor ekranında imza kaydı girişi var");
ok(modal.includes("nesne nitelikli elektronik imza olmadığını"), "onay kutusu NES sınırını yazıyor");

if (failed) { console.error(`${failed} imza testi başarısız`); process.exit(1); }
console.log("Tüm imza kaydı testleri geçti.");

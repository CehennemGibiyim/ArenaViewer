/**
 * r-genai: LLM rapor taslağı doğrulama katmanı testleri.
 *
 * Kritik güvenceler sınanır: bulgularda olmayan sayı/kesit uydurulursa metin
 * reddedilir, kimlik benzeri veri yakalanır, LLM yoksa/hata verirse kural
 * tabanlı taslak kullanılır ve her durumda kaynak etiketi dürüsttür.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildDraftPrompt,
  DRAFT_SYSTEM_PROMPT,
  draftBadge,
  finalizeDraft,
  groundDraft,
  identityLeaks,
  numbersIn,
  ruleDraft,
  verifiedFindings,
  type DraftFinding,
} from "../src/lib/genaiDraft";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const f = (over: Partial<DraftFinding> = {}): DraftFinding => ({
  label: "Nodül", detail: "Sağ üst lobda 8 mm nodül", slice: 42,
  category: "Akciğer", severity: "orta", status: "onaylandi", ...over,
});

function main() {
  // ── 1) Doğrulanmış bulgu süzgeci ─────────────────────────────────────
  const bulgular = verifiedFindings([
    f(),
    f({ status: "duzenlendi", label: "Konsolidasyon" }),
    f({ status: "bekliyor" }),
    f({ status: "reddedildi" }),
    f({ category: "Sistem" }),
    f({ category: "ROI" }),
  ]);
  assert.equal(bulgular.length, 2, "yalnız onaylı/düzenlenmiş, Sistem/ROI dışı");
  assert.equal(verifiedFindings([]).length, 0, "boş liste güvenli");
  console.log("PASS doğrulanmış bulgu süzgeci (onaysız bulgu gönderilmez)");

  // ── 2) Kural tabanlı taslak ─────────────────────────────────────────
  const rule = ruleDraft([f(), f({ label: "Konsolidasyon", slice: 51 })]);
  assert.match(rule, /^1\) Nodül \(Kesit 42\); 2\) Konsolidasyon \(Kesit 51\)\. Klinik korelasyon önerilir\.$/, "numaralı liste + korelasyon notu");
  assert.equal(ruleDraft([]), "", "bulgu yoksa boş");
  console.log("PASS kural tabanlı taslak");

  // ── 3) Kimlik sızması ───────────────────────────────────────────────
  assert.deepEqual(identityLeaks("Nodül stabil."), [], "temiz metin");
  assert.match(identityLeaks("Hasta TCKN 12345678901")[0], /11 haneli/, "TCKN yakalanır");
  assert.match(identityLeaks("Doğum 12.03.1970")[0], /tarih/, "tarih yakalanır");
  assert.match(identityLeaks("iletisim: ali@example.com")[0], /e-posta/, "e-posta yakalanır");
  assert.match(identityLeaks("Tel 0532 123 45 67")[0], /telefon/, "telefon yakalanır");
  assert.match(identityLeaks("Hasta adı: Ayşe Y.")[0], /adı alanı/, "ad alanı yakalanır");
  assert.equal(identityLeaks("").length, 0, "boş metin");
  assert.equal(identityLeaks("42 mm, %30, 5 mm").length, 0, "ölçüler kimlik sayılmaz");
  assert.equal(identityLeaks("2026 yılında").length, 0, "yalnız yıl tarih sayılmaz");
  console.log("PASS kimlik sızması taraması");

  // ── 4) Sayı ve kesit denetimi (grounding) ───────────────────────────
  assert.deepEqual(numbersIn("8 mm ve 42. kesit, %30"), ["8", "42", "30"], "sayılar ayıklanır");
  assert.deepEqual(numbersIn("8,5 mm"), ["8.5"], "Türkçe ondalık normalize edilir");

  const iyi = groundDraft("Sağ üst lobda 8 mm nodül izlendi (kesit 42). Klinik korelasyon önerilir.", [f()]);
  assert.equal(iyi.ok, true, "bulgudaki sayı/kesit → geçer");
  assert.deepEqual(iyi.unsupportedNumbers, [], "uydurma sayı yok");

  const uydurma = groundDraft("Sağ üst lobda 8 mm nodül; ayrıca 23 mm kitle ve 15 HU kalsifikasyon (kesit 42).", [f()]);
  assert.equal(uydurma.ok, false, "bulguda olmayan sayı → ret");
  assert.deepEqual(uydurma.unsupportedNumbers.sort(), ["15", "23"], "uydurulan sayılar listelenir");
  assert.match(uydurma.reason, /bulgularda olmayan ölçü\/sayı/, "gerekçe okunur");

  const yanlisKesit = groundDraft("Nodül 8 mm (kesit 77).", [f()]);
  assert.equal(yanlisKesit.ok, false, "olmayan kesit → ret");
  assert.equal(yanlisKesit.sliceMismatch, true, "kesit uyuşmazlığı işaretlenir");
  assert.match(yanlisKesit.reason, /kesit atfı/, "gerekçe kesit");

  const kimlikli = groundDraft("Hasta adı: Ayşe Y. — 8 mm nodül.", [f()]);
  assert.equal(kimlikli.ok, false, "kimlik içeren metin → ret");
  assert.match(kimlikli.reason, /kimlik benzeri veri/, "gerekçe kimlik");

  assert.equal(groundDraft("Kısa.", [f()]).ok, false, "çok kısa metin reddedilir");
  assert.equal(groundDraft("Sağ üst lobda nodül izlendi, 8 mm (kesit 42).", [f()]).ok, true, "yüzde/kelime sınırı sayıları zararsız");
  assert.equal(groundDraft("Bulgular 1, 2 ve 3 değerlendirildi; 8 mm nodül (kesit 42).", [f()]).ok, true, "madde numaraları izinli");
  assert.equal(groundDraft("İzlem önerilir; toplam 2 nodül ve 90 kelimelik özet yeterli.", [f()]).ok, true, "çıplak sayılar (birimsiz) serbest");
  assert.equal(groundDraft("8 mm nodül (kesit 42); 15 HU dansite.", [f()]).ok, false, "birimli uydurma sayı yakalanır");
  console.log("PASS sayı/kesit denetimi (uydurma reddedilir)");

  // ── 5) Nihai metin seçimi ───────────────────────────────────────────
  const llmOk = finalizeDraft("Sağ üst lobda 8 mm nodül izlendi (kesit 42). Klinik korelasyon önerilir.", [f()]);
  assert.equal(llmOk.source, "llm", "doğrulanan LLM metni kullanılır");
  assert.match(llmOk.text, /8 mm nodül/, "LLM metni korunur");
  assert.equal(llmOk.rejected, undefined, "ret yok");

  const llmRet = finalizeDraft("Sağ üst lobda 25 mm kitle (kesit 42).", [f()]);
  assert.equal(llmRet.source, "llm-reddedildi", "uyduran LLM reddedilir");
  assert.match(llmRet.text, /^1\) Nodül \(Kesit 42\)/, "kural tabanlı metne düşer");
  assert.match(llmRet.rejected ?? "", /25 mm/, "ham metin hekime gösterilir (rapora girmez)");
  assert.match(llmRet.reason, /reddedildi/, "gerekçe");

  const yok = finalizeDraft(null, [f()]);
  assert.equal(yok.source, "kural", "LLM yoksa kural");
  const bos = finalizeDraft("   ", [f()]);
  assert.equal(bos.source, "kural", "boş yanıt kural");
  const hata = finalizeDraft(undefined as unknown as string | null, [f()]);
  assert.equal(hata.source, "kural", "tanımsız yanıt kural");
  assert.equal(finalizeDraft("x", []).text, "", "bulgu yoksa metin boş");
  assert.match(finalizeDraft("x", []).reason, /kısa/, "kısa metin gerekçesi");
  console.log("PASS nihai taslak seçimi (uyduran LLM devre dışı)");

  // ── 6) İstem ve etiketler ───────────────────────────────────────────
  assert.match(DRAFT_SYSTEM_PROMPT, /90 kelime/, "kelime sınırı talimatta");
  assert.match(DRAFT_SYSTEM_PROMPT, /olmayan hiçbir bilgi/, "uydurma yasağı talimatta");
  assert.match(DRAFT_SYSTEM_PROMPT, /Hasta kimliği/, "kimlik yasağı talimatta");
  const prompt = buildDraftPrompt({ modality: "CT", bodyPart: "Toraks", findings: [f()] });
  assert.match(prompt, /Modalite: CT/, "modalite eklenir");
  assert.match(prompt, /\[Kesit 42\] Nodül: Sağ üst lobda 8 mm nodül/, "bulgu satırı");
  assert.ok(!/ad[ıi]\s*:/i.test(prompt), "istemde ad alanı yok");
  assert.equal(draftBadge("llm"), "Taslak — LLM; hekim doğrulaması gerekir", "LLM etiketi");
  assert.match(draftBadge("llm-reddedildi"), /reddedildi/, "ret etiketi");
  assert.match(draftBadge("kural"), /kural tabanlı/, "kural etiketi");
  console.log("PASS istem ve kaynak etiketleri");

  // ── 7) Uç ve arayüz sözleşmesi ──────────────────────────────────────
  const route = read("src/app/api/reports/draft-impression/route.ts");
  assert.ok(route.includes("finalizeDraft"), "uç doğrulama katmanını kullanır");
  assert.ok(route.includes("verifiedFindings"), "bulgu süzgeci paylaşılır");
  assert.ok(route.includes("identityLeaks"), "üslup örneği kimlik taramasından geçer");
  assert.ok(route.includes("DRAFT_SYSTEM_PROMPT") && route.includes("buildDraftPrompt"), "istem tek kaynaktan");
  assert.ok(route.includes("authorize(req, [\"radyolog\", \"yonetici\"])"), "yalnız klinik roller");
  assert.ok(route.includes("rejected: !!result.rejected"), "ret denetime yazılır");
  assert.match(route, /styleSample: !!styleSample/, "kimlikli örnek gönderilmediği denetlenir");
  const modal = read("src/components/ReportPrintModal.tsx");
  assert.ok(modal.includes("draftBadge"), "arayüz kaynağı etiketler");
  assert.ok(modal.includes("draftNote"), "ret gerekçesi hekime gösterilir");
  const shim = read("src/components/StaticApiShim.tsx");
  assert.ok(shim.includes("ruleDraft"), "çevrimdışı mod aynı biçimi kullanır");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "r-genai"[\s\S]{0,2400}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:genai"]?.includes("genai-draft"), "test betiği kayıtlı");
  console.log("PASS uç ve arayüz sözleşmesi");

  console.log("Tüm r-genai (LLM taslak doğrulama) testleri geçti.");
}

main();

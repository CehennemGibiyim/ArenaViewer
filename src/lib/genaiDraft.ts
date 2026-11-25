/**
 * Üretken yapay zeka rapor taslağı (r-genai) — güvenlik ve doğrulama katmanı.
 *
 * Neden ayrı modül: taslak metni bir LLM'den gelir. Klinik rapora giren her
 * cümle için dört şey garanti edilmelidir:
 *
 *  1. **Kimlik sızmaz**: istem (prompt) içine hasta adı/MRN/doğum tarihi girmez.
 *     Zaten yalnız doğrulanmış bulgu metinleri gönderilir; burada ayrıca metin
 *     taraması ile kimlik benzeri kalıplar (ad-soyad, tarih, MRN, e-posta,
 *     telefon) kırmızıya boyanır.
 *  2. **Uydurma engellenir**: LLM'in ürettiği metindeki sayılar (mm, HU, yaş,
 *     yüzde) doğrulanmış bulgularda yoksa metin reddedilir ve kural tabanlı
 *     taslağa düşülür. "Bulguda olmayan bilgi ekleme" talimatı tek başına
 *     yeterli değildir — model bunu ihlal edebilir.
 *  3. **Yerelleştirme doğru**: bulgu dışı bölge/kesit atıfları kontrol edilir.
 *  4. **Kaynak izlenir**: her taslak `llm` / `kural` / `llm-reddedildi` olarak
 *     etiketlenir ve denetime yazılır; hekim doğrulaması olmadan rapora girmez.
 *
 * Bu modül ağ çağrısı yapmaz (saf); çağrı `draft-impression` ucundadır.
 */

export type DraftSource = "llm" | "kural" | "llm-reddedildi";

export interface DraftFinding {
  label: string;
  detail: string;
  slice: number;
  category: string;
  severity: string;
  status: string;
}

/** Denetlenmiş bulgu (yalnız hekimin onayladığı/düzenlediği). */
export function verifiedFindings(findings: DraftFinding[]): DraftFinding[] {
  return findings.filter(
    (f) => (f.status === "onaylandi" || f.status === "duzenlendi") && f.category !== "Sistem" && f.category !== "ROI",
  );
}

/** Kural tabanlı taslak: doğrulanmış bulguların numaralı listesi + korelasyon notu. */
export function ruleDraft(findings: DraftFinding[]): string {
  if (!findings.length) return "";
  return `${findings.map((f, i) => `${i + 1}) ${f.label} (Kesit ${f.slice})`).join("; ")}. Klinik korelasyon önerilir.`;
}

/**
 * Kimlik benzeri kalıpları bulur. Amaç: yanlışlıkla gönderilmiş kimlik
 * verisini yakalamak (savunma katmanı; asıl kural istemciye kimlik koymamaktır).
 */
export function identityLeaks(text: string): string[] {
  const bulgular: string[] = [];
  if (!text) return bulgular;
  if (/\b\d{11}\b/.test(text)) bulgular.push("11 haneli sayı (TCKN/MRN olabilir)");
  if (/\b\d{2}[./-]\d{2}[./-]\d{4}\b/.test(text)) bulgular.push("tarih (doğum tarihi olabilir)");
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) bulgular.push("e-posta adresi");
  if (/(?:\+90|0)?\s?\(?\d{3}\)?\s?\d{3}\s?\d{2}\s?\d{2}/.test(text)) bulgular.push("telefon numarası");
  if (/\b(?:hasta|ad[ıi]|soyad[ıi]|isim|mrn|protokol)\s*[:=]\s*\S+/i.test(text)) bulgular.push("hasta adı alanı");
  return bulgular;
}

/** Metindeki sayısal ifadeler (mm/HU/%/yaş dahil). */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

/**
 * "Klinik" sayılar: birimle birlikte geçen ölçüler. Sayı denetiminde yalnız
 * bunlar bulgu metniyle eşleşmek zorundadır — çıplak sayılar (madde
 * numaralandırma, "90 kelime" gibi ifadeler) serbest bırakılır.
 *
 * Neden birim odaklı: uydurmanın klinik zararı ölçü/tanı taşıyan sayılardan
 * gelir ("23 mm kitle", "15 HU kalsifikasyon"); "1) 2)" gibi liste numaraları
 * ise zararsızdır ve katı denetim yanlış retlere yol açar.
 */
export function clinicalNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(mm|cm|ml|mL|HU|%|yaş|kg|gr|derece|°)/g;
  for (const m of text.matchAll(re)) out.push(m[1].replace(",", "."));
  return out;
}

export interface GroundingResult {
  ok: boolean;
  /** Bulgularda olmayan klinik sayılar (uydurma riski). */
  unsupportedNumbers: string[];
  /** Metinde geçen kimlik benzeri kalıplar. */
  identity: string[];
  /** Yerleştirme/kesit atıfları bulgularla uyumlu mu. */
  sliceMismatch: boolean;
  /** Reddedilme nedeni (ok ise boş). */
  reason: string;
}

/**
 * LLM metnini bulgulara "bağlar" (grounding).
 *
 * Denetimler:
 *  1. Klinik sayılar (birimli ölçüler) bulgu metninde geçmeli.
 *  2. "Kesit N" atıfı doğrulanmış bulguların kesitlerinden biri olmalı.
 *  3. Kimlik benzeri kalıp bulunmamalı.
 *  4. Metin kullanılabilir uzunlukta olmalı.
 * Herhangi biri düşerse metin reddedilir ve kural tabanlı taslağa dönülür.
 */
export function groundDraft(text: string, findings: DraftFinding[]): GroundingResult {
  const kimlik = identityLeaks(text);
  const allowed = new Set<string>();
  for (const f of findings) {
    for (const n of clinicalNumbers(`${f.label} ${f.detail}`)) allowed.add(n);
  }
  const unsupported = [...new Set(clinicalNumbers(text).filter((n) => !allowed.has(n)))];
  const sliceRefs = [...text.matchAll(/kesit\s*(\d+)/gi)].map((m) => Number(m[1]));
  const findingSlices = new Set(findings.map((f) => f.slice));
  const sliceMismatch = sliceRefs.some((n) => !findingSlices.has(n));

  let reason = "";
  if (kimlik.length) reason = `Taslakta kimlik benzeri veri var (${kimlik.join(", ")}); reddedildi.`;
  else if (unsupported.length) reason = `Taslakta bulgularda olmayan ölçü/sayı var: ${unsupported.join(", ")}. Uydurma riski nedeniyle reddedildi.`;
  else if (sliceMismatch) reason = `Taslakta doğrulanmış bulgularda olmayan kesit atfı var (kesit ${sliceRefs.filter((n) => !findingSlices.has(n)).join(", ")}). Reddedildi.`;
  else if (text.trim().length < 15) reason = "Taslak çok kısa; kullanılabilir bir izlenim değil.";

  return { ok: !reason, unsupportedNumbers: unsupported, identity: kimlik, sliceMismatch, reason };
}

/** Sonuç: kullanılacak metin + kaynak + gerekçe (denetim için). */
export interface DraftResult {
  text: string;
  source: DraftSource;
  reason: string;
  /** LLM yanıtı reddedilmişse ham metin (hekim görsün diye; rapora girmez). */
  rejected?: string;
}

/**
 * LLM çıktısını kural taslağına karşı doğrular ve nihai metni seçer.
 * `llmText` boş/hata ise kural taslağı döner.
 */
export function finalizeDraft(llmText: string | null, findings: DraftFinding[]): DraftResult {
  const rule = ruleDraft(findings);
  // Tanımsız/boş yanıt ile anlamsız kısa yanıt ayrı ele alınır: ilki "LLM yok",
  // ikincisi "LLM verdi ama kullanılamaz" bilgisidir (denetimde fark önemli).
  if (llmText === null || llmText === undefined || !llmText.trim()) {
    return { text: rule, source: "kural", reason: "LLM yanıtı yok; kural tabanlı taslak kullanıldı." };
  }
  const g = groundDraft(llmText, findings);
  if (g.ok) return { text: llmText.trim(), source: "llm", reason: "Bulgulara bağlı (sayı/kesit denetimi geçti)." };
  return { text: rule, source: "llm-reddedildi", reason: g.reason, rejected: llmText.trim().slice(0, 2000) };
}

/** LLM sistem talimatı (tek yerde; test edilebilir). */
export const DRAFT_SYSTEM_PROMPT =
  "Sen bir radyoloji raporlama yardımcısısın. Yalnızca verilen, hekimce doğrulanmış bulgulara dayanarak Türkçe, kısa (en fazla 90 kelime) bir 'SONUÇ/İZLENİM' taslağı yaz. " +
  "Bulgularda olmayan hiçbir bilgi, tanı, ölçü, sayı veya kesit numarası ekleme. Hasta kimliği (ad, MRN, doğum tarihi) yazma. " +
  "Ölçü ve kesit numaralarını yalnızca verilen bulgu metninden aynen kullan. Emin olmadığın konuda 'klinik korelasyon önerilir' de.";

/** İstem gövdesi (kimlik içermez; yalnız bulgu metinleri). */
export function buildDraftPrompt(body: { modality: string; bodyPart: string; findings: DraftFinding[] }): string {
  return `Modalite: ${body.modality}\nBölge: ${body.bodyPart}\nDoğrulanmış bulgular:\n${body.findings
    .map((f) => `- [Kesit ${f.slice}] ${f.label}: ${f.detail}`)
    .join("\n")}`;
}

/** Taslağın hekime gösterilecek etiketi (rapora girmeden önce). */
export function draftBadge(source: DraftSource): string {
  switch (source) {
    case "llm":
      return "Taslak — LLM; hekim doğrulaması gerekir";
    case "llm-reddedildi":
      return "LLM taslağı reddedildi (uydurma/kimlik denetimi); kural tabanlı metin kullanıldı";
    default:
      return "Taslak — kural tabanlı; hekim doğrulaması gerekir";
  }
}

/**
 * ICD-10 kodlama desteği ve istem uygunluğu (ACR Appropriateness benzeri) yardımcısı.
 *
 * ÖNEMLİ SINIR: Bu modül **kodlama kararını** vermez. Öneriler, rapor metnindeki
 * ancak hekim tarafından doğrulanması gereken yaklaşık eşleşmelerdir; belgede
 * "yaklaşık eşleme" olarak etiketlenir. Uygunluk puanları da yalnızca istem
 * formundaki bilgiyle karşılaştırma içindir; klinik karar hekime aittir.
 */

export interface IcdEntry {
  /** ICD-10 kodu (tiresiz/şimalı olmadan). */
  code: string;
  label: string;
  /** Önerinin dayandığı rapor metni kalıpları. */
  patterns: RegExp[];
}

export const ICD10_ENTRIES: IcdEntry[] = [
  {
    code: "S52.5", label: "Radius distali (alt ucu) kırığı",
    patterns: [/\bdistal radius\b/i, /\bradius\s+(?:distal|alt)\s*k[ıi]r[ıi]k/i, /\bkol k[ıi]r[ıi]k/i],
  },
  {
    code: "S82.1", label: "Tibia proksimal (üst ucu) kırığı",
    patterns: [/\btibia\s+proksimal/i, /\btibi[ya]\s+(?:üst|proksimal)/i, /\bg[öo]z k[ıi]r[ıi]k/i],
  },
  {
    code: "S72.0", label: "Femur boyun (kalça) kırığı",
    patterns: [/\bfemur boynu?\b/i, /\bkal[çc]a k[ıi]r[ıi]k/i, /\bfemur\s+k[ıi]r[ıi]k/i],
  },
  {
    code: "S42.0", label: "Kavikula (koların) kırığı",
    patterns: [/\bkavikula\b/i, /\bklavik[üu]l\b/i],
  },
  {
    code: "S82.4", label: "Fibula kırığı",
    patterns: [/\bfibula\s+k[ıi]r[ıi]k/i, /\bfibula\b.*\bk[ıi]r[ıi]k/i],
  },
  {
    code: "M25.5", label: "Eklem ağrısı",
    patterns: [/\beklem a[ğg]r[ıi]\b/i, /\bartralji\b/i],
  },
  {
    code: "M54.5", label: "Bel ağrısı (düşük sırt ağrısı)",
    patterns: [/\bbel a[ğg]r[ıi]\b/i, /\bd[üu][şs][üu]k s[ıi]rt a[ğg]r[ıi]/i, /\blumboji\b/i, /\blumbago\b/i],
  },
  {
    code: "M54.2", label: "Servikal ağrı (boyun ağrısı)",
    patterns: [/\bservikal a[ğg]r[ıi]\b/i, /\bboyun a[ğg]r[ıi]\b/i, /\bservikalji\b/i],
  },
  {
    code: "M17.9", label: "Gonartroz (diz artrozu)",
    patterns: [/\bdiz artrozu\b/i, /\bgonartroz\b/i, /\bdizde degeneratif\b/i, /\bdejeneratif d[ıi]z\b/i],
  },
  {
    code: "M16.9", label: "Kalça artrozu",
    patterns: [/\bkal[çc]a artrozu\b/i, /\bkoxartroz\b/i],
  },
  {
    code: "J18.9", label: "Pnömoni, bulaşıcı örgüt belirtilmemiş",
    patterns: [/\bpn[öo]moni\b/i, /\bakci[ğg]er infeksiyonu\b/i, /\bkonsolidasyon\b.*\binfeksiyon/i],
  },
  {
    code: "J96.9", label: "Solunum yetmezliği, tip belirtilmemiş",
    patterns: [/\bsolunum yetmezli[ğg]i\b/i, /\boksijenasyon bozuklu[ğg]u\b/i],
  },
  {
    code: "I63.9", label: "Serebral infarkt, spesifik olmayan",
    patterns: [/\binfarkt\b/i, /\biskemi\b/i, /\binfarct\b/i],
  },
  {
    code: "I60.9", label: "Subaraknoid kanama, spesifik olmayan",
    patterns: [/\bsubarakh?noid kanama\b/i, /\bsubarakh?noidal kanama\b/i, /\bsubarakno?id\b.*\bkanama/i],
  },
  {
    code: "I61.9", label: "Intraserebral kanama, spesifik olmayan",
    patterns: [/\bintraserebral kanama\b/i, /\bkranial kanama\b/i, /\bserebral kanama\b/i],
  },
  {
    code: "C34.9", label: "Akciğer/bronş malign neoplazmı, spesifik tanımlanmamış",
    patterns: [/\bakci[ğg]er kanseri\b/i, /\bmalign\b/i, /\bkitle lezyonu\b.*\bmalign/i],
  },
  {
    code: "C61", label: "Prostat malign neoplazmı",
    patterns: [/\bprostat kanseri\b/i, /\bprostat malign\b/i],
  },
  {
    code: "C50.9", label: "Meme malign neoplazmı, spesifik tanımlanmamış",
    patterns: [/\bmeme kanseri\b/i, /\bmemede malign\b/i],
  },
  {
    code: "G40.9", label: "Epilepsi, spesifik olmayan",
    patterns: [/\bepilepsi\b/i, /\bn[öo]bet\b/i],
  },
  {
    code: "K35.8", label: "Akut apandisit, diğer ve spesifik olmayan",
    patterns: [/\bapandisit\b/i, /\bappendisit\b/i],
  },
  {
    code: "N20.0", label: "Böbrek taşı",
    patterns: [/\bb[öo]brek ta[şs][ıi]\b/i, /\bnefrolitiaz\b/i, /\bnephrolithiasis\b/i],
  },
  {
    code: "N18.9", label: "Kronik böbrek hastalığı, evre belirtilmemiş",
    patterns: [/\bkronik b[öo]brek\b/i, /\bk[bh]s\b/i, /\bb[öo]brek yetmezli[ğg]i\b/i],
  },
  {
    code: "E04.9", label: "Non-toksik nodüler guatr, spesifik olmayan",
    patterns: [/\bgua?tr\b/i, /\bnod[üu]l guatr\b/i, /\btiroid nod[üu]l[üu]\b/i],
  },
  {
    code: "M10.9", label: "Gut, spesifik olmayan",
    patterns: [/\bgut\b/i, /\bgout\b/i],
  },
  {
    code: "M86.9", label: "Osteomiyelit, spesifik olmayan",
    patterns: [/\bosteomyelit\b/i, /\bosteomiyelit\b/i],
  },
];

/**
 * JS'in `\b`'si yalnızca ASCII kelime karakterleri sayar; Türkçe harf (ğ/ş/ı…)
 * solundaki/sağındaki sınırı "kelime dışı" sanır. Bu yüzden sınırlar Türkçe
 * karakterleri de içeren sınıflarla yeniden yazılır.
 */
const TR_LETTERS = "a-zçğıöşüâîû";
function testTerm(re: RegExp, text: string): boolean {
  const src = re.source.replace(/\\b/g, "");
  const flags = re.flags.includes("i") ? "i" : "";
  return new RegExp(`(?<![${TR_LETTERS}])(${src})(?![${TR_LETTERS}])`, flags).test(text);
}

/** ICD-10 format denetimi (tireli kod, harf ile başlar). */
export function isValidIcd10(code: string): boolean {
  return /^[A-TV-Z][0-9][0-9AB]?(\.[0-9A-Z]{1,4})?$/.test(code.trim());
}

export interface IcdSuggestion {
  code: string;
  label: string;
  /** Kaç kalıpla eşleşti (sıralama). */
  hits: number;
}

/**
 * Rapor metninden ICD-10 önerisi üretir (en fazla `limit` kayıt).
 * Eşleşme kalıpları kesilmemiş kelimelerdir; hekim gözden geçirmelidir.
 */
export function suggestIcd10(text: string, limit = 6): IcdSuggestion[] {
  const t = ` ${text.toLocaleLowerCase("tr-TR")} `;
  const out: IcdSuggestion[] = [];
  for (const e of ICD10_ENTRIES) {
    let hits = 0;
    for (const re of e.patterns) if (testTerm(re, t)) hits++;
    if (hits > 0) out.push({ code: e.code, label: e.label, hits });
  }
  out.sort((a, b) => b.hits - a.hits || a.code.localeCompare(b.code, "tr-TR"));
  return out.slice(0, limit);
}

// ───────────── İstem uygunluğu ─────────────

export interface AppropriatenessRule {
  /** Modalite (DICOM kısaltması). */
  modality: string;
  /** Bölge anahtarı (büyük/küçük harf duyarsız). */
  bodyPart: string;
  /** Klinik endikasyon (Türkçe kalıplar). */
  indications: RegExp[];
  /** 1–9 arası uygunluk puanı (ACR yaklaşımı: ≥7 uygun). */
  score: number;
  note: string;
}

const APPROPRIATENESS_RULES: AppropriatenessRule[] = [
  {
    modality: "CT", bodyPart: "TORAKS",
    indications: [/pn[öo]motoraks/i, /travma/, /k[ıi]r[ıi]k/, /akut g[öo][ğg][üu]s a[ğg]r[ıi]/],
    score: 9,
    note: "Pnömotoraks/travma şüphesinde toraks BT yüksek uygunlukta.",
  },
  {
    modality: "CT", bodyPart: "TORAKS",
    indications: [/rutin/, /kontrol/, /tarama/, /belirti yok/],
    score: 2,
    note: "Endikasyonsuz rutin toraks BT düşük uygunlukta; klinik gerekçe istenir.",
  },
  {
    modality: "CT", bodyPart: "ABDOMEN",
    indications: [/b[öo]brek ta[şs][ıi]/, /kolik/, /qap[ıi]nt[ıi]/],
    score: 9,
    note: "Şüpheli taş/kolikde doğrudan BT uygun (radyasyon alternatifi US değerlendirilir).",
  },
  {
    modality: "CT", bodyPart: "BEYIN",
    indications: [/kanama/, /travma/, /kon[şs]uzluk/, /akut defisit/, /fokal/],
    score: 9,
    note: "Akut intrakraniyel patolojide BT ilk görüntülemedir.",
  },
  {
    modality: "MR", bodyPart: "BEYIN",
    indications: [/n[öo]bet/, /epilepsi/, /fokal defisit/, /kronik ba[şs] a[ğg]r[ıi]/],
    score: 8,
    note: "MR beyin nörolojik şüphelerde uygundur.",
  },
  {
    modality: "MR", bodyPart: "BOYUN",
    indications: [/boyun a[ğg]r[ıi]/, /radik[üu]lopati/, /myelopati/],
    score: 8,
    note: "MR medulla spinalis ve kapkılık değerlendirmede tercih edilir.",
  },
  {
    modality: "US", bodyPart: "ABDOMEN",
    indications: [/sa[ğg]l[ıi]kl[ıi] kadini taramas[ıi]/, /pelvik a[ğg]r[ıi]/, /karaci[ğg]er/],
    score: 8,
    note: "Ultrason ilk satır görüntülemedir; radyasyon ve kontrast yoktur.",
  },
  {
    modality: "MG", bodyPart: "MEME",
    indications: [/tarama/, /karsino[ğg]om taramas[ıi]/, /meme kanseri taramas[ıi]/],
    score: 9,
    note: "40 yaş üstü tarama mamografisi yüksek uygunlukta.",
  },
  {
    modality: "DX", bodyPart: "EKSTREMITE",
    indications: [/travma/, /k[ıi]r[ıi]k/, /a[ğg]r[ıi]/],
    score: 9,
    note: "Ekstremite travmasında direkt grafi ilk işlemdir.",
  },
  {
    modality: "DX", bodyPart: "TORAKS",
    indications: [/rutin/, /kontrol/, /tarama/],
    score: 4,
    note: "Rutin toraks grafisi endikasyona bağlıdır; BT'ye göre düşük bilgi.",
  },
];

export interface AppropriatenessResult {
  score: number | null;
  note: string;
}

/** İstem formu için yaklaşık uygunluk puanı (1–9) ve gerekçe. */
export function appropriatenessFor(modality: string, bodyPart: string, indication: string): AppropriatenessResult {
  const m = modality.trim().toLocaleUpperCase("tr-TR");
  const b = bodyPart.trim().toLocaleUpperCase("tr-TR");
  const ind = indication.trim();
  let best: AppropriatenessRule | null = null;
  for (const r of APPROPRIATENESS_RULES) {
    if (r.modality !== m || r.bodyPart !== b) continue;
    if (!r.indications.some((re) => testTerm(re, ind))) continue;
    if (!best || r.score > best.score) best = r;
  }
  if (!best) return { score: null, note: "Tablo eşleşmesi yok; istem uygunluğu klinisyen kararıdır." };
  return { score: best.score, note: `${best.note} (puan: ${best.score}/9)` };
}

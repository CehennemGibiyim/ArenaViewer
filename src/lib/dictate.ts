/**
 * Sesle dikte (Web Speech API, tr-TR) için saf metin katmanı.
 *
 * Tarayıcının konuşma tanıma çıktısı tıbbi Türkçede tipik olarak:
 *  - tümü küçük harf ve noktalama işaretsizdir,
 *  - sayıları ve ölçü birimlerini sözcük olarak yazar,
 *  - bazı terimleri benzer sesli başka sözcüklerle değiştirir.
 *
 * Bu modül bu çıktıyı rapor metnine uygun biçime dönüştürür. Tarayıcı bağımlı
 * hiçbir şey içermez; test edilebilir.
 */

export type DictationCommand = "temizle" | "yeniSatir" | "yeniParagraf";

export interface DictationResult {
  /** Komutlar ve noktalama uygulanmış metin. */
  text: string;
  /** Söylenen komutlar (metinden çıkarılmıştır). */
  commands: DictationCommand[];
}

/** Türkçe sayı sözcükleri → basamak değeri. Yalnızca tek başlarına geçerli olanlar. */
const TR_UNITS: Record<string, number> = {
  sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9,
  on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90,
  yüz: 100, bin: 1000,
};

/** Söylenen noktalama / düzen komutları (en uzun kalıp önce uygulanır). */
const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\bsıfırinci\b/gi, "0'ıncı"],
  [/\bbirinci\b/gi, "1'inci"],
  [/\bikinci\b/gi, "2'nci"],
  [/\büçüncü\b/gi, "3'üncü"],
  [/\bdördüncü\b/gi, "4'üncü"],
  [/\bbeşinci\b/gi, "5'inci"],
  [/\baltıncı\b/gi, "6'ncı"],
  [/\byedinci\b/gi, "7'nci"],
  [/\bsekizinci\b/gi, "8'inci"],
  [/\bdokuzuncu\b/gi, "9'uncu"],
  [/\bonuncu\b/gi, "10'uncu"],
  [/\byirminci\b/gi, "20'nci"],
  [/\bikibuçuk\b/gi, "2,5"],
  [/\büçbuçuk\b/gi, "3,5"],
  [/\bbirbuçuk\b/gi, "1,5"],
  [/\biki nokta üst üste\b/gi, ":"],
  [/\bnoktalı virgül\b/gi, ";"],
  [/\bsoru işareti\b/gi, "?"],
  [/\bünlem işareti\b/gi, "!"],
  [/\büst üste iki nokta\b/gi, ":"],
  [/\byeni paragraf\b/gi, "\n\n"],
  [/\byeni satır\b/gi, "\n"],
  [/\bvirgül\b/gi, ","],
  [/\biki nokta\b/gi, ":"],
  [/\btilsişareti\b/gi, "'"],
  [/\bkesme işareti\b/gi, "-"],
  [/\btire\b/gi, "-"],
  [/\bparantez kapattı\b/gi, ")"],
  [/\bparantez açtı\b/gi, "("],
  [/\bnokta\b/gi, "."],
];

/**
 * Tıbbi sözcük dağarcığı: ASR çıktısındaki tipik bozuk yazımlar → kurum standardı.
 * Kalıplar küçük/büyük harfe duyarsız aranır; sonuç standart çekimdedir.
 */
const MEDICAL_FIXES: Array<[RegExp, string]> = [
  [/\bakciger\b/gi, "akciğer"],
  [/\bakçiğer\b/gi, "akciğer"],
  [/\bkardiyomegali\b/gi, "kardiyomegali"],
  [/\bkardiyo mega li\b/gi, "kardiyomegali"],
  [/\bperikard effüzyon\b/gi, "perikardiyal effüzyon"],
  [/\bperikard effuzyon\b/gi, "perikardiyal effüzyon"],
  [/\bpleural effuzyon\b/gi, "plevral effüzyon"],
  [/\bplevral efüzyon\b/gi, "plevral effüzyon"],
  [/\bpnomoni\b/gi, "pnömoni"],
  [/\bpneumoni\b/gi, "pnömoni"],
  [/\btelektazi\b/gi, "telektazi"],
  [/\btelektazik\b/gi, "telektazik"],
  [/\batelaktazi\b/gi, "atelektazi"],
  [/\bkonsolidasyon\b/gi, "konsolidasyon"],
  [/\bkonsolidayon\b/gi, "konsolidasyon"],
  [/\bkirik\b/gi, "kırık"],
  [/\blomnidene\b/gi, "lomber vertebra"],
  [/\blomber vertebrası\b/gi, "lomber vertebra"],
  [/\btorakal\b/gi, "torakal"],
  [/\btoraksik\b/gi, "toraksik"],
  [/\bservikal\b/gi, "servikal"],
  [/\bkranial\b/gi, "kraniyal"],
  [/\bkraniyum\b/gi, "kraniyum"],
  [/\bmiyokard\b/gi, "miyokard"],
  [/\bserebrovaskuler\b/gi, "serebrovasküler"],
  [/\bserebral\b/gi, "serebral"],
  [/\bintraserebral\b/gi, "intraserebral"],
  [/\bsubaraknoid\b/gi, "subaraknoid"],
  [/\bsubarahnoid\b/gi, "subaraknoid"],
  [/\bsubdural\b/gi, "subdural"],
  [/\bepidual\b/gi, "epidural"],
  [/\bhemojenom\b/gi, "hemotoraks"],
  [/\bhemotoraks\b/gi, "hemotoraks"],
  [/\bpnomotoraks\b/gi, "pnömotoraks"],
  [/\bpneomotoraks\b/gi, "pnömotoraks"],
  [/\bmediyasten\b/gi, "mediasten"],
  [/\bmediastinum\b/gi, "mediastinum"],
  [/\bdiyafragmay\b/gi, "diyafragma"],
  [/\bdiyafram\b/gi, "diyafram"],
  [/\bkostofrenik\b/gi, "kostofrenik"],
  [/\bhilus\b/gi, "hilus"],
  [/\bretikülar\b/gi, "retiküler"],
  [/\bretikuler\b/gi, "retiküler"],
  [/\bnoduler\b/gi, "nodüler"],
  [/\bnodul\b/gi, "nodül"],
  [/\bkistik lezyon\b/gi, "kistik lezyon"],
  [/\bheterojen\b/gi, "heterojen"],
  [/\bhomojen\b/gi, "homojen"],
  [/\bizomorfik\b/gi, "izomorfik"],
  [/\banjiyosentez\b/gi, "anjiyosentez"],
  [/\banjiyo\b/gi, "anjiyo"],
  [/\bkardiyak\b/gi, "kardiyak"],
  [/\bpulmoner\b/gi, "pulmoner"],
  [/\bvenöz\b/gi, "venöz"],
  [/\barteriyel\b/gi, "arteriyel"],
  [/\bpateji\b/gi, "patoloji"],
  [/\bpatolojik\b/gi, "patolojik"],
  [/\bnormal sınırlar içinde\b/gi, "normal sınırlar içinde"],
  [/\bdoğal sınırlar\b/gi, "doğal sınırlar"],
  [/\bmeme kanseri\b/gi, "meme kanseri"],
  [/\bmamografi\b/gi, "mamografi"],
  [/\btomosentez\b/gi, "tomosentez"],
  [/\bkalciyum\b/gi, "kalsiyum"],
  [/\bkalsifikasyon\b/gi, "kalsifikasyon"],
  [/\basket\b/gi, "basket"],
  [/\bmetastaz\b/gi, "metastaz"],
  [/\bmetastatik\b/gi, "metastatik"],
  [/\bprimer\b/gi, "primer"],
  [/\bsekonder\b/gi, "sekonder"],
  [/\bkabartı\b/gi, "kabartı"],
  [/\bprotez\b/gi, "protez"],
  [/\bverterbra\b/gi, "vertebra"],
  [/\bvertebraları\b/gi, "vertebraları"],
  [/\bomurga\b/gi, "omurga"],
  [/\bparametre\b/gi, "parametre"],
  [/\bparametreler\b/gi, "parametreler"],
];

/** Radyolojide sıklıkla söylenen ölçü kalıplarını birleştirir. */
const MEASURE_FIXES: Array<[RegExp, string]> = [
  [/\bmilimetre\b/gi, "mm"],
  [/\bsantimetre\b/gi, "cm"],
  [/\bsanti metre\b/gi, "cm"],
  [/\bsantimetrelik\b/gi, "cm'lik"],
  [/\bcentimetre\b/gi, "cm"],
  [/\bkilogram\b/gi, "kg"],
  [/\bmiligram\b/gi, "mg"],
  [/\bmililitre\b/gi, "mL"],
  [/\bkübik milimetre\b/gi, "mm³"],
  [/\bsantimetreküp\b/gi, "cm³"],
  [/\bhounsfield\b/gi, "HU"],
  [/\bhounsfield ünitesi\b/gi, "HU"],
];

function trLower(s: string): string {
  return s.toLocaleLowerCase("tr-TR");
}

const TR_DIGITS: Record<string, string> = {
  bir: "1", iki: "2", üç: "3", dört: "4", beş: "5", altı: "6", yedi: "7", sekiz: "8", dokuz: "9",
};

/** Basamak değeri: büyük birim gelirse çarpılır ("iki yüz" → 200). */
function spellNumberRun(words: string[]): string | null {
  if (words.length === 0 || !words.every((w) => w in TR_UNITS)) return null;
  // Yalnızca tek hanelerden oluşan zincir: haneler sırayla söylenir ("iki sıfır yedi").
  if (words.length > 1 && words.every((w) => w in TR_DIGITS)) return words.map((w) => TR_DIGITS[w]).join("");
  let cur = 0;
  for (const w of words) {
    const v = TR_UNITS[w];
    cur = v >= 100 ? (cur || 1) * v : cur + v;
  }
  return String(cur);
}

/**
 * Sayı sözcüklerini basamağa çevirir: "yirmi beş" → 25, "üç" → 3,
 * art arda tek haneler "bir iki üç" → 123. Yalnızca arka arkaya gelen sayı
 * sözcüklerini değiştirir; "üç milimetre" gibi kalıplarda sözcüğü korur.
 */
function spellNumbers(text: string): string {
  return text.replace(/(?:[a-zçğıöşüâîû]+\s+)*[a-zçğıöşüâîû]+/gi, (token) => {
    // Kelime/ayraç çiftlerini koru: yeni satır ve paragraf ayraçları bozulmasın.
    const parts = token.split(/(\s+)/);
    const at = (k: number) => parts[k] ?? "";
    let out = "";
    let i = 0;
    while (i < parts.length) {
      let j = i;
      while (j < parts.length && at(j).toLocaleLowerCase("tr-TR") in TR_UNITS) j += 2;
      if (j > i) {
        const words: string[] = [];
        for (let k = i; k < j; k += 2) words.push(at(k));
        out += spellNumberRun(words.map(trLower)) ?? words.join(" ");
        out += at(j - 1); // çalınan son sayı sözcüğünü izleyen ayraç
        i = j;
      } else {
        out += at(i) + at(i + 1);
        i += 2;
      }
    }
    return out;
  });
}

/** Dikte komutlarını metinden ayırır. */
export function splitDictationCommands(text: string): DictationResult {
  const commands: DictationCommand[] = [];
  let out = ` ${text} `;
  out = out.replace(/\s*\btemizle\b\s*/gi, () => { commands.push("temizle"); return " "; });
  // "yeni satır/paragraf" zaten SPOKEN_PUNCTUATION ile kaça dönüşür; komut da işaretlenir.
  out = out.replace(/\s*\byeni satır\b\s*/gi, () => { commands.push("yeniSatir"); return "\n"; });
  out = out.replace(/\s*\byeni paragraf\b\s*/gi, () => { commands.push("yeniParagraf"); return "\n\n"; });
  return { text: out.trim(), commands };
}

/**
 * Ham dikte metnini rapor metnine dönüştürür.
 * Sıra: söylenen sayı sözcükleri → noktalama → tıbbi sözlük → ölçü birimleri.
 */
export function normalizeDictation(raw: string): string {
  let t = raw;
  // Önce noktalama/ölçü/tıbbi sözlük, en son sayı sözcükleri: böylece "üç
  // milimetre" → "üç mm" → "3 mm" olur, sayı grubu komşu sözcüksüz kalır.
  for (const [re, rep] of SPOKEN_PUNCTUATION) t = t.replace(re, rep);
  for (const [re, rep] of MEASURE_FIXES) t = t.replace(re, rep);
  for (const [re, rep] of MEDICAL_FIXES) t = t.replace(re, rep);
  t = spellNumbers(t);
  // Noktalama öncesi boşlukları temizle: "göğüs , akciğer ." → "göğüs, akciğer."
  t = t.replace(/\s+([,.;:!?)])/g, "$1");
  t = t.replace(/([(])\s+/g, "$1");
  // Sözcük içi yazım hatalarını kapat: "akcığer" gibi
  t = t.replace(/\bakc(ı|i|)ğ?er\b/gi, "akciğer");
  // Çift boşluk / boş paragrafları sadeleştir.
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/^[ \t.]+/, "");
  return t.trim();
}

/** Mikrofon çıktısını komutlarla birlikte normalize eder. */
export function processDictation(raw: string): DictationResult {
  const { text, commands } = splitDictationCommands(raw);
  const normalized = normalizeDictation(text);
  return { text: normalized, commands };
}

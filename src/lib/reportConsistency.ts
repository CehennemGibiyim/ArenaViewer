/**
 * Rapor metni ↔ kayıtlı ölçümler tutarlılık denetimi (yeni fikir — r-report-consistency).
 *
 * Risk: hekim (veya taslak üreten LLM) rapor metnine **ölçülmemiş** bir sayı yazabilir
 * ya da ölçülen bir değeri metne yansıtmayabilir. Bu modül raporun teknik/bulgular/
 * izlenim/öneri metnindeki sayı+birim ifadelerini çıkarır ve raporda «Ölçümler»
 * bölümünde üretilen ölçüm satırlarıyla eşleştirir:
 *
 *  - Eşleme kurallıdır, LLM kullanılmaz; bir sayı ancak aynı ölçü sınıfında
 *    (uzunluk→mm, HU, mL) ve tolerans içindeyse eşleşmiş sayılır.
 *  - **Onayı engellemez** ve kesin bir hata iddiası kurmaz: metindeki her sayı
 *    klinik ölçüm değildir (yaş, tarih, doz…); liste yalnız «kontrol edin» sinyalidir.
 *  - Hiç metne uymayan kayıtlar «ölçüm var, metinde yok» olarak da gösterilir.
 *
 * Saf fonksiyondur; rapor ekranı ve testler doğrudan buradan kullanır.
 */

export type MeasureClass = "length" | "hu" | "ml";

export interface TextMeasurement {
  /** Ham metin (ör. "23 mm", "45,5 HU") — listede bu gösterilir. */
  raw: string;
  /** Normalize edilmiş değer: uzunluk mm, HU/mL kendi birimi. */
  value: number;
  cls: MeasureClass;
  /** Metindeki karakter konumu (kararlı sıra için). */
  index: number;
}

// Ortalama±SS biçimini (ör. "42±8 HU") ilk değeriyle yakalar; ± ve sonrası yok sayılır.
const UNIT_RE = /(-?\d{1,4}(?:[.,]\d{1,2})?)(?:\s*±\s*\d{1,2}(?:[.,]\d{1,2})?)?\s*(mm|cm|HU|mL|ml)(?![\w²³23]|[Hh][Gg])/gi;

/** Metinden sayı+birim ifadelerini çıkarır (uzunluk mm'ye normalize edilir). */
export function parseUnitNumbers(text: string): TextMeasurement[] {
  const out: TextMeasurement[] = [];
  if (!text) return out;
  for (const m of text.matchAll(UNIT_RE)) {
    const numRaw = m[1];
    const unitRaw = m[2].toLowerCase();
    const n = Number(numRaw.replace(",", "."));
    if (!Number.isFinite(n)) continue;
    let cls: MeasureClass;
    let value: number;
    if (unitRaw === "mm") { cls = "length"; value = n; }
    else if (unitRaw === "cm") { cls = "length"; value = n * 10; }
    else if (unitRaw === "hu") { cls = "hu"; value = n; }
    else { cls = "ml"; value = n; }
    out.push({ raw: m[0].replace(/\s+/g, " ").trim(), value, cls, index: m.index ?? 0 });
  }
  return out;
}

/** İki ölçü arasındaki göreli/mutlak farkı sınıf toleransı içinde kabul eder. */
export function withinTolerance(a: number, b: number, cls: MeasureClass): boolean {
  if (cls === "hu") return Math.abs(a - b) <= 20;
  if (cls === "ml") return Math.abs(a - b) <= Math.max(5, 0.15 * Math.max(a, b));
  // uzunluk (mm): rapor çoğunlukla tam sayı yazar; %15 ya da 2 mm (hangisi büyükse)
  return Math.abs(a - b) <= Math.max(2, 0.15 * Math.max(a, b));
}

export interface ConsistencyReport {
  /** Metinde bulunan ölçü sayısı */
  textCount: number;
  /** Kayıtlı ölçüm sayısı */
  measurementCount: number;
  /** Eşleşen çift sayısı */
  matched: number;
  /** Metinde var, kayıtlı ölçümde yok (en çok 12) */
  unmatchedText: TextMeasurement[];
  /** Ölçümde var, metinde geçmiyor (en çok 12) */
  unmatchedMeasurements: TextMeasurement[];
  /** Kısa durum notu (panoda gösterilir) */
  note: string;
}

const CAP = 12;

/**
 * @param reportText  Teknik/bulgular/izlenim/öneri metni (tek dize)
 * @param measurementsText  Raporun «Ölçümler» bölümü metni (satırlar)
 */
export function checkReportConsistency(reportText: string, measurementsText: string): ConsistencyReport {
  const text = parseUnitNumbers(reportText);
  const meas = parseUnitNumbers(measurementsText);
  const used = new Set<number>(); // kullanılan ölçüm indeksleri
  const unmatchedText: TextMeasurement[] = [];

  // Açgözlü: her metin ölçüsü için en yakın kullanılmamış ölçüm (aynı sınıf, tolerans içi).
  for (const t of text) {
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < meas.length; i++) {
      if (used.has(i)) continue;
      const m = meas[i];
      if (m.cls !== t.cls) continue;
      if (!withinTolerance(t.value, m.value, t.cls)) continue;
      const d = Math.abs(t.value - m.value);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best >= 0) used.add(best);
    else unmatchedText.push(t);
  }
  const unmatchedMeasurements = meas.filter((_, i) => !used.has(i));

  const matched = text.length - unmatchedText.length;
  let note: string;
  if (text.length === 0 && meas.length === 0) note = "Rapor metninde ve ölçüm bölümünde sayı+birim bulunamadı.";
  else if (unmatchedText.length === 0 && unmatchedMeasurements.length === 0) {
    note = `Metindeki ölçüler kayıtlı ölçümlerle uyumlu (${matched}/${text.length}).`;
  } else if (unmatchedText.length > 0 && unmatchedMeasurements.length === 0) {
    note = `Metinde ${unmatchedText.length} ölçü kayıtlı ölçümlerde karşılıksız — hekim teyidi önerilir.`;
  } else if (unmatchedText.length === 0) {
    note = `${unmatchedMeasurements.length} ölçüm metinde geçmiyor — izlenimde özetlenmesi önerilir.`;
  } else {
    note = `Metinde ${unmatchedText.length} karşılıksız ölçü, üstelik ${unmatchedMeasurements.length} ölçüm metinde geçmiyor — kontrol önerilir.`;
  }

  return {
    textCount: text.length,
    measurementCount: meas.length,
    matched,
    unmatchedText: unmatchedText.slice(0, CAP),
    unmatchedMeasurements: unmatchedMeasurements.slice(0, CAP),
    note,
  };
}

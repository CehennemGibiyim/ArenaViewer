/**
 * Kurum sözlüğü ile kod eşleme (c-sr-tid1500).
 *
 * Neden: TID 1500 belgesinde **kod uydurulmaz**. Standart kavramlar DCM/SCT/UCUM
 * ile yazılır; bunların dışında kalan yerel terimler `99ATIKVIEWER` özel şemasıyla
 * işaretlenir. Lisanslı **RadLex / SNOMED CT** sözlüğü kurumda olduğu için yazılım
 * o sözlüğü dağıtmaz; bunun yerine kurumun sağladığı eşleme dosyasını **okuyup
 * doğrular** ve eşlenen terimleri belgede lisanslı kodla yazar.
 *
 * Sözleşme:
 *  - Bilinmeyen şema, geçersiz kod biçimi ve geçersiz anahtar **reddedilir**
 *    (satır numarasıyla raporlanır) — sessizce kabul edilmez.
 *  - Aynı anahtar birden çok kez gelirse son satır geçerlidir ve **uyarı** üretilir.
 *  - Kod biçimleri: RadLex `RID\d+`, SNOMED CT `\d{6,18}`, LOINC `\d{1,7}-\d`,
 *    DCM `\d+`, UCUM boşluk içermeyen ≤ 20 karakter.
 *  - Eşleme bulunamazsa çağıranın verdiği yedek kod aynen kullanılır (`mapped:false`).
 */

export interface MappingCode {
  value: string;
  scheme: string;
  meaning: string;
}

export interface CodeTable {
  /** Tablonun kaynağı (dosya adı/etiket) — denetim izi için. */
  source: string;
  /** Normalize anahtar → kod. */
  entries: Map<string, MappingCode>;
  errors: string[];
  warnings: string[];
  /** Geçerli satır sayısı. */
  accepted: number;
}

/** Şema adları ve kısa adlar → DICOM kodlama şeması. */
const SCHEME_ALIASES: Record<string, string> = {
  sct: "SCT", snomed: "SCT", "snomedct": "SCT", "snomed-ct": "SCT", "snomed ct": "SCT",
  rid: "RID", radlex: "RID", "rad-lex": "RID",
  ln: "LN", loinc: "LN",
  dcm: "DCM", dicom: "DCM",
  ucum: "UCUM",
};

export function normalizeScheme(raw: string): string | null {
  const key = (raw ?? "").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  return SCHEME_ALIASES[key] ?? null;
}

/** Koda özgü biçim denetimi; geçerliyse null, değilse gerekçe döner. */
export function codeFormatError(scheme: string, value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return "kod boş";
  switch (scheme) {
    case "RID":
      return /^RID\d{1,9}$/.test(v) ? null : "RadLex kodu RID + rakam biçiminde olmalı (ör. RID4321)";
    case "SCT":
      return /^\d{6,18}$/.test(v) ? null : "SNOMED CT kodu 6–18 haneli sayı olmalı";
    case "LN":
      return /^\d{1,7}-\d$/.test(v) ? null : "LOINC kodu NNNN-N biçiminde olmalı";
    case "DCM":
      return /^\d{1,12}$/.test(v) ? null : "DCM kodu sayı olmalı";
    case "UCUM":
      return v.length <= 20 && !/\s/.test(v) ? null : "UCUM kodu boşluksuz ve ≤20 karakter olmalı";
    default:
      return `bilinmeyen şema: ${scheme}`;
  }
}

/**
 * Eşleme anahtarını normalize eder: küçük harf (tr-TR), kenar boşlukları atılır,
 * iç boşluklar tek boşluğa iner, Türkçe karakterler ASCII karşılığına katlanır
 * (böylece "akciğer" ile "akciger" aynı anahtara düşer).
 */
export function normalizeTerm(raw: string): string {
  const folded = (raw ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i").replace(/İ/g, "i")
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/\s+/g, " ");
  return folded;
}

const KEY_RE = /^[a-z0-9][a-z0-9 ._:-]{0,79}$/;

interface RawRow { line: number; key: string; code: string; scheme: string; meaning: string }

/** CSV/TSV metnini satırlara ayırır (tırnak desteği: `"a,b"`). */
function splitDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function detectDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

/**
 * Kurum eşleme dosyasını okur. JSON (`[{key,code,scheme,meaning}]` veya
 * `{entries:[...]}`) ve CSV/TSV (başlık satırı: key, code, scheme, meaning)
 * desteklenir. Bozuk satırlar `errors` içinde satır numarasıyla döner.
 */
export function parseCodeTable(text: string, opts: { source?: string } = {}): CodeTable {
  const table: CodeTable = { source: opts.source ?? "kurum-sözlüğü", entries: new Map(), errors: [], warnings: [], accepted: 0 };
  const body = (text ?? "").replace(/^\uFEFF/, "").trim();
  if (!body) { table.errors.push("dosya boş"); return table; }

  let rows: RawRow[] = [];
  if (body.startsWith("[") || body.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch (e) {
      table.errors.push(`JSON okunamadı: ${e instanceof Error ? e.message : "geçersiz"}`);
      return table;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(list)) { table.errors.push("JSON içinde dizi ya da {entries:[…]} bekleniyordu"); return table; }
    rows = list.map((r, i) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        line: i + 1,
        key: String(o.key ?? ""),
        code: String(o.code ?? o.value ?? ""),
        scheme: String(o.scheme ?? ""),
        meaning: String(o.meaning ?? o.display ?? ""),
      };
    });
  } else {
    const firstLine = body.split(/\r?\n/)[0] ?? "";
    const delim = detectDelimiter(firstLine);
    const grid = splitDelimited(body, delim);
    if (!grid.length) { table.errors.push("satır yok"); return table; }
    const header = grid[0].map((h) => h.toLocaleLowerCase("en-US").trim());
    const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
    const kKey = idx(["key", "anahtar", "term", "terim"]);
    const kCode = idx(["code", "kod", "value"]);
    const kScheme = idx(["scheme", "şema", "sema", "sistem"]);
    const kMeaning = idx(["meaning", "display", "aciklama", "açıklama", "anlam"]);
    if (kKey < 0 || kCode < 0 || kScheme < 0) {
      table.errors.push("başlık satırı key, code, scheme (ve isteğe bağlı meaning) içermeli");
      return table;
    }
    rows = grid.slice(1).map((cells, i) => ({
      line: i + 2,
      key: cells[kKey] ?? "",
      code: cells[kCode] ?? "",
      scheme: cells[kScheme] ?? "",
      meaning: kMeaning >= 0 ? cells[kMeaning] ?? "" : "",
    }));
  }

  for (const r of rows) {
    if (!r.key && !r.code && !r.scheme) continue; // boş satır
    const key = normalizeTerm(r.key);
    if (!key) { table.errors.push(`satır ${r.line}: anahtar boş`); continue; }
    if (!KEY_RE.test(key)) { table.errors.push(`satır ${r.line}: geçersiz anahtar "${r.key}" (harf/rakam/boşluk/._:-)`); continue; }
    const scheme = normalizeScheme(r.scheme);
    if (!scheme) { table.errors.push(`satır ${r.line}: bilinmeyen şema "${r.scheme}"`); continue; }
    const fmtErr = codeFormatError(scheme, r.code);
    if (fmtErr) { table.errors.push(`satır ${r.line}: ${fmtErr} ("${r.code}")`); continue; }
    if (table.entries.has(key)) table.warnings.push(`satır ${r.line}: "${key}" yinelendi — son satır geçerli`);
    table.entries.set(key, {
      value: r.code.trim(),
      scheme,
      meaning: r.meaning.trim() || r.key.trim(),
    });
    table.accepted++;
  }
  if (table.accepted === 0 && table.errors.length === 0) table.errors.push("geçerli eşleme satırı yok");
  return table;
}

/**
 * Terimi kurum tablosunda arar. Bulunamazsa yedek kod **aynen** döner ve
 * `mapped:false` olur (uydurma kod yazılmaz).
 */
export function mapTerm(
  term: string,
  fallback: MappingCode,
  table?: CodeTable | null,
): { code: MappingCode; mapped: boolean } {
  if (!table) return { code: fallback, mapped: false };
  const hit = table.entries.get(normalizeTerm(term));
  if (!hit) return { code: fallback, mapped: false };
  return { code: hit, mapped: true };
}

/**
 * Bir kodu tabloyla eşler: yalnız `99ATIKVIEWER` (özel) kodlar ve anlamı tabloda
 * bulunan standart kodlar eşlenir; standart kod (DCM/SCT/LN/UCUM) zaten geçerliyse
 * dokunulmaz. Böylece kurum tablosu standart kodları **ezmez**.
 */
export function mapCodeObject(
  code: MappingCode,
  table?: CodeTable | null,
): { code: MappingCode; mapped: boolean } {
  if (!table) return { code, mapped: false };
  if (code.scheme !== "99ATIKVIEWER") return { code, mapped: false };
  const byValue = table.entries.get(normalizeTerm(code.value));
  if (byValue) return { code: byValue, mapped: true };
  return mapTerm(code.meaning, code, table);
}

/** Eşleme kapsamı: kaç terim eşlendi (arayüz/denetim raporu için). */
export function mappingCoverage(terms: string[], table: CodeTable): { total: number; mapped: number; missing: string[] } {
  const missing: string[] = [];
  let mapped = 0;
  for (const t of terms) {
    if (table.entries.has(normalizeTerm(t))) mapped++;
    else missing.push(t);
  }
  return { total: terms.length, mapped, missing };
}

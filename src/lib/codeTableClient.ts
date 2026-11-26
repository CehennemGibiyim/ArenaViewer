/**
 * Tarayıcıda saklanan kurum kod eşleme tablosu (lisanslı RadLex/SNOMED CT dosyası).
 * ExportMenu (indirme akışı) ve Workstation (onayda TID 1500 gönderimi) paylaşır.
 * Dosya kurumdan gelir; yazılım sözlük dağıtmaz, yalnız okur ve doğrular.
 */
import { readPreference } from "./browserPreferences";
import { parseCodeTable, type CodeTable } from "./codeMapping";

export const CODE_MAP_KEY = "codemap:v1";

interface StoredCodeMap { text: string; source: string }

export function loadCodeTable(): { table: CodeTable; text: string } | null {
  const stored = readPreference(CODE_MAP_KEY) as StoredCodeMap | null | undefined;
  if (!stored || typeof stored.text !== "string" || !stored.text) return null;
  const table = parseCodeTable(stored.text, { source: stored.source || "kurum sözlüğü" });
  return table.accepted > 0 ? { table, text: stored.text } : null;
}

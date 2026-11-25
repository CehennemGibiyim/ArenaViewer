/** DICOMweb STOW-RS yanıtı: yalnızca açık kabul kanıtı başarı sayılır. */
export function parseStowResponse(text: string, expectedSopUid: string): { stored: number; failed: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("PACS gönderim sonucu doğrulanamadı (geçersiz veya boş DICOM JSON yanıtı)."); }
  const datasets = Array.isArray(parsed) ? parsed : [parsed];
  if (datasets.length !== 1 || !datasets[0] || typeof datasets[0] !== "object" || Array.isArray(datasets[0])) {
    throw new Error("PACS gönderim sonucu doğrulanamadı (beklenmeyen yanıt biçimi).");
  }
  const dataset = datasets[0] as Record<string, unknown>;
  function sequence(tag: string): unknown[] {
    if (!(tag in dataset)) return [];
    const field = dataset[tag];
    if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error("PACS gönderim sonucu doğrulanamadı (geçersiz sonuç dizisi).");
    const item = field as Record<string, unknown>;
    if (item.vr !== "SQ" || !Array.isArray(item.Value)) throw new Error("PACS gönderim sonucu doğrulanamadı (geçersiz sonuç dizisi).");
    return item.Value;
  }
  const stored = sequence("00081199");
  const failed = sequence("00081198");
  // Tek STOW çağrısı tek nesne gönderir. UID'siz veya hatalı sonuç başarı kanıtı değildir.
  const validReference = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const uid = (entry as Record<string, unknown>)["00081155"];
    if (!uid || typeof uid !== "object" || Array.isArray(uid)) return false;
    const values = (uid as Record<string, unknown>).Value;
    return Array.isArray(values) && values.length === 1 && typeof values[0] === "string" && values[0] === expectedSopUid && /^[0-9]+(\.[0-9]+)*$/.test(values[0]) && values[0].length <= 64;
  };
  if (failed.length) throw new Error(`PACS gönderilen nesneyi reddetti (${failed.length} hata).`);
  if (stored.length !== 1 || !validReference(stored[0])) throw new Error("PACS gönderim sonucu doğrulanamadı (kabul edilen nesne bilgisi yok).");
  return { stored: stored.length, failed: 0 };
}

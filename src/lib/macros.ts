/**
 * Rapor makroları (D4): sık kullanılan teknik/bulgu/öneri cümle blokları.
 *
 * Makrolar yalnızca metin şablonudur; hekim düzenlemesi ve onayı zorunludur.
 * Klinik sözlük (Radslex/ACR) ve konuşma tanıma entegrasyonu ayrı çalışmadır.
 */

export type MacroGroup = "teknik" | "bulgu" | "oneri";

export interface Macro {
  id: string;
  label: string;
  group: MacroGroup;
  /** [KONUM]/[BOYUT] gibi yer tutucular içerebilir */
  text: string;
}

export const MACRO_GROUPS: Record<MacroGroup, string> = {
  teknik: "Teknik",
  bulgu: "Bulgu",
  oneri: "Öneri",
};

export const MACROS: Macro[] = [
  // ── Teknik ──
  { id: "t-kar-sag", label: "BT toraks: kontrastlı seri", group: "teknik", text: "Toraks BT'si intravenöz kontrast madde uygulanarak, [KESİT] mm kesit kalınlığında ve [ARALIK] mm ara hesap ile değerlendirildi." },
  { id: "t-mr-sekans", label: "MR: sekans seti", group: "teknik", text: "[BÖLGE] MR incelemesi T1 ağırlıklı, T2 ağırlıklı, [EK SEKANS] ve postkontrast serilerden oluşmakta olup [KESİT] sayıda kesit elde edildi." },
  { id: "t-us-doppler", label: "US: renkli Doppler", group: "teknik", text: "[BÖLGE] ultrason incelemesi B-mod ve renkli Doppler ile [SÜRE] boyunca değerlendirildi; Doppler ölçümleri kalibrasyonsuz nicel kayıttır." },
  { id: "t-mg-yapi", label: "Mamografi: CC/MLO", group: "teknik", text: "Her iki memede de CC ve MLO pozisyonlarda dijital mamografi elde edildi; yoğunluk [YOĞUNLUK] sınıfı olarak değerlendirildi." },

  // ── Bulgu ──
  { id: "b-normal", label: "Bulgu yok", group: "bulgu", text: "İnceleme alanında önemli bir bulgu saptanmadı." },
  { id: "b-nodul", label: "Nodül tanımı", group: "bulgu", text: "[KONUM] lokalizasyonda, [BOYUT] mm ölçülerinde, [KONTUR] konturlu, [YOĞUNLUK] dansiteli nodül izlenmiştir." },
  { id: "b-hu-aralik", label: "HU aralığı", group: "bulgu", text: "ODAK: [HU_ARALIGI] HU aralığında; bu bulgu olasılıkla [PATLOJI] ile uyumludur." },
  { id: "b-mr-sinyal", label: "MR sinyal değişimi", group: "bulgu", text: "[KONUM] lokalizasyonda T1 [SİNYAL], T2 [SİNYAL] sinyal değişimi gösteren [BOYUT] mm lezyon saptandı." },
  { id: "b-karsilastirma", label: "Önceki tetkikle karşılaştırma", group: "bulgu", text: "[TARİH] tarihli önceki tetkikle kıyaslandığında bulgu [DEĞİŞİM] (boyut [BAZAL] mm → [ŞİMDİ] mm)." },
  { id: "b-konsolidasyon", label: "Akciğer konsolidasyonu", group: "bulgu", text: "[LOBU] lobda [BOYUT] mm ölçülerinde [PATLOJI] konsondu; havalenme [VAR/YOK]." },

  // ── Öneri ──
  { id: "o-takip", label: "Takip önerisi (süreli)", group: "oneri", text: "[SÜRE] süre sonra [MODALİTE] ile kısa süreli takip önerilir." },
  { id: "o-biyopsi", label: "Doku örneklemesi önerisi", group: "oneri", text: "Bulgunun patoloji açısından netleştirilmesi için [YÖNTEM] yöntemiyle doku örneklemesi önerilir." },
  { id: "o-konsultasyon", label: "Konsültasyon", group: "oneri", text: "Klinik durum gereği [BRANŞ] kliniği konsültasyonu önerilir." },
  { id: "o-ek-tetkik", label: "Ek tetkik", group: "oneri", text: "Saptanan bulguya eşlik eden [EK TETKİK] ile tamamlayıcı değerlendirme yapılması yararlı olacaktır." },
];

/** id ile makroyu döndürür; bilinmeyende null. */
export function macroById(id: string): Macro | null {
  return MACROS.find((m) => m.id === id) ?? null;
}

/** Gruba göre makroları döndürür. */
export function macrosByGroup(group: MacroGroup): Macro[] {
  return MACROS.filter((m) => m.group === group);
}

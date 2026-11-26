/**
 * Amaçlanan kullanım (intended use), kullanım sınırları ve sürüm bilgisi.
 *
 * Tek kaynak: üst çubuktaki uyarı, "Hakkında" paneli, rapor çıktısı ve dokümanlar
 * buradaki metni kullanır. Amaç, ürünün **ne olmadığını** her yerde aynı cümleyle
 * söylemek: bu bir tıbbi cihaz değildir, klinik karar için kullanılamaz.
 *
 * Dürüstlük notları:
 *  - Sürüm numarası derleme anında gömülür (`NEXT_PUBLIC_APP_VERSION`); yoksa
 *    "0.1.0-demo" görünür — uydurma bir sürüm numarası yazılmaz.
 *  - CE/FDA/IVDR beyanı **yoktur**; metin bunu açıkça söyler.
 */

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0-demo";
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";

export interface IntendedUse {
  /** Ürün adı. */
  product: string;
  /** Tek cümlelik amaçlanan kullanım. */
  statement: string;
  /** Kullanıcı kitlesi. */
  users: string[];
  /** Amaçlanan kullanım alanları (izin verilen). */
  indications: string[];
  /** Amaçlanmayan kullanımlar (yasak). */
  contraindications: string[];
  /** Bilinen sınırlar. */
  limits: string[];
  /** Düzenleyici durum — tek cümle. */
  regulatory: string;
}

export const INTENDED_USE: IntendedUse = {
  product: "ArenaViewer",
  statement:
    "ArenaViewer; DICOM görüntülerini görüntülemek, ölçüm almak, anotasyon eklemek ve araştırma/eğitim amaçlı yazılım iş akışlarını denemek için geliştirilmiş bir demo/araştırma yazılımıdır. Tıbbi cihaz değildir.",
  users: [
    "Yazılım geliştiricileri ve tıbbi görüntüleme araştırmacıları",
    "Eğitim amaçlı kullanan sağlık personeli (klinik dışı ortamda)",
  ],
  indications: [
    "DICOM dosyalarının görsel incelenmesi ve pencere/ölçüm araçlarının denenmesi",
    "Arayüz, PACS entegrasyonu ve raporlama akışlarının geliştirme/test ortamında sınanması",
    "Açık veri setleri ve fantomlar üzerinde yöntem karşılaştırması",
  ],
  contraindications: [
    "Klinik tanı, tedavi planlaması ve hasta takibi",
    "Tarama (screening) veya triyaj kararı",
    "Tıbbi rapor yerine geçecek herhangi bir çıktı",
    "Kalibre edilmemiş ölçümlerin (mm, HU, SUV) klinik eşik olarak kullanılması",
  ],
  limits: [
    "Yapay zekâ çıktıları deneyseldir ve radyoloji uzmanı onayı olmadan hiçbir işlem yapılmaz; skorlar kalibre değildir.",
    "Ölçümler piksel aralığına ve görüntü kalibrasyonuna bağlıdır; SUV/SUVlbm/SUVbsa değerleri hesaplanmış tahmindir.",
    "Statik (Pages) demo tek kullanıcılıdır ve tarayıcı belleğinde çalışır; sunucu tarafı iş akışları (PACS, HL7, MWL) yalnız tam sürümde vardır.",
    "Bazı üretici özel etiketleri ve transfer sözdizimleri (ör. MPEG video) desteklenmez.",
  ],
  regulatory: "CE, FDA, IVDR veya MDR belgesi YOKTUR; risk sınıflandırması yapılmamıştır. Klinik doğrulama tamamlanmamıştır.",
};

/** Sürüm satırı: "0.1.0-demo (derleme dev)". */
export function versionLine(): string {
  return `${APP_VERSION} (derleme ${BUILD_ID})`;
}

/** Panellerde/rapor altbilgisinde gösterilen kısa uyarı (tek satır). */
export const SHORT_DISCLAIMER = "DEMO / ARAŞTIRMA — klinik karar için kullanılamaz";

/** Düz metin sürümü (rapor altbilgisi, panoya kopyalama, doküman üretimi). */
export function intendedUseText(): string {
  const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    `${INTENDED_USE.product} — Amaçlanan Kullanım (sürüm ${versionLine()})`,
    "",
    INTENDED_USE.statement,
    "",
    "Kullanıcılar:", bullets(INTENDED_USE.users),
    "",
    "Amaçlanan kullanım:", bullets(INTENDED_USE.indications),
    "",
    "Amaçlanmayan kullanımlar:", bullets(INTENDED_USE.contraindications),
    "",
    "Bilinen sınırlar:", bullets(INTENDED_USE.limits),
    "",
    `Düzenleyici durum: ${INTENDED_USE.regulatory}`,
  ].join("\n");
}

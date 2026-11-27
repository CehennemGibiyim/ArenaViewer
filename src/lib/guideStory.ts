/**
 * Uygulama içi **Resimli Anlatım** (`/resimlianlatim`) içeriği.
 *
 * Tek veri kaynağı: sayfa, Yardım sayfasındaki özet ve "kapsam testleri"
 * (`tests/guide-story.test.ts`) aynı listeyi okur. Görseller depodaki
 * **gerçek ekran görüntüleri / elle çizilmiş SVG'ler**dir (`docs/img/`); sayfa
 * bunları olduğu gibi kullanır — üretilmiş sahte ekran görüntüsü yoktur.
 *
 * Kural (docs/KILAVUZ_BAKIMI.md):
 *  - Her adımda `where` = ekranda gördüğünüz yerin **birebir** adı,
 *  - `web` = statik web demosunda da yapılabilir mi?
 *  - Görseli olmayan adım `image` alanını boş bırakır (uydurma görsel eklenmez).
 */

/** Görseller `public/kilavuz/` altında; `docs/img/` ile bayt bayt aynıdır (test denetler). */
export const GUIDE_IMAGE_WIDTHS: Record<string, number> = {
  "diyagram-mimari.jpg": 1200,
  "diyagram-web-yerel-farki.jpg": 1200,
  "diyagram-windows-kurulum.jpg": 1200,
  "diyagram-macos-linux-kurulum.jpg": 1200,
  "diyagram-sorun-giderme.jpg": 1200,
  "diyagram-yol-haritasi.jpg": 1200,
  "ekran-ana-arayuz.jpg": 1366,
  "ekran-menu-haritasi.jpg": 1366,
  "sema-ai-akisi.svg": 960,
  "sema-tema-dil.svg": 960,
  "sema-resimli-anlatim.svg": 940,
};

export interface GuideStep {
  /** Kısa başlık (numaralı adım). */
  title: string;
  /** Ekranda gördüğünüz yer — birebir menü adı. */
  where: string;
  /** Ne yapılır. */
  what: string;
  /** Sonuç / uyarı. */
  result: string;
  /** Statik web demosunda mümkün mü? */
  web: "evet" | "hayir" | "kismi";
  /** `public/kilavuz/` altındaki dosya adı (yoksa undefined). */
  image?: string;
  /** Görsel alt metni (erişilebilirlik). */
  alt?: string;
}

export interface GuideSection {
  id: string;
  title: string;
  /** Bu bölümün amacı (tek cümle). */
  goal: string;
  steps: GuideStep[];
  /** Bölüm sonu notu (sınır/uyarı). */
  note?: string;
}

export const GUIDE_INTRO = {
  title: "Resimli Anlatım",
  lead:
    "İlk açılıştan rapor onayına kadar her işlem: nerede, ne yapılır, ne olur. Görseller gerçek arayüzden alınmıştır; " +
    "hiçbirinde hasta verisi yoktur.",
  disclaimer:
    "ATIKVIEWER araştırma amaçlıdır ve tıbbi cihaz değildir. Yapay zekâ çıktılarının tamamı taslaktır; son söz radyoloji uzmanınındır.",
  /**
   * Fotoğraf göstermeyen adımlar için elle çizilmiş **özgün** adaptör şeması
   * (`public/kilavuz/sema-resimli-anlatim.svg`). Var olan bir ekran görüntüsünü
   * başka bir adımın kanıtı gibi göstermemek için ayrı bir görsel kullanılır.
   */
  /**
   * Sürüm numarası **elle yazılmaz**: ekran görüntüleri eski bir sürümden
   * kalabilir. Kılavuz bu yüzden "güncel sürümde şu düğmeler var" der.
   */
  versionNote: "Ekran görüntüleri geliştirme derlemesinden alınmıştır; düğme adları güncel sürümle aynıdır.",
  flowImage: "sema-resimli-anlatim.svg",
  flowAlt: "Resimli anlatım akışı: oku → nerede olduğunu bul → adımı uygula → sonucu doğrula",
} as const;

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: "mimari",
    title: "1 · İki süreç, tek kural",
    goal: "Görüntüleyici ile AI worker arasındaki ilişkiyi ve veri kuralını anlamak.",
    steps: [
      {
        title: "Görüntüleyici (tarayıcı)",
        where: "Adres çubuğunuzdaki uygulama (yerelde http://127.0.0.1:3000)",
        what: "DICOM okuma, MPR, ölçüm, rapor, paylaşım ve /api/* uçları bu süreçte çalışır.",
        result: "AI worker kapalıyken bile görüntüleme, ölçüm ve rapor tam çalışır.",
        web: "evet",
        image: "diyagram-mimari.jpg",
        alt: "Görüntüleyici, AI worker ve PACS arasındaki veri akışı şeması",
      },
      {
        title: "AI worker (Python)",
        where: "Ayrı terminal: python ai-worker/server.py → 127.0.0.1:8787",
        what: "CXR, BT toraks nodül adayı ve BT beyin (ICH) modelleri yalnız bu süreçte koşar; yalnız bu makinede dinler.",
        result: "Worker kapalıysa BT analizi kural tabanlı yedeğe düşer; ekranda “worker: kapalı” uyarısı çıkar.",
        web: "hayir",
      },
    ],
    note: "Tek kural: görüntüleyiciye yüklediğiniz hasta verisi hiçbir yere gönderilmez.",
  },
  {
    id: "ortam",
    title: "2 · Hangi ortamda çalışıyorsunuz?",
    goal: "Web demosu ile yerel/kurum kurulumunun farkını ayırmak.",
    steps: [
      {
        title: "Web demosu (GitHub Pages)",
        where: "cehennemgibiyim.github.io/ArenaViewer",
        what: "Arayüzün tanıtımı; /api/* yoktur, AI düğmeleri çalışmaz, /ayna ve /yonetim demo etiketlidir.",
        result: "Gerçek görüntüyle çalışmak için yerel veya kurum kurulumu gerekir.",
        web: "evet",
        image: "diyagram-web-yerel-farki.jpg",
        alt: "Web demosu ile yerel kurulum arasındaki farklar şeması",
      },
      {
        title: "Yerel kurulum (Windows / macOS / Linux / Docker)",
        where: "windows\\Baslat.bat · ./baslat.sh · docker compose up -d",
        what: "Görüntüleyici + isteğe bağlı AI worker + PostgreSQL birlikte başlar.",
        result: "Kalıcı çalışma listesi, rapor, denetim ve paylaşım bu kurulumda çalışır.",
        web: "hayir",
        image: "diyagram-windows-kurulum.jpg",
        alt: "Windows kurulum adımları şeması",
      },
    ],
  },
  {
    id: "ilk-acilis",
    title: "3 · İlk açılışta ekranı tanımak",
    goal: "Ana arayüzde hangi bölgenin ne işe yaradığını bir bakışta görmek.",
    steps: [
      {
        title: "Ana arayüz",
        where: "Üst çubuk + sol SERİLER paneli + orta görüntüleme + sağ inceleme paneli",
        what: "Solda seri listesi, ortada görüntü, sağda Vision AI / Rapor / Ölçüm / DICOM / Geçmiş sekmeleri.",
        result: "Hiçbir dosya açılmadan da tüm düğmeler görünür; pasif olanlar tıklanınca nedenini söyler.",
        web: "evet",
        image: "ekran-ana-arayuz.jpg",
        alt: "ATIKVIEWER ana arayüz ekran görüntüsü (boş, hasta verisi yok)",
      },
      {
        title: "Menü haritası",
        where: "Aynı ekran; bölgeler 1–11 numaralı",
        what: "Her numaralı bölge ayrı bir araç grubudur (dosya, panel, ızgara, protokol, MPR, anotasyon, ölçüm…).",
        result: "Aradığınız düğmeyi önce bölge numarasıyla bulun; ayrıntısı MENU_KILAVUZU'da aynı numaradadır.",
        web: "evet",
        image: "ekran-menu-haritasi.jpg",
        alt: "Numaralandırılmış menü haritası ekran görüntüsü",
      },
    ],
  },
  {
    id: "calisma-acma",
    title: "4 · Bir çalışmayı uçtan uca açmak",
    goal: "DICOM'u açmaktan anahtar kesit eklemeye kadar temel akış.",
    steps: [
      {
        title: "Dosya / klasör / ZIP yükle",
        where: "Bölge 1 · Dosya aç · Klasör aç · ya da pencereye sürükle-bırak",
        what: "DCM ayrıştırılır; yukarıda ilerleme rozeti (x / toplam) çıkar, gerekirse iptal edilir.",
        result: "Seriler modalite/boyuta göre gruplanır ve SERİLER panelinde listelenir.",
        web: "evet",
      },
      {
        title: "Seriyi seç ve pencerele",
        where: "Sol SERİLER paneli · Bölge 9 · Pencere ön ayarı + görüntü üzerinde sürükleme",
        what: "Sol tuş sürükleme pencere/seviye, sağ tuş kaydırma; tekerlek kesit değiştirir.",
        result: "BT'de beyin/akciğer/kemik hazır W/L'leri; MR'da elle ayar.",
        web: "evet",
      },
      {
        title: "Ölçüm al ve anahtar kesit ekle",
        where: "Bölge 8 · Uzunluk (U) · Açı · Cobb · Çokgen · K (anahtar kesit)",
        what: "Ölçümler anında seriye bağlanır; K ile o kesit raporun anahtar kesitler bölümüne eklenir.",
        result: "Ölçümler ve anahtar kesitler rapora otomatik aktarılır; sunucu varsa kalıcı saklanır.",
        web: "kismi",
      },
      {
        title: "Sunucuya kaydet (isteğe bağlı)",
        where: "Bölge 1 · ☁ Sunucuya kaydet",
        what: "Görüntü AES-256-GCM ile şifrelenip sunucuya yazılır; PACS yapılandırıldıysa STOW-RS ile gönderilir.",
        result: "DB yoksa bu düğme kapalıdır; ekranda nedeni yazar.",
        web: "hayir",
      },
    ],
  },
  {
    id: "ai",
    title: "5 · Vision AI ile analiz",
    goal: "Analizi bilinçli başlatmak ve sonucu taslak olarak değerlendirmek.",
    steps: [
      {
        title: "Protokolü seç",
        where: "Sağ panel · Vision AI · Analiz protokolü",
        what: "Otomatik · Tüm karelerde görüntü ölçümü · BT Beyin (kanama adayı) · BT Toraks (nodül adayı) · İncelemeyi kapat.",
        result: "Otomatik seçim modalite + içerikten tahmin eder; emin değilse açıkça söyler.",
        web: "evet",
        image: "sema-ai-akisi.svg",
        alt: "Vision AI analiz karar ağacı şeması",
      },
      {
        title: "Analizi başlat",
        where: "Sağ panel · Vision AI · Analizi başlat (N kesit)",
        what: "İşlem sürerken düğmede ilerleme görünür; uzun sürerse İptal sunulur.",
        result: "Sonuç TASLAK listesidir: her aday kesit, güven skoru ve kısa gerekçeyle gelir.",
        web: "hayir",
      },
      {
        title: "Adayları incele",
        where: "Sağ panel · Rapor · bulgu blokları",
        what: "Her adayı Onayla / Reddet / Düzenle olarak işaretleyin; ret ve düzenlemede gerekçe zorunludur.",
        result: "Onaylamadığınız aday rapora girmez; karar AI önerisinden ayrı saklanır.",
        web: "kismi",
      },
    ],
    note: "Gölge mod (NEXT_PUBLIC_AI_SHADOW_MODE=true) yalnız kaydeder, ekrana düşürmez; özeti Yönetim → AI performans.",
  },
  {
    id: "rapor",
    title: "6 · Rapor: taslak → onay → dışa aktarım",
    goal: "Raporu bitirmek ve paylaşılabilir hâle getirmek.",
    steps: [
      {
        title: "Raporu aç",
        where: "Sağ panel · Rapor · 📄 Raporu aç",
        what: "Şablon seçin (Kapsamlı / Acil triyaj / Ayırıcı tanı / Hasta özeti); gövde AI adayları ve ölçümlerle önceden doldurulur.",
        result: "Rapor her zaman TASLAK etiketiyle başlar.",
        web: "kismi",
      },
      {
        title: "Onayla (kilitlenir)",
        where: "Rapor ekranı · Onayla",
        what: "İçerik SHA-256 ile mühürlenir ve denetim zincirine yazılır; yanlışsa yeni sürüm oluşturulur.",
        result: "Onaylı rapor değiştirilemez; düzeltme yeni sürüm veya addendum ile yapılır.",
        web: "hayir",
      },
      {
        title: "Dışa aktar / paylaş",
        where: "Rapor ekranı · 🖨 Aç/yazdır · DICOM SR · Hasta mektubu · Paylaş",
        what: "PDF çıktı, DICOM SR, hasta dostu mektup, FHIR DiagnosticReport; Paylaş süreli bağlantı üretir.",
        result: "Paylaşım bağlantıları Yönetim → Paylaşım sekmesinde izlenir ve kapatılır.",
        web: "kismi",
      },
    ],
  },
  {
    id: "tema-dil",
    title: "7 · Tema, dil ve erişilebilirlik",
    goal: "Okuma konforunu kendi tercihinize göre ayarlamak.",
    steps: [
      {
        title: "Tema seç",
        where: "Üst çubuk · Tema seç",
        what: "Koyu (varsayılan) · Klinik Mavi · Açık Tema · Yüksek Kontrast. Seçim cihazda saklanır, DICOM pikseli etkilenmez.",
        result: "Yüksek kontrast ikincil metinleri AA eşiğine çıkarır.",
        web: "evet",
        image: "sema-tema-dil.svg",
        alt: "Tema ve dil değiştirme mekanizması şeması",
      },
      {
        title: "Dil seç",
        where: "Üst çubuk · 🌐 Dil seç",
        what: "83 tam çeviri paketi aranır; çevirisi olmayan dil İngilizce yedeğiyle açılır ve “EN UI” rozeti gösterilir.",
        result: "Paket yalnız seçildiğinde indirilir; belgeler ve AI rapor gövdesi Türkçe kalır.",
        web: "evet",
      },
    ],
  },
  {
    id: "sorun",
    title: "8 · Bir şey çalışmıyorsa",
    goal: "En sık üç sorunun hızlı çözümü.",
    steps: [
      {
        title: "AI düğmeleri yanıt vermiyor",
        where: "Terminal: curl http://127.0.0.1:8787/health",
        what: "Worker sürecinin ayakta olduğunu doğrulayın; değilse python ai-worker/server.py ile başlatın.",
        result: "Yanıt {\"ok\": true} değilse model yüklenmemiştir (setup_model.py).",
        web: "hayir",
        image: "diyagram-sorun-giderme.jpg",
        alt: "Sorun giderme akış şeması",
      },
      {
        title: "DICOM açılmıyor",
        where: "Dosya aç / sürükle-bırak",
        what: "Dosyanın gerçekten DICOM olduğunu doğrulayın; şifreli bölüm ve desteklenmeyen JPEG-XL açıkça bildirilir.",
        result: "Hata mesajı hangi öğede takıldığını söyler; sessizce boş ekran bırakmaz.",
        web: "kismi",
      },
    ],
    note: "Ayrıntılı S.S.S.: /yardim · Envanter ve boyut: docs/GORSEL_ANLATIM.md §9.",
  },
];

/** Görselin tarayıcıdaki yolunu üretir (GitHub Pages alt yolu dahil). */
export function guideImageSrc(file: string, basePath = ""): string {
  return `${basePath}/kilavuz/${file}`;
}

/** Statik demoda sayfanın üstünde gösterilecek şerit metni. */
export const GUIDE_DEMO_NOTE =
  "Statik demo: /api/* yoktur. Bu sayfadaki görseller ve adımlar gerçek arayüzle birebir aynıdır; " +
  "sunucu gerektiren adımlar “yerel kurulum” olarak işaretlenmiştir.";

/** Adımların ortam dağılımı — sayfa başında özet olarak gösterilir. */
export function guideStats(sections: readonly GuideSection[] = GUIDE_SECTIONS) {
  const steps = sections.flatMap((s) => s.steps);
  return {
    sections: sections.length,
    steps: steps.length,
    web: steps.filter((s) => s.web === "evet").length,
    local: steps.filter((s) => s.web === "hayir").length,
    partial: steps.filter((s) => s.web === "kismi").length,
    images: new Set(steps.map((s) => s.image).filter(Boolean)).size,
  };
}

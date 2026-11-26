export type GapStatus = "var" | "kismi" | "yok";
export type GapPriority = "P0" | "P1" | "P2" | "P3";
export type GapEffort = "S" | "M" | "L";
export type CategoryId = "format" | "viewing" | "measure" | "ai" | "report" | "workflow" | "trust";
export type CompetitorType = "viewer" | "ai" | "report";

export interface GapCategory {
  id: CategoryId;
  title: string;
  icon: string;
  blurb: string;
}

export interface GapItem {
  id: string;
  category: CategoryId;
  title: string;
  status: GapStatus;
  priority: GapPriority;
  effort: GapEffort;
  /** Bu özelliği sunduğu bilinen piyasa ürünleri */
  market: string[];
  /** Bizde şu an ne var (dürüst durum) */
  ours: string;
  /** Kapatmak için önerilen aksiyon */
  action: string;
}

export interface Competitor {
  name: string;
  type: CompetitorType;
  focus: string;
  strengths: string[];
  learn: string;
}

/** Rakiplerin resmî siteleri — kartlarda "↗ Resmî site" bağlantısı olarak gösterilir. */
export const COMPETITOR_SITES: Record<string, string> = {
  RadiAnt: "https://www.radiantviewer.com/",
  OHIF: "https://ohif.org/",
  Weasis: "https://weasis.org/",
  // horosproject.org 2026-11'de yanıt vermiyor; canlı kaynak GitHub deposu (bkz. gapSources.ts).
  Horos: "https://github.com/horosproject/horos",
  "3D Slicer": "https://www.slicer.org/",
  MedDream: "https://meddream.com/products/meddream-dicom-viewer/",
  MicroDicom: "https://www.microdicom.com/",
  OsiriX: "https://www.osirix-viewer.com/",
  Aidoc: "https://www.aidoc.com/",
  "Viz.ai": "https://www.viz.ai/",
  Lunit: "https://www.lunit.io/",
  Annalise: "https://annalise.ai/",
  Gleamer: "https://www.gleamer.ai/",
};

export interface RoadmapPhase {
  id: string;
  title: string;
  timeframe: string;
  goal: string;
  itemIds: string[];
}

export const CATEGORIES: GapCategory[] = [
  { id: "format", title: "Format & Veri Okuma", icon: "🗂", blurb: "Gerçek hastane verisini hatasız açabilmek" },
  { id: "viewing", title: "Görüntüleme & Navigasyon", icon: "🖥", blurb: "RadiAnt / OHIF / Weasis düzeyinde okuma konforu" },
  { id: "measure", title: "Ölçüm & Anotasyon", icon: "📐", blurb: "Ölçümlerin doğruluğu ve kalıcılığı" },
  { id: "ai", title: "Yapay Zeka Yetenekleri", icon: "🤖", blurb: "Aidoc / Viz.ai / Lunit / Annalise düzeyinde AI iş akışı" },
  { id: "report", title: "Raporlama & Onay", icon: "📝", blurb: "PowerScribe / Rad AI düzeyinde rapor üretimi" },
  { id: "workflow", title: "İş Akışı & Entegrasyon", icon: "🔗", blurb: "PACS, çalışma listesi, kullanıcılar, denetim" },
  { id: "trust", title: "Güvenlik, Uyum & Güven", icon: "🛡", blurb: "Klinik kullanıma giden yolun şartları" },
];

export const BASE_ITEMS: GapItem[] = [
  // ───────── FORMAT ─────────
  {
    id: "f-codec", category: "format", title: "Sıkıştırılmış DICOM (JPEG, JPEG-LS, JPEG 2000, RLE)",
    status: "var", priority: "P0", effort: "M",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos", "3D Slicer"],
    ours: "**Var:** `src/lib/codecs.ts` + WASM ikilileri (`public/wasm/`): RLE, JPEG Baseline/Extended (8/12-bit), JPEG Lossless, **JPEG 2000** (OpenJPEG) ve **JPEG-LS** (CharLS) çözülür; 16-bit ve renkli biçimler desteklenir. Fixture testleriyle doğrulanmış: JPEG-LS lossless çözümü ham RAW ile birebir eşleşiyor (`tests/codecs.test.ts`). Eksik kalan: MPEG/MJPEG video ve eksiksiz HTJ2K doğrulaması.",
    action: "HTJ2K (1.2.840.10008.1.2.4.201–203) için OpenJPEG WASM üzerinden gerçek DICOM fixture'ı doğrulamak; gerekirse MPEG çözücüsü.",
  },
  {
    id: "f-uncompressed", category: "format", title: "Sıkıştırılmamış DICOM (Implicit/Explicit Little Endian)",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos"],
    ours: "dicom-parser ile okunuyor; bit maskeleme (Bits Stored), işaretli/işaretsiz 16-bit, Rescale Slope/Intercept uygulanıyor.",
    action: "Big Endian ve Deflated için ek destek (düşük öncelik).",
  },
  {
    id: "f-pixel", category: "format", title: "Fotometrik yorum: MONOCHROME1/2, RGB, multi-frame",
    status: "kismi", priority: "P2", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis"],
    ours: "`src/lib/photometric.ts` (saf, testli) + `dicom.ts` çözücüsü. **Gri:** MONOCHROME2 doğrudan; MONOCHROME1 **tüm kesitlerde tek sabitle** (max+min) ters çevrilir — tip korunur (Uint16 → Uint16, Float32 → Float32). **Renk:** RGB (8 ve 16 bit, `bitsStored` ile 8 bite ölçekleme), **Planar Configuration 1** (8/16 bit) düzlemleri birleştirilir, YBR_FULL ve **native YBR_FULL_422 / YBR_PARTIAL_420** seyreltilmiş veri açılır (4 bayt → 2 piksel, 6 bayt → 4 piksel), dar aralıklı (partial) YBR için BT.601 dönüşümü. **PALETTE COLOR:** tanımlayıcı artık **ikili (US/SS)** okunur (eski metin yolu da korunur), 8-bit girdiler OW kabının alt baytından alınır, 8/16-bit LUT + `firstMapped` ofseti desteklenir. Çıktı her zaman **32-bit RGBA** (`rgbaSlices`); görüntüleyici tuvali bu tamponu doğrudan yazar, sağ altta fotometri rozeti (**RGB/YBR/palet/MONOCHROME2**) görünür. **Çok kare:** native çok kareli renkli (US Doppler/sine) ve kapsüllenmiş kareler ayrı ayrı çözülür; her kare için RGBA üretilir. 40 birim + **24 uçtan uca DICOM** testi (sentetik dosya üretimi; hasta verisi yok). KALAN: segmentli (segmented) palet LUT ve YBR_RCT/ICT (JPEG 2000 geri dönüşümsüz) özel yol tanımları — bu biçimlerde codec RGB verdiği için pratikte sorun çıkmıyor.",
    action: "Segmentli palet LUT ve nadir YBR türevleri için ayrı test seti; renkli serilerde pencere/renk haritası denetimi.",
  },
  {
    id: "f-series", category: "format", title: "Seri gruplama + anatomik kesit sıralama",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos"],
    ours: "SeriesInstanceUID ile gruplama; ImagePositionPatient/ImageOrientation izdüşümüyle sıralama (yoksa InstanceNumber). **Yeni — kesit aralığı denetimi:** `src/lib/sliceGaps.ts` medyan aralıktan sapmayı, **tahmini eksik kesit** ve **yinelenen kesit** sayısını hesaplar; seri yüklenirken tek uyarı olarak gösterilir (`tests/slice-gaps.test.ts`, 21 assert).",
    action: "Kalan: tespit edilen eksik/yinelenen kesitlerin çalışma listesinde rozet olarak gösterilmesi ve eksik kesitlerin PACS tarafından yeniden istenmesi; sayım hâlâ tahmindir (değişken aralıklı serilerde yanılabilir).",
  },
  {
    id: "f-open", category: "format", title: "Klasör / ZIP / çoklu dosya / sürükle-bırak / uzantısız dosyalar",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "Weasis", "Horos"],
    ours: "Klasör (alt dizinler dahil), ZIP, sürükle-bırak, her uzantı ve başlıksız ham DICOM deneniyor. DICOMDIR okunmuyor (dosyalar zaten taranıyor).",
    action: "Şifreli ZIP ve DICOMDIR tabanlı ağaç görünümü.",
  },
  {
    id: "f-objects", category: "format", title: "DICOM SR, PDF, video, ECG, Presentation State, overlay",
    status: "kismi", priority: "P2", effort: "M",
    market: ["RadiAnt", "Weasis", "MedDream", "OHIF"],
    ours: "**Kısmen:** DICOM SR, encapsulated PDF, video/ECG, GSPS/overlay, DICOM KO ve piksel olmayan nesneler Workstation'da görüntülenir/dışa aktarılır. Eksik: tam Presentation State (GSPS yazma/güncelleme) ve XA/US çok kareli akış yayınlama.",
    action: "Kalan: kapsüllenmiş MPEG-2/MPEG-4 (H.264) video oynatma — video çerçeveleri şu an `isCodecSupported` dışında (görüntü değil, video akışı) ve XA/US çok kareli akış için canlı yayın (C-STORE ile gelen karelerin akış oynatıcısına bağlanması).",
  },

  // ───────── VIEWING ─────────
  {
    id: "v-wl", category: "viewing", title: "WL/WW, hazır ve özel pencere presetleri, negatif mod",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos"],
    ours: "Sürükleyerek WL/WW, BT presetleri, kullanıcı preset kaydı, invert.",
    action: "Kalan: presetlerin kullanıcı hesabında (sunucu) saklanması — şu an tarayıcıda `atik_presets` — ve PET SUV penceresi.",
  },
  {
    id: "v-geo", category: "viewing", title: "Zoom, pan, döndür, çevir (flip), cine",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos"],
    ours: "Zoom, pan, döndür, çevir, cine, tam ekran; kısayollar özelleştirilebilir.",
    action: "Kalan: kısayolların kullanıcı tarafından özelleştirilmesi (cine kare hızı kaydırıcısı var).",
  },
  {
    id: "v-pins", category: "viewing", title: "Kesit zaman çizelgesinde bulgu işaretleri ve kesite atlama",
    status: "var", priority: "P3", effort: "S",
    market: ["Aidoc", "Annalise"],
    ours: "Kesit numaralı bulgu kartları, timeline pinleri, K12 gibi kısayollar — güçlü yanımız.",
    action: "Gerçek model çıktısına bağlanınca değer kazanır (bkz. Yapay Zeka).",
  },
  {
    id: "v-compare", category: "viewing", title: "Seri karşılaştırma + konuma göre otomatik senkronizasyon",
    status: "kismi", priority: "P1", effort: "M",
    market: ["RadiAnt", "OHIF", "Weasis"],
    ours: "İki seri yan yana; senkronizasyon kesit numarasına göre — anatomik konuma göre değil. Farklı kalınlıkta seriler hizalanmaz.",
    action: "Kalan: pan/zoom senkron kilidi (şu an yalnız kesit konumu senkronlanıyor) ve önceki tetkikle otomatik hizalama.",
  },
  {
    id: "v-hanging", category: "viewing", title: "Layout / Hanging Protocol (1×2, 2×2, modaliteye göre otomatik düzen)",
    status: "var", priority: "P1", effort: "M",
    market: ["OHIF", "Weasis", "MedDream", "RadiAnt"],
    ours: "**Var:** `src/lib/hangingProtocols.ts` (modalite/protokol/bölge eşleşmesi) + `CELLS` düzen motoru (1×1/1×2/2×2) + `resolveHangingCellSeries`; raporda önerilen sekans/protokol bilgisi yer alır.",
    action: "Kalan: özel asma protokollerinin tarayıcı yerine kullanıcı hesabında (sunucu) saklanması ve ekipler arası paylaşımı.",
  },
  {
    id: "v-mpr", category: "viewing", title: "MPR (axial / coronal / sagittal) ve oblik MPR",
    status: "kismi", priority: "P1", effort: "L",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos", "3D Slicer"],
    ours: "VolumeView: üçlü koronal/sagital + aksiyel, kalın kesit (Ort./MIP/MinIP), oblik MPR, 3B hacim. Koronal/sagital kalınlık/kesit sayısını serinin ölçeğine ölçekliyor; IPP kaydı yoksa sıralı tarama sanaline dayanır. Kaynak seri yalnızca trilinear örnekleme ile okunur.",
    action: "Ondalıklı (sub-voxel) örnekleme ve dağıtılmış GPU yeniden kesit; kesit konumu etiketi taşımayan eski seriler için otomatik geometri çıkarımı.",
  },
  {
    id: "v-xref", category: "viewing", title: "Cross-reference / localizer çizgileri, 3D imleç",
    status: "var", priority: "P1", effort: "M",
    market: ["RadiAnt", "Weasis", "OHIF", "MedDream"],
    ours: "**Var:** `src/lib/panelRegistry.ts::refLinesFor` → Viewport'ta çapraz referans/localizer çizgileri çizilir (diğer panellerin kesit düzlemi).",
    action: "Düzlem kesişim çizgileri ve eş zamanlı imleç (MPR ile birlikte).",
  },
  {
    id: "v-mip", category: "viewing", title: "MIP / MinIP / Avg kalın kesit (slab)",
    status: "var", priority: "P1", effort: "M",
    market: ["RadiAnt", "Weasis", "Horos", "OHIF"],
    ours: "VolumeView'da kalın kesit kaydırıcısı (mm) + Ort./MIP/MinIP; aksiyel ve yeniden kesit düzlemlerinde uygulanır. Oblik MPR'de de slab + mod vardır.",
    action: "—",
  },
  {
    id: "v-vr", category: "viewing", title: "3D hacim görüntüleme (VR), STL dışa aktarma",
    status: "yok", priority: "P2", effort: "L",
    market: ["RadiAnt", "Horos", "Weasis", "3D Slicer"],
    ours: "Yok.",
    action: "WebGL2 ray-casting VR + hazır transfer fonksiyonları.",
  },
  {
    id: "v-fusion", category: "viewing", title: "Füzyon (PET-CT, MR/MR) ve TIC eğrileri",
    status: "kismi", priority: "P3", effort: "L",
    market: ["RadiAnt", "Horos", "MedDream", "Weasis"],
    ours: "Füzyon: ikinci seri hasta koordinatlarına göre ana serinin üzerine bindirilir (yeniden örnekleme, renk haritası, opaklık, eşik); PET sıcak noktası BT'deki tümörle hizası doğrulandı. **Katı hizalama:** `src/lib/fusionRigid.ts` — kesit içi öteleme + dönme + izotropik ölçek, kabadan inceye NCC (indirgeme 4→2→1), `applyRigid` bilineer ters dönüşüm (dışarısı NaN → şeffaf); panelde X/Y/dönme/ölçek kaydırıcıları, «Otomatik hizala (NCC)» ve sıfırla; sonuç katmana ve görüntü notuna yansır. **TIC (yeni):** `src/lib/ticRoi.ts` + 📈 TIC paneli — hekimin çizdiği ROI (dikdörtgen/elips/poligon) aynı Frame of Reference'taki dinamik serilerin **konumla eşlenen** kesitlerinde yeniden uygulanır, zaman ekseni Series/Acquisition Time farkıdır (`SeriesData.seriesTime`), eğri wash-out ≥%15 / plato / progresif (zirve son fazda) olarak sınıflanır; faz tablosu, CSV ve özet satırı üretilir. Zaman etiketi yoksa eksen **faz sırası** olur ve sınıflama yapılmaz (dürüst sınır). **Elastik (deforme) kayıt (yeni):** `src/lib/fusionDeform.ts` — düğüm ızgaralı (7×7) yer değiştirme alanı, kabadan inceye blok eşleme (yerel NCC, indirgeme 4→2→1) + Gauss düzleştirmesi (elastik düzenlileştirme) ve toplam kayma sınırı (12 px); her tarama turu kademe skoruyla kabul edilir, **kazanç yoksa alan sıfırlanır** (bindirme asla kötüleşmez). Alan katı dönüşümden **sonra** uygulanır, `buildFusionLayer` önbellek anahtarına girer. Panelde «Elastik hizala» / «Sıfırla», NCC öncesi→sonrası ve ortalama/en çok kayma gösterilir; katı parametre değişince alan sıfırlanır (bayat alan uygulanmaz). Dokulu sentetik fantomda (96×96, ±3 px sinüzoidal gerçek alan) NCC 0,54→0,91 ve düğüm başına alan hatası 2,87→1,40 px. **Çok modaliteli hizalama (yeni):** `src/lib/fusionMi.ts` — normalize karşılıklı bilgi (NMI = 2·I/(H_A+H_B)), 32 binli ortak histogram, kabadan inceye öteleme araması; metrik modaliteye göre otomatik seçilir (`metricFor`: aynı modalite → NCC, farklı → MI). Monoton olmayan yoğunluk ilişkisinde (V biçimli eşleme) NCC 0,00 iken MI 0,80 ve 4/3 px kayma geri kazanıldı; eşik altı NMI'de sonuç uygulanmaz. **Kesitler arası (z) kayma (yeni):** `src/lib/fusionZ.ts` + `resampleOnto(..., zMm)` — hasta konumuna göre kesit eşleme, ortalama NCC ile kabadan inceye z araması ve parabolik incelme; 6 mm'lik gerçek kayma 6,0 mm (2,0 kesit) bulundu, füzyon örtüşmesi NCC 0,54→1,00. Kayma 0'a göre kazanç sağlamıyorsa uygulanmaz. 36 katı + 50 elastik + 23 MI + 22 z + 37 TIC testi. KALAN: 3B hacim kaydı (z kayması öteleme; eğim/eğrilik ve kesit aralığı değişimi yok), simetrik (inverse-consistent) kayıt, B-spline süreklilik garantisi, MI ile dönme/ölçek, MR/MR otomatik dizi hizalaması.",
    action: "3B hacim kaydı (eğim/eğrilik dahil), MI ile dönme/ölçek, simetrik deformasyon; dinamik serilerde otomatik faz sıralama ve arteriyel/venöz eşleme.",
  },
  {
    id: "v-perf", category: "viewing", title: "Büyük çalışmalarda performans (GPU, kademeli yükleme, Web Worker)",
    status: "kismi", priority: "P1", effort: "M",
    market: ["RadiAnt", "OHIF", "Weasis"],
    ours: "CPU canvas ile LUT; her kesit Float32 olarak bellekte (512×512 → ~1 MB/kesit). 1000+ kesitlik BT'de bellek ve akıcılık sorunu beklenir.",
    action: "Int16 saklama, WebGL doku, OffscreenCanvas/worker ve kademeli kesit yükleme.",
  },
  {
    id: "v-multimon", category: "viewing", title: "Tam ekran, çoklu monitör, dokunmatik jestler",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "MedDream"],
    ours: "Üç parça da çalışır. **Tam ekran:** her panelin kendi ⛶ düğmesi (Fullscreen API, o paneli tam ekrana alır; Esc çıkar) + çalışma alanı tam ekranı. **Dokunmatik jestler** (`src/lib/gestures.ts`, `tests/gestures.test.ts`): iki parmak kıstırma → zoom, iki parmak kaydırma → pan, tek parmak → kaydırma; tek karede ×2,5 sıçrama sınırı, zoom 0,15–12 aralığı, parmaklar üst üste geldiğinde bölme yapılmaz. Fare/kalem aracı değişmez. **İkinci ekran / çoklu monitör** (`src/lib/mirror.ts` + `/ayna`): ana penceredeki seri künyesi ve **yalnız görüntülenen kesit** BroadcastChannel ile ikinci pencereye canlı yayınlanır (WL/WW, kesit, zoom/pan/çevirme); pencereyi başka bir monitöre sürükleyin. Tüm seriyi kopyalamak yerine kesit kesit aktarım var (alıcıda son 12 kesit, kesit başına 16 MP sınırı), bozuk/eksik mesaj yok sayılır, alıcı salt izlemedir (kazara ölçüm/annotasyon eklenmez), oturum kapısı ana sayfayla aynı ve veri sunucuya gitmez. Gerçek iki pencere arası taşıma testte `BroadcastChannel` ile doğrulanır. Sınır: monitörler arası **otomatik** yerleşim (Window Management API izni) kullanılmaz — pencereyi kullanıcı taşır; eski tarayıcılarda yayın yoksa CPU görüntüleyici normal çalışır.",
    action: "Tarayıcı izni verilirse Window Management API ile ikinci pencereyi otomatik olarak diğer ekrana taşıma (isteğe bağlı iyileştirme).",
  },

  // ───────── MEASURE ─────────
  {
    id: "m-basic", category: "measure", title: "Uzunluk, açı, dikdörtgen ROI (ort/SS/min/max), ok notu",
    status: "var", priority: "P3", effort: "S",
    market: ["RadiAnt", "OHIF", "Weasis", "Horos"],
    ours: "Hepsi var; ROI istatistikleri AI isteğine ROI odağı olarak gönderiliyor.",
    action: "ROI ve açı için sürüklenebilir düzenleme.",
  },
  {
    id: "m-shapes", category: "measure", title: "Elips / çokgen ROI, Cobb açısı, deviation, hacim hesabı",
    status: "var", priority: "P1", effort: "M",
    market: ["RadiAnt", "Weasis", "OHIF"],
    ours: "**Var:** `src/lib/geometry.ts` — elips/çokgen ROI (`ellipseTest`, `pointInPolygon`), açı/deviation (`perpendicular`), uzunluk, çevre ve `regionStats` (ortalama/SS); anotasyon araçları çizim + kalıcılıkla birlikte.",
    action: "Elips ve çokgen araçları (alan, çevre, ort/min/max), elipsoid hacim.",
  },
  {
    id: "m-calib", category: "measure", title: "Manuel kalibrasyon ve SUV (PET)",
    status: "kismi", priority: "P2", effort: "S",
    market: ["RadiAnt", "Weasis"],
    ours: "Pixel Spacing'e göre mm; HU gösteriliyor. Kalibrasyon ve SUV yok.",
    action: "Kalibrasyon çizgisi ve SUVbw dönüşümü.",
  },
  {
    id: "m-persist", category: "measure", title: "Ölçüm/anotasyon kalıcılığı ve rapora otomatik aktarım",
    status: "var", priority: "P1", effort: "S",
    market: ["Weasis", "OHIF", "MedDream"],
    ours: "**Var:** Ölçüm/anotasyon ve anahtar kesitler `study_state` tablosuna (`annotations`, `key_images`) şifreli JSON olarak yazılır ve `/api/state` ile geri okunur; sayfa yenilenince kaybolmaz.",
    action: "Kalan: anotasyonların PR belgesinden geri yüklenmesi (şu an dışa aktarım var, içe aktarım yok) ve grafik katmanına serbest çizim (freehand) eklenmesi.",
  },
  {
    id: "m-key", category: "measure", title: "Anahtar kesit (key image) seçimi, rapora çoklu görsel",
    status: "var", priority: "P1", effort: "S",
    market: ["Weasis", "MedDream"],
    ours: "**Var:** Key image seçimi (manuel yıldız + `suggestKeyImages` bbox'lı bulguları otomatik önerir), rapora çoklu görsel aktarım ve DICOM Key Object Selection (KO) üretimi (`dicomSr.ts::buildKeyObjectSelection`).",
    action: "Kesit yıldızlama, rapora 2–4 görsel ızgarası, DICOM KO dışa aktarma.",
  },
  {
    id: "m-seg", category: "measure", title: "Segmentasyon maskesi ve hacim ölçümü",
    status: "kismi", priority: "P2", effort: "M",
    market: ["3D Slicer", "OHIF"],
    ours: "**Kısmen:** Kesit maskesi örtüsü (`OverlayData.masks`, opaklık kaydırıcısı) çiziliyor; CXR için Grad-CAM ısı örtüsü var. Eksik: etiketli segmentasyon maskesi üretimi ve kafes/küp hacim ölçümü (sıcaklık/sıcaklık haritası dışı).",
    action: "Fırça/eşik/SAM tabanlı maske, hacim (mL) hesabı.",
  },

  // ───────── AI ─────────
  {
    id: "a-model", category: "ai", title: "Gerçek klinik AI modeli çıkarımı (ONNX / MONAI / TorchXRayVision)",
    status: "var", priority: "P0", effort: "L",
    market: ["Aidoc", "Viz.ai", "Lunit", "Annalise", "Gleamer"],
    ours: "**Var:** Üç model motoru yerel ai-worker'da çalışır: BT toraks nodül (MONAI lung_nodule_ct_detection), BT beyin İCH (ianpan/ct-head-hemorrhage-detection) ve **CXR sınıflandırma** (Medical_X DenseNet121, Apache-2.0, 14 sınıf). Hasta verisi dış ağa çıkmaz; worker kapalıysa kural tabanlı motor devam eder.",
    action: "İlk gerçek modül: akciğer grafisi sınıflandırma (ONNX Runtime Web veya sunucu); sonra BT beyin kanama.",
  },
  {
    id: "a-loc", category: "ai", title: "Lezyon yerelleştirme: kutu + kesit aralığı + boyut/dansite",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Aidoc", "Lunit", "Annalise", "Gleamer"],
    ours: "Arayüz ve veri modeli hazır (kesit no, aralık, z, dansite, boyut); fakat yalnızca simüle örneklerde dolu.",
    action: "Model çıktısını (bbox/maske) aynı Finding yapısına eşle.",
  },
  {
    id: "a-heat", category: "ai", title: "Isı haritası / segmentasyon örtüsü (Grad-CAM, U-Net)",
    status: "var", priority: "P1", effort: "M",
    market: ["Lunit", "Annalise", "Gleamer"],
    ours: "**Var:** Bu sürümde eklendi — Viewport'ta CXR Grad-CAM örtü katmanı (mavi→kırmızı renklendirme, alfa eşikli, opaklık kaydırıcısı); maske örtüsü mevcut motorlar için de çiziliyor.",
    action: "Kalan: 3B nodül modeli ve diğer modaliteler için gerçek Grad-CAM ısı haritası (örtü şu an CXR sınıflandırma modelinden geliyor).",
  },
  {
    id: "a-triage", category: "ai", title: "Triyaj skoru + çalışma listesinin yeniden önceliklendirilmesi",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Aidoc", "Viz.ai", "Annalise"],
    ours: "Triyaj seviyesi/skoru hesaplanıyor; ancak çalışma listesi olmadığı için sıralamaya yansımıyor.",
    action: "Kalan: bağımsız bulgu kararının ve nedenlerinin saklanması; triyaj eşiklerinin kurum politikasıyla belirlenmesi (şu an araştırma/demo).",
  },
  {
    id: "a-notify", category: "ai", title: "Kritik bulgu bildirimi (mobil push, e-posta, SMS, çağrı)",
    status: "var", priority: "P1", effort: "M",
    market: ["Viz.ai", "Aidoc"],
    ours: "**Var:** `/api/notifications` — kritik bulgu/takip görevi bildirimi, onay (ack) zinciri (`ackBy`/`ackAt`), CEF + denetim kaydı ve kapanış döngüsü (`closeLoop`) ile birleşik.",
    action: "Bildirim servisi + alındı/okundu kaydı (denetim izine bağlı).",
  },
  {
    id: "a-prior", category: "ai", title: "Önceki tetkikle karşılaştırma / interval değişim",
    status: "kismi", priority: "P1", effort: "L",
    market: ["Aidoc", "Rad AI"],
    ours: "**Kısmen:** Aynı hastanın önceki tetkikleri ve raporları listelenir (`patientReports`, `priorStudies`) ve `openPrior` ile karşılaştırmalı açılır; eksik: otomatik interval-değişim özeti/ödeme grafiği (lesionTracking testi var ama UI bağlantısı sınırlı).",
    action: "Hasta bazlı çalışma geçmişi, kayıt ve değişim özeti.",
  },
  {
    id: "a-track", category: "ai", title: "Nodül/lezyon takibi (Lung-RADS, RECIST, boyut değişimi)",
    status: "var", priority: "P2", effort: "L",
    market: ["Lunit"],
    ours: "**Var:** `src/lib/lesionTracking.ts` — lezyon takibi (RECIST 1.1, Lung-RADS boyut eşikleri, boyut değişimi, follow-up öneri günü) ve `tests/lesion-tracking.test.ts`.",
    action: "Lezyon kimliği, zaman serisi grafiği, kılavuz tabanlı öneri.",
  },
  {
    id: "a-quant", category: "ai", title: "Nicel biyobelirteçler (hacim, kalsiyum skoru, kemik yoğunluğu)",
    status: "var", priority: "P2", effort: "M",
    market: ["Aidoc", "3D Slicer"],
    ours: "Agatston (damar bazlı HU ağırlıkları, S0–S4), oportünist kemik HU kategorisi, PA kardiyotorasik oran ve nodül hacmi; hekim ölçü değerlerini panelden girer.",
    action: "Ölçümlerin anotasyondan otomatik aktarımı ve zaman serisi grafiği.",
  },
  {
    id: "a-feedback", category: "ai", title: "Hekim geri bildirim döngüsü ve AI performans panosu",
    status: "kismi", priority: "P1", effort: "S",
    market: ["Aidoc", "Annalise"],
    ours: "Bulgu bazlı onay/red/düzenleme kaydediliyor; FP/FN istatistiği ve model değerlendirmesi yok.",
    action: "Onay/red verisinden duyarlılık/özgüllük panosu; yanlış pozitif listesi.",
  },
  {
    id: "a-card", category: "ai", title: "Model kartı: sürüm, endikasyon, duyarlılık/özgüllük, doğrulama verisi",
    status: "var", priority: "P0", effort: "S",
    market: ["Aidoc", "Viz.ai", "Lunit", "Annalise", "Gleamer"],
    ours: "**Var:** `src/lib/modelCards.ts` (DEEP_MODEL_CARD / DEEP_BRAIN_MODEL_CARD / DEEP_CXR_MODEL_CARD / CV / DEMO / NO_MODEL) — isim, sürüm, amaç, yöntem, sınırlılıklar, doğrulama; rapora model adı+sürüm ve (panelde) kart ile aktarılır.",
    action: "Kalan: duyarlılık/özgüllük ve doğrulama verisinin kurum verisiyle doldurulması (kartlarda şu an 'bilinmiyor' yazıyor).",
  },
  {
    id: "a-vlm", category: "ai", title: "Çok kipli model: görüntü + klinik not (VLM/LLM)",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Annalise", "Rad AI"],
    ours: "Klinik not alanı var; yalnızca hasta özeti metnine ekleniyor, çıkarıma girmiyor.",
    action: "Klinik soruyu modele bağlama; sorumlu kullanım için hekim onayı zorunlu kalmalı.",
  },
  {
    id: "a-uncert", category: "ai", title: "Belirsizlik göstergesi ve kalibre güven skoru",
    status: "kismi", priority: "P1", effort: "S",
    market: ["Lunit", "Annalise"],
    ours: "Yüzde güven gösteriliyor; kalibre edilmemiş ve belirsizlik/'emin değilim' durumu yok.",
    action: "Kalibrasyon eğrisi, eşik ayarı, düşük güvende 'hekim incelesin' etiketi.",
  },

  // ───────── REPORT ─────────
  {
    id: "r-struct", category: "report", title: "Yapısal rapor, A4 çıktı, filigran, anahtar kesit görseli",
    status: "var", priority: "P3", effort: "S",
    market: ["PowerScribe", "Rad AI"],
    ours: "Teknik / Bulgular / Sonuç / Öneri; onaysız taslak filigranı; kanıtsal kesitlerden en fazla 4 anahtar kesit; ölçümler raporda «Ölçümler» bölümü olarak basılır (düz metin satırları).",
    action: "Kalan: ölçüm bölümünün sütunlu tablo düzeniyle basılması ve filigran/anahtar kesit düzeninin kuruma özelleştirilmesi.",
  },
  {
    id: "r-review", category: "report", title: "Bulgu bazlı hekim doğrulaması (zorunlu gözden geçirme)",
    status: "var", priority: "P1", effort: "S",
    market: ["Aidoc", "Gleamer"],
    ours: "AI bulguları 'Onay Bekliyor' gelir; bekleyen bulgu varken rapor onaylanamaz. **Yeni — gerekçe zorunlu:** reddedilen/düzenlenen her bulgu için hekim gerekçe yazar (`src/lib/findingReview.ts`: normalleştirme, 200 karakter sınırı, eksik gerekçe listesi); gerekçe eksikse onay hem arayüzde hem `/api/reports` tarafında reddedilir. Gerekçeler raporda «Hekim gözden geçirme gerekçeleri» olarak basılır, `findings_reason` sütununda ve sürüm anlık görüntüsünde saklanır (`tests/finding-review.test.ts`, 21 assert). KALAN: gerekçeler serbest metindir — sınıflandırma/NLP ve gerekçe bazlı AI performans raporu yok.",
    action: "Kalan: gerekçe metinlerinin sınıflandırılması (NLP) ve gerekçeden model iyileştirme/yeniden eğitim döngüsüne geri besleme (şu an pano yalnız listeler).",
  },
  {
    id: "r-template", category: "report", title: "Şablon kütüphanesi (modalite/bölge/endikasyon), makro ve seçim listeleri",
    status: "var", priority: "P1", effort: "M",
    market: ["PowerScribe", "Rad AI", "RadPal"],
    ours: "42 hazır şablon (CT 11 / MR 17 / US 6 / MG 3 / NM-PET-CT-CR-DX); her şablonda endikasyon + protokol; /api/templates GET/POST/PATCH/DELETE; rapor ekranında modaliteye göre aranabilir seçici.",
    action: "RSNA RadReport/Radslex ile eşleştirme; kullanıcı başına şablon favorileri.",
  },
  {
    id: "r-structured-score", category: "report", title: "Yapılandırılmış skorlama (Lung-RADS, TI-RADS, BI-RADS, PI-RADS)",
    status: "var", priority: "P1", effort: "M",
    market: ["RadPal", "PowerScribe", "Aidoc"],
    ours: "Skor motoru + rapor paneli: Lung-RADS 1.1, ACR TI-RADS, BI-RADS 0–6, PI-RADS v2.1, ACR meme yoğunluğu; skor rapora 'öneri' satırı olarak eklenir ve takip/biyopsi görevine dönüşür.",
    action: "Bulgu metninden özellik çıkarımı (NLP); hekim onaylı skor revizyon geçmişi.",
  },
  {
    id: "r-dictate", category: "report", title: "Sesle dikte (Türkçe) ve sesli komutlar",
    status: "kismi", priority: "P1", effort: "M",
    market: ["PowerScribe", "Rad AI", "RadPal"],
    ours: "Rapor alanlarında mikrofon (Web Speech API, tr-TR). src/lib/dictate.ts: sayı sözcükleri (yirmi beş → 25), noktalama komutları (virgül, iki nokta, yeni satır/paragraf, temizle), ölçü birimleri (milimetre → mm) ve tıbbi sözlük düzeltmeleri (akciger → akciğer); aynı katman /api/reports/normalize ile sunucuda da çalışır. Tanınmayan terimler ve yoğun ters çevrimler dışında tam değildir; cihaz/tarayıcı motoru harici bağımlılıktır.",
    action: "Sunucu tarafı tam konuşma tanıma motoru (vb. faster-whisper) ve kurum sözlüğü; Türkçe tıbbi modül.",
  },
  {
    id: "r-genai", category: "report", title: "Üretken yapay zeka ile izlenim/rapor taslağı ve hekim üslubuna uyum",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Rad AI", "RadPal", "Annalise"],
    ours: "Kural tabanlı metin üretimi; LLM yok, hekim üslubu öğrenilmiyor.",
    action: "LLM ile bulgu→izlenim; çıktının yalnızca doğrulanmış bulgulara dayanmasını zorunlu kıl.",
  },
  {
    id: "r-version", category: "report", title: "Rapor sürümleme, değişiklik geçmişi, addendum",
    status: "kismi", priority: "P0", effort: "M",
    market: ["PowerScribe", "Rad AI"],
    ours: "**Kısmen:** Addendum eklenir (`POST /api/reports/[id]/addenda`) ve denetimde kaydedilir. Eksik: revizyon numarası/geçmiş listesi ve 'hangi satır neyle değişti' diff'i.",
    action: "Kalan: sürümler arası fark (diff) görünümü ve eski sürüme dönme; addendumun imza kaydıyla ilişkilendirilmesi.",
  },
  {
    id: "r-esign", category: "report", title: "Kimlik doğrulamalı e-imza (NES / mobil imza / e-Devlet)",
    status: "kismi", priority: "P0", effort: "L",
    market: ["PowerScribe"],
    ours: "**Kısmen:** Rapor onayı PIN ile korunur ve hekim adı/sicil/sicilNo yazdırılır; PIN doğrulaması simülasyon (NES/e-Devlet mobil imza entegrasyonu yok).",
    action: "Kullanıcı kimliğinden gelen hekim bilgisi + gerçek imza sağlayıcı entegrasyonu.",
  },
  {
    id: "r-export", category: "report", title: "Standart çıktı: DICOM SR / PDF, HL7 FHIR DiagnosticReport, RSNA CDE",
    status: "var", priority: "P1", effort: "M",
    market: ["PowerScribe", "Weasis"],
    ours: "**Var:** `src/lib/fhir.ts` (FHIR DiagnosticReport), `src/lib/dicomSr.ts` (DICOM SR + KO), `src/lib/exportMedia.ts` (PNG/JPEG/AH-SR/ZIP), tarayıcı PDF yazdırma, `src/lib/hl7.ts` (v2 mesajları) ve PACS'e STOW-RS gönderme.",
    action: "FHIR DiagnosticReport + ImagingStudy dışa aktarma, SR üretimi.",
  },
  {
    id: "r-patient", category: "report", title: "Hasta dostu özet",
    status: "var", priority: "P3", effort: "S",
    market: ["Rad AI"],
    ours: "Hasta mektubu (`src/lib/patientLetter.ts` + rapor ekranındaki «Hasta mektubu»): onaylı rapordan **TR/EN/DE** dillerinde ve **sade/standart** okuma düzeyinde özet; sade düzeyde tıbbi terimler günlük dile çevrilir. Çıktı tanı koymaz, hekim onayı gerektirir.",
    action: "Kalan: kuruma özel terim sözlüğü ve okunabilirlik ölçümü (cümle uzunluğu/hece) ile düzey doğrulaması.",
  },
  {
    id: "r-link", category: "report", title: "Rapor–görüntü bağlama (cümleye tıkla → kesite git)",
    status: "kismi", priority: "P2", effort: "S",
    market: ["PowerScribe", "OHIF"],
    ours: "Bulgu kartından kesite gidiliyor; rapor metni içindeki cümleler bağlı değil.",
    action: "Rapor cümlelerine bulgu kimliği iliştir; tıklayınca kesit ve kutu vurgulansın.",
  },

  // ───────── WORKFLOW ─────────
  {
    id: "w-pacs", category: "workflow", title: "PACS / DICOMweb bağlantısı (QIDO-RS, WADO-RS, STOW-RS, C-FIND/C-MOVE)",
    status: "kismi", priority: "P1", effort: "L",
    market: ["OHIF", "Weasis", "RadiAnt", "Horos", "Aidoc"],
    ours: "QIDO/WADO istemcisi + yapılandırılabilir bağlantı profilleri; 'bağlantıyı test et' raporu. STOW/QIDO/WADO uçtan uca doğrulaması CI'da gerçek Orthanc üzerinde çalışır (tests/pacs.orthanc.e2e.ts).",
    action: "STOW-RS'e rapor/KO/SR gönderme diyaloğu; ardından C-FIND/C-MOVE.",
  },
  {
    id: "w-worklist", category: "workflow", title: "Çalışma listesi: hasta/tetkik, durum, atama, öncelik",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Aidoc", "OHIF", "MedDream"],
    ours: "Yalnızca kayıtlı raporlar listeleniyor (Geçmiş). Okunmayı bekleyen tetkik kuyruğu yok.",
    action: "Kalan: kullanıcı bazlı filtre/kolon tercihlerinin sunucuda saklanması ve liste yenilemenin HBYS/PACS olaylarıyla tetiklenmesi.",
  },
  {
    id: "w-auth", category: "workflow", title: "Kullanıcı girişi ve roller (Yönetici / Radyolog / Teknisyen)",
    status: "var", priority: "P0", effort: "M",
    market: ["Aidoc", "Viz.ai", "PowerScribe", "MedDream"],
    ours: "**Var:** `src/lib/server/auth.ts` + `accounts.ts` — hesap modu (AUTH_MODE=hesap), kullanıcı/rol tabloları, scrypt parola, MFA/TOTP (`/api/profile/totp`), oturum çerezi, isteğe bağlı erişim kapısı (`ACCESS_TOKEN`) ve roller (Yönetici/Radyolog/Teknisyen).",
    action: "Oturum yönetimi, rol tabanlı yetki, hekim profili (ad, unvan, sicil).",
  },
  {
    id: "w-audit", category: "workflow", title: "Denetim kaydı (audit trail): kim, ne zaman, hangi tetkik/rapor",
    status: "var", priority: "P0", effort: "M",
    market: ["Aidoc", "Viz.ai", "PowerScribe"],
    ours: "**Var:** `src/lib/server/audit.ts` — kim/ne zaman/hangi tetkik-rapor; zincir bütünlüğü (`verifyChain`), CEF satırı (`cefLine`) ve CSV/XML dışa aktarım (`/api/audit/export`).",
    action: "Değiştirilemez olay tablosu: açma, analiz, onay, yazdırma, dışa aktarma, bildirim.",
  },
  {
    id: "w-his", category: "workflow", title: "HIS/RIS entegrasyonu (HL7 v2, Modality Worklist, FHIR)",
    status: "kismi", priority: "P2", effort: "L",
    market: ["Aidoc", "PowerScribe", "MedDream"],
    ours: "**Kısmen:** HL7 v2 istemi (`scripts/hl7-mllp-server.ts` MLLP dinler, ACK döner, `/api/his/orders`'a yazar) + worklist görüntüleme modalı + FHIR rapor çıktısı. Eksik: Modality Worklist Sünnetçisi (MWL C-FIND) istemcisi ve RIS'ten otomatik sipariş çekme.",
    action: "HL7/FHIR alıcı; hasta ve istem bilgisini otomatik doldur.",
  },
  {
    id: "w-storage", category: "workflow", title: "Kalıcı görüntü depolama ve çok kullanıcılı erişim",
    status: "var", priority: "P1", effort: "L",
    market: ["OHIF", "Weasis", "Horos"],
    ours: "**Var:** `/api/storage/upload|file|study` + `stored_files`/`studies` tabloları — DICOM yüklenir, sha256 ile dedupe, kalıcı indirme; rapor ve keyImage da veritabanında.",
    action: "Orthanc veya nesne depolama; yetkilendirilmiş akış (stream).",
  },
  {
    id: "w-deid", category: "workflow", title: "Anonimleştirme (DICOM de-identification) ve etiket düzenleme",
    status: "var", priority: "P1", effort: "S",
    market: ["RadiAnt", "Weasis"],
    ours: "**Var:** `src/lib/dicomWrite.ts::zipAnonymized` — anonimleştirilmiş DICOM ZIP'i (ad/kimlik/tarih/kurum taşınmaz) ve ExportMenu'de etiket/alan düzenleme.",
    action: "Kalan: profil tabanlı etiket temizleme (kuruma özel etiket listesi) ve etiket düzenleyici.",
  },
  {
    id: "w-export", category: "workflow", title: "Dışa aktarma: JPEG/PNG, video, DICOM, CD/paylaşım bağlantısı",
    status: "kismi", priority: "P2", effort: "S",
    market: ["RadiAnt", "Weasis", "Horos"],
    ours: "Rapor PDF/yazdır var; görüntü, video veya DICOM dışa aktarma yok.",
    action: "Kesit PNG, cine MP4/GIF, anotasyonlu görüntü; süreli paylaşım bağlantısı.",
  },

  // ───────── TRUST ─────────
  {
    id: "t-disclaimer", category: "trust", title: "Her ekranda net 'demo / klinik karar için kullanılamaz' uyarısı",
    status: "var", priority: "P0", effort: "S",
    market: ["Aidoc", "Viz.ai", "Lunit"],
    ours: "Üst çubukta, durum çubuğunda ve AI sonuç panelinde uyarı; rapor çıktısında da var.",
    action: "Amaçlanan kullanım (intended use) metni ve sürüm bilgisi.",
  },
  {
    id: "t-mdr", category: "trust", title: "Tıbbi cihaz yazılımı uyumu (CE-MDR/TİTCK, FDA 510(k), ISO 13485, IEC 62304)",
    status: "kismi", priority: "P0", effort: "L",
    market: ["Aidoc", "Viz.ai", "Lunit", "Annalise", "Gleamer"],
    ours: "**Kısmen (süreç/ belge tarafı):** `docs/RISK_YONETIMI.md` (ISO 14971 risk tablosu: genel + CXR/BT toraks/ICH), `docs/KLINIK_DOGRULAMA_PLANI.md`, Yönetim → Uyum takip listesi ve model kartları (amaç/sınırlılıklar) hazır. **Kodla kapatılamaz kısım:** sınıflandırma/hukuki danışmanlık, kalite yönetim sistemi belgelendirmesi, teknik dosya ve ulusal kayıt süreci kurumda yürütülmelidir.",
    action: "Kurum için: amaçlanan kullanım onayı, ISO 13485 süreç belgeleri, teknik dosya ve TİTCK/AB MDR başvuru hazırlığı; bu depodaki belgeler başlangıç taslağıdır.",
  },
  {
    id: "t-privacy", category: "trust", title: "KVKK/HIPAA: şifreleme, erişim kontrolü, saklama politikası",
    status: "kismi", priority: "P0", effort: "M",
    market: ["Aidoc", "Viz.ai", "RadPal"],
    ours: "**Kısmen:** Veritabanında anahtar alanlar AES-256-GCM ile şifrelenir (`src/lib/server/crypto.ts`, DATA_ENCRYPTION_KEY veya yerel 0600 anahtar dosyası), erişim kapısı/oturum ve denetim zinciri var. Eksik: saklama süresi/silme politikası, satır düzeyinde rol matrisi (tüm raporları her yetkili görür) ve TLS zorunluluğu.",
    action: "TLS, alan düzeyi şifreleme, rol tabanlı erişim, silme/saklama süreleri, açık rıza ve aydınlatma metni.",
  },
  {
    id: "t-validation", category: "trust", title: "Klinik doğrulama, gölge mod (shadow mode) ve performans/yanlılık izleme",
    status: "kismi", priority: "P1", effort: "L",
    market: ["Aidoc", "Viz.ai", "Lunit"],
    ours: "**Kısmen:** Üç model için doğrulama kaydı var (`Dogrulama_Raporu.md` sentetik fantom, `Klinik_Dogrulama_ICH.md` 100 gerçek vaka, `Klinik_Dogrulama_LUNA16.md`); performans izleme `/yonetim → AI performans` (PPV, kalibrasyon bölmeleri, ECE — `modelOps.ts`) ve **gölge mod** uygulanmıştır: `NEXT_PUBLIC_AI_SHADOW_MODE=true` ile AI adayları rapora girmez, `/api/shadow` kaydı tutulur, özet `/api/shadow/summary`'den izlenir. Açıkta: CXR modelinin kendi cohort doğrulaması, demografik/alt grup izlemesi ve sürüm bazlı karşılaştırma.",
    action: "CXR için kurum verisiyle doğrulama (adımlar: docs/KLINIK_DOGRULAMA_PLANI.md §1) ve sürüm bazlı performans eşik izleme.",
  },
  {
    id: "t-automation", category: "trust", title: "Otomasyon yanlılığına karşı tasarım (AI bulgusu ön onaylı gösterilmez)",
    status: "var", priority: "P1", effort: "S",
    market: ["Gleamer", "Aidoc"],
    ours: "Bulgular 'Onay Bekliyor' gelir; hekim her bulguyu onaylar/reddeder; simülasyon ve 'model yok' durumu açıkça etiketlenir.",
    action: "Hekim kararlarının AI önerisinden ayrı kaydı ve uyuşmazlık raporu.",
  },

  // ───────── 2026 PIYASA TARAMASI EKLEMELERİ ─────────
  // Detaylı analiz ve 90 günlük plan için docs/PIYASA_EKSILERI_2026.md dosyasına bakın.
  {
    id: "a-cxr", category: "ai", title: "Akciğer grafisi/filitrio AI + ısı haritası (pnömotoraks, effüzyon, konsolidasyon, TB)",
    status: "var", priority: "P1", effort: "M",
    market: ["Lunit", "Aidoc", "Gleamer"],
    ours: "**Tamamlandı:** CTR hesabı + **CXR teknik kalite modülü** (`src/lib/cxr.ts`: projeksiyon PA/AP/yandan, kosta sayısı, rotasyon, penetrasyon) + **yerel derin CXR sınıflandırması** (`Medical_X` DenseNet121, NIH ChestX-ray14, Apache-2.0; `ai-worker/models/cxr_densenet121_medx_320.onnx`, 14 sınıf, sigmoid + kaynak eşik tablosu). Çıkarım ONNX Runtime ile istemciden gelen gri tek kare üzerinde çalışır (`cxr_lib.py`); pozitif sınıflar için **Grad-CAM ısı haritası** (norm5 katmanı, gerçek gradyan referansıyla r=0,995 doğrulandı) Viewport'a örtü olarak çizilir. Model lokalizasyon KUTUSU vermez; raporda \"aday\" olarak işaretlenir, klinik doğrulama yoktur ve skorlar kalibre olasılık değildir. Kaynak lisansı/bildirim: `ai-worker/models/LICENSE.Medical_X.txt` + `NOTICE.md`; türetim: `ai-worker/tools/export_cxr_onnx.py`. Hasta verisi istemciden sunucuya gider ama dış ağa ÇIKMAZ (yalnızca yerel ai-worker 127.0.0.1:8787).",
    action: "Opsiyonel sonraki adım: pnömotoraks/solitüd segmentasyonu (bbox'lı model) ve kendi cohort'unuzla in-vitro doğrulama; mevcut model yalnızca aday olasılık + ısı haritası üretir.",
  },
  {
    id: "a-stroke", category: "ai", title: "İnme paketi: ASPECTS skoru + CTP perfüzyon (CBF/CBV/MTT/Tmax)",
    status: "kismi", priority: "P1", effort: "L",
    market: ["Viz.ai", "Aidoc"],
    ours: "**Bu sürümde kısmen uygulandı:** `src/lib/stroke.ts` — ASPECTS 10 bölge skoru (rapor panelinde işaretleme) ve basitleştirilmiş CTP özeti. **Eklenen (a-stroke):** `src/lib/ctp.ts` — cSVD (kesilmiş SVD) dekonvolüsyonu ile rölatif CBF/CBV/MTT + Tmax, otomatik AIF seçimi (genlik/zirve zamanı/genişlik skoru), çoklu bölge özeti (core: rCBF<%30, penumbra: Tmax≥6 sn) ve mismatch oranı; panelden yapıştırılan eğrilerle çalışır, sentetik konvolüsyon verisiyle doğrulandı (MTT ~4 sn geri kazanımı). KALAN: mutlak mL/100 g/dk için dansite (ρ) kalibrasyonu, hareket düzeltmesi, otomatik bölge (ROI) segmentasyonu.",
    action: "Hareket düzeltmesi + otomatik ROI/kontur segmentasyonu; 4D seriden eğri çıkarma; mutlak akım kalibrasyonu.",
  },
  {
    id: "a-msk", category: "ai", title: "MSK/X-ışını kırık ve landmarke AI",
    status: "kismi", priority: "P2", effort: "L",
    market: ["Gleamer"],
    ours: "Ölçüm yardımcısı: src/lib/msk.ts ile 4 protokol (el bileği AP, ayak bileği Böhler+tibiofibular, ayak lateral Meary/pitch, kalça AP CE+indeks); adlandırılmış anatomik noktaları sırayla alma, kenar-yapışmalı (snapPoint) nokta seçimi, mm/derece hesabı ve aralık yorumu. Araç çubuğunda 🦴 MSK ve Ölçüm sekmesinde panel; sonuçlar akışa/panoya kopyalanır. Kırık sınıflandırması ve heatmap için eğitimli model YOKTUR.",
    action: "El/omurga/ayak landmark ve kırık sınıflandırma modeli (eğitim verisi + heatmap).",
  },
  {
    id: "a-mg", category: "ai", title: "Mamografi: BI-RADS yoğunluk + DBT (tomosentez) okuma akışı",
    status: "kismi", priority: "P2", effort: "L",
    market: ["Lunit", "iCAD", "Therapixel"],
    ours: "CC/MLO 2×2 düzeni + slab navigasyonu var; BI-RADS 0–6 ve ACR meme yoğunluğu (a–d) rapor panelinde hesaplanır; otomatik yoğunluk algılama/DBT sınıflandırma modeli yok.",
    action: "Otomatik yoğunluk segmentasyonu + BI-RADS/Radlex makro sözlüğü.",
  },
  {
    id: "a-calcium", category: "ai", title: "Agatston kalsiyum skoru + kemik yoğunluğu ölçümü",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Aidoc", "3D Slicer"],
    ours: "Damar bazlı Agatston (HU ağırlıkları, ≥1 mm² alan eşiği, S0–S4 kategori) + oportünist L1–L4 trabeküler HU kategorisi + PA kardiyotorasik oran hesaplayıcı; hekim ölçü değerlerini girer.",
    action: "Piksel tabanlı otomatik kalsiyum algılama/segmentasyonu (model veya bağlamsal çekirdek); DEXA korelasyonu.",
  },
  {
    id: "a-lungquant", category: "ai", title: "Akciğer kvantifikasyonu: lob/emphisema (LAA-950)/volüm",
    status: "kismi", priority: "P2", effort: "L",
    market: ["3D Slicer", "Aidoc"],
    ours: "**Panel olarak çalışıyor:** Araç çubuğu → 🫁 Akciğer (CT). `src/lib/lungQuant.ts` seriden histogram örnekler (gövde dışı hava dışlanır: satır uçlarından gövde sınırı), LAA-950 (−950 HU altı oran), ortalama HU, PD15, tahmini hacim (mL) ve sınıf (normal–hafif/orta/ağır) üretir. Panelde **kesit dağılım profili** (kesit bazlı LAA-950 çubukları, en yüksek kesit işaretli), apikal–bazal fark notu, HU histogramı ve «Rapora ekle» satırı var (36 test; adım/örnekleme, gövde-dışı hava, kısmi −950 kümesi, hacim ölçekleme doğrulandı). SINIR: **lob/fissür ayrımı, yağ-doku sınırı ve SAM tabanlı segmentasyon YOK**; örnekleme (kesit/piksel adımı) nedeniyle hacim yaklaşıktır.",
    action: "Lob segmentasyonu (fissür tespiti/SAM) ve yağ-doku sınırı; solunum fazına göre normalizasyon.",
  },
  {
    id: "a-nm", category: "ai", title: "Nükleer tıp: DSA çıkarma, TIC eğrileri, MTV/SUVpeak",
    status: "kismi", priority: "P3", effort: "L",
    market: ["RadiAnt", "Hermes"],
    ours: "**Panel olarak çalışıyor:** Araç çubuğu → 🧪 Nükleer (PT/NM veya SUV çarpanı olan seri). `sampleSuvVoxels` seri piksellerini `SuvInfo.factor` ile SUV'a çevirip örnekler (2 piksel / ≤64 kesit); eşik **mutlak SUV** ya da **maksimumun %'si** (varsayılan %41) olarak seçilir, `metabolicTumorVolume` ile **MTV/SUVpeak**, eşik üstü **SUVmean** ve voksel sayısı gösterilir. Hekimin girdiği noktalardan **TIC** sınıflandırması (wash-out ≥%15 / plato / progresif) + zirve, wash-in, wash-out yüzdeleri; «Rapora ekle» satırı. SUV çarpanı yoksa panel uyarır ve elle çarpan girişi verir. Pre/post subtraksiyon özeti (`subtractionSummary`) kütüphanede. 31 test (TIC sınırları, örnekleme adımları, eşik modları). SINIR: **3B metabolik hacim görselleştirmesi ve gerçek rekonstrüksiyon/decay kalibrasyonu yok**; MTV örnekleme tabanlı tahmindir.",
    action: "3B MTV görselleştirmesi, doz/decay/atenüasyon kalibrasyonu ve ROI tabanlı SUVpeak (1 cm³ küre) tanımı.",
  },
  {
    id: "a-modelops", category: "ai", title: "Model operasyonları: kayıt defteri, A/B, kalibrasyon ve drift izleme",
    status: "kismi", priority: "P2", effort: "L",
    market: ["Tüm üreticiler"],
    ours: "`src/lib/modelOps.ts` güven kalibrasyonu (binler + ECE), z tabanlı drift kontrolü ve model parmak izi; `/api/ai/performance` kalibrasyon/ECE üretir. **Yeni — model kayıt defteri:** `ai_model_registry` tablosu (ad+sürüm tekil; aşama aday/aktif/emekli, trafik %0–100, parmak izi, not) ve `/api/ai/registry` (GET liste + aşama sayımı + tutarlılık uyarıları + `?seed=` ile **deterministik A/B ataması**; POST yalnız yönetici, `model.register`/`model.activate` denetim kaydı ve aşama değişikliği notu). Yönetim → AI sekmesinde kayıt tablosu + ekleme/güncelleme formu (`src/lib/modelRegistry.ts`: FNV-1a tohum, kümülatif trafik bantları, eksik toplamda kalan pay ilk aktif modele, >%100 normalize; 38 test). SINIR: A/B ataması **çıkarım yoluna bağlanmadı** (çıkarım tarayıcıda çalışıyor) ve otomatik kanarya/geri alma yok.",
    action: "Atamayı gerçek çıkarım isteğine bağla, kanarya metrikleriyle otomatik geri alma; etiket/sürüm değişikliği süreç onayı.",
  },
  {
    id: "c-sr-tid1500", category: "measure", title: "Yapılandırılmış ölçümler: DICOM SR TID 1500 + RadLex/RSNA CDE",
    status: "kismi", priority: "P1", effort: "M",
    market: ["PowerScribe", "Weasis"],
    ours: "Basic Text SR (rapor) + **yeni:** `src/lib/sr1500.ts` — DICOM Comprehensive SR (…88.33) TID 1500 Imaging Measurement Report: her ölçüm 125007 Measurement Group içinde izleme kimliği (112039), kararlı izleme UID'si (112040), kodlu bulgu (121071) ve bulgu yeri (363698007), NUM değeri + UCUM birimi ve referans görüntü (121191) ile yazılır. Ekran ölçümleri `measurementExport.ts` ile bu yapıya çevrilir (uzunluk/elipsoid/ROI/çokgen). Kod UYDURULMAZ: standart kodlar DCM/SCT/UCUM, diğerleri 99ATIKVIEWER. **Kurum kod eşlemesi (yeni):** `src/lib/codeMapping.ts` — kurumun lisanslı RadLex/SNOMED CT eşleme dosyası (CSV/TSV/JSON) okunur ve **doğrulanır** (şema adları normalize, kod biçimi RID/SCT/LN/DCM/UCUM, satır numaralı hata listesi, yinelenen anahtar uyarısı); Türkçe anahtarlar katlanarak eşlenir. Yalnız `99ATIKVIEWER` özel kodları değiştirilir — standart DCM/SCT/UCUM kodları ezilmez; eşleşme yoksa özel kod korunur (`mappingCoverage` ile kapsam). Dışa aktarma menüsünden «Kurum kod eşlemesi yükle…» ile yüklenir, tarayıcıda saklanır ve TID 1500 çıktısında kullanılır. `tests/code-mapping.test.ts` (50 assert): CSV/TSV/JSON okuma + bozuk satır reddi + iki SR belgesinin dicom-parser ile kodu/şeması. KALAN: sözlük dosyasının kendisi (lisans kurumda) ve eşleme kapsam raporunun arayüzde gösterimi.",
    action: "RadLex/SNOMED CT sözlük dosyasıyla kod eşleme tablosu (lisans kurumda).",
  },
  {
    id: "c-seg-rtstruct", category: "measure", title: "Segmentasyon editörü + DICOM SEG/RTSTRUCT dışa aktarma",
    status: "kismi", priority: "P1", effort: "M",
    market: ["3D Slicer", "OHIF"],
    ours: "`src/lib/segmentation.ts` — fırça/silgi, eşik dolgusu, tohumdan bölge büyütme, kesit kopyalama, hacim (px×py×dilim, mL), maskeden otomatik uzun/kısa eksen, maske JSON kalıcılığı; tuval içi fırça arayüzü (`SegEditor`) ve DICOM **SEG** (1 bit/piksel) + **RTSTRUCT** dışa aktarma çalışıyor. **Yeni — gerçek kenar izleme:** `traceContours` Moore komşuluk izlemesiyle (Jacob durma kuralı) her bağlı bileşenin **sıralı** sınır poligonunu üretir; satır taramasının içbükeylikleri kesme hatası giderildi. RTSTRUCT artık kesit başına **bileşen başına ayrı CLOSED_PLANAR kontur** yazar (`sliceContourPoints`), böylece çok odaklı/ayrık segmentler doğru temsil edilir. 78 test (L şekli içbükey köşe, halka, iki bileşen, tek piksel/çizgi, mm dönüşümü). SINIR: delikler ayrı ROI olarak yazılmaz (yalnız dış sınır) ve AI tohumlama yok.",
    action: "AI tohumlama (model), delikler için iç kontur/ROI ayrımı ve kontur simplifikasyonu (Douglas-Peucker).",
  },
  {
    id: "c-recist-full", category: "measure", title: "RECIST tamamlayıcıları: lenf nodu, non-hedef lezyon, otomatik lezyon eşleştirme",
    status: "var", priority: "P1", effort: "M",
    market: ["Lunit", "Aidoc", "qure.ai"],
    ours: "Üç bileşen de çalışır durumda. **Lenf nodu:** `lymphNodeTable`/`lymphNodeCategory` (kısa eksen <10 normal, <15 takip, ≥15 patolojik) ve hedef seçim denetiminde ≥15 mm kuralı. **Non-hedef:** `nonTargetStatus` (CR / non-CR-non-PD / PD) + genel yanıt bileşkesi (`recistFull.ts`; hedef CR + non-hedef CR → CR, yeni lezyon → PD). **Otomatik eşleştirme:** `summarizeNoduleTracking` en yeni iki çalışmayı anatomi + lezyon adı imzasıyla eşleştirir; Δ mm/%, yeni ve saptanmayan lezyonlar Nodül takibi panelindeki «Çalışmalar arası eşleştirme» bölümünde (CSV dahil). **Otomatik ölçüm:** segmentasyon maskesinden uzun/kısa eksen (`segmentation.ts → maxAxes`/`sliceAxes`: dışbükey zarf + en uzak çift, minimum genişlik) editörde «Eksen: uzun … / kısa … mm» olarak gösterilir. Sınır: eşleştirme kural tabanlıdır (3B deformable kayıt yok) ve maske hekim tarafından çizilmelidir; çaplar hekim onayına tabidir.",
    action: "3B deformable kayıt ile otomatik lezyon eşleştirme (kurumsal doğrulama gerektirir).",
  },
  {
    id: "c-measure-history", category: "measure", title: "Ölçüm geçmişi ve trend grafikleri (çap/HU/SUV zaman serisi)",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Lunit", "Aidoc"],
    ours: "**Sunucu tarafı yapılandırılmış geçmiş var:** `measurement_history` tablosu (hasta + tarih + lezyon tekil; HU/SUV kolonları) ve `/api/measurements` (GET hasta geçmişi, POST toplu yazma + aynı üçlüde güncelleme + `measurement.save` denetim kaydı). Nodül takibinde girilen ölçümler otomatik yazılır; footer'daki «☁ Sunucu geçmişi» paneli lezyon bazlı **trend grafiği** (SVG), ilk–son Δ mm/% ve HU değişimi, gün aralığı ve CSV üretir (`src/lib/measureHistory.ts`, 27 test). Tarayıcı kaydı yedek yoldur. KALAN: ROI/anotasyon ölçümleri henüz yazmıyor (yalnız nodül takibi) ve SUV değerini girecek nükleer tıp paneli yok — kolon hazır, yazan arayüz yok.",
    action: "ROI/anotasyon ölçümlerini de aynı tabloya bağla; SUV girişli nükleer tıp paneli + ortak trend görünümü.",
  },
  {
    id: "d-close-loop", category: "report", title: "Kritik sonuç kapanış döngüsü: ACK + iletim kanıtı + eskalasyon kaydı",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Aidoc", "Viz.ai"],
    ours: "ACK + iletildi kanıtı (relayedTo/relayedAt) + eskalasyon kaydı. **Yeni:** `closeLoopRules.ts` — önem derecesine göre SÜRE politikası (kritik 15 dk alınma/30 dk eskalasyon, yüksek 60/120, diğer 240), durum makinesi (yeni/gecikmis/eskalasyon-gerekli/eskale-edildi/alinmis/iletildi), 15 dk'lık hatırlatma aralığı ve ikinci hekim/sorumlu uzman/kurum nöbeti hedefli eskalasyon mesajı. `/api/notifications?escalation=1` gecikmişleri listeler; PATCH `action=sweep` süresi dolanları eskale eder (denetim: notify.escalate/notify.sweep). Bildirim zilinde süre etiketi + 'Süre taraması' ve hedef seçimi var. KALAN: hatırlatmanın e-posta/SMS ile dışarı gönderimi (sağlayıcı kurumda) ve HBYS denetim satırı eşlemesi.",
    action: "Dış iletişim sağlayıcısı (e-posta/SMS/çağrı) ve HBYS denetim birleştirme (kurum entegrasyonu).",
  },
  {
    id: "d-followup", category: "report", title: "Takip önerilerini çalışma listesine taşıma",
    status: "kismi", priority: "P1", effort: "S",
    market: ["Aidoc", "Rad AI"],
    ours: "Onaylı rapordaki öneri otomatik göreve dönüşüyor; modalite/bölge/süre/durum takibi var. **Yeni (`followupQueue.ts`):** sonuç tarihine göre kova/öncelik (geciken → bugün → yaklaşan 14 gün → ileri → tarihsiz; eşit tarihte kritik önce), yaklaşan/geciken için uyarı metni, görev tarihçesi CSV'si ve HBYS/RIS iadesi eşleme (rapor kimliği → çalışma UID → tek aday; belirsizse eşleşme YAPILMAZ) + sonuç metniyle kapatma (denetim: notify.followup_outcome). `/api/notifications?followup=summary|csv`; 🔔 panelinde kalan gün etiketi, 'İade bağla' ve görev başına 'Sonuç' düğmesi. KALAN: iadenin HBYS/RIS'ten otomatik çekilmesi (HL7 ORU/FHIR DiagnosticReport — kurum entegrasyonu).",
    action: "HBYS/RIS'ten otomatik sonuç çekme (HL7 ORU / FHIR DiagnosticReport).",
  },
  {
    id: "d-peer", category: "report", title: "Peer review / ikinci okuma / uyuşmazlık kaydı (RADPEER)",
    status: "var", priority: "P2", effort: "M",
    market: ["RADPEER (ACR)", "PeerVue", "RadPeer"],
    ours: "`peer_reviews` tablosu + `/api/reports/[id]/peer-reviews` (GET/POST) + rapor ekranında «İkinci okuma» kartı (uyumlu/kısmen/uyumsuz + fark türü + not; uyumsuzda açıklama zorunlu, raporu oluşturan kişi yorumlayamaz). **Yeni — RADPEER gözetimi:** puan eşlemesi (1 uyumlu / 2 anlamsız fark / 3 anlamlı fark), **deterministik örnekleme** (`shouldSampleReport`: aynı rapor her zaman aynı sonuca düşer), oran **ayarı** (`peerReviewSamplePct`, varsayılan %5, Yönetim → İş akışı'ndan kaydedilir) ve **hedef takibi** (`samplingTarget`: onaylı rapor × oran → beklenen/kalan). `/api/reports/peer-stats` uyum oranını (puan 1–2 uyumlu), RADPEER dağılımını, uyuşmazlık türlerini, hekim başına uyumsuzluk oranını, takip gerektiren uyumsuz okumaları ve **örneklem kuyruğunu** verir; panelde çubuklarla gösterilir. 34 test (puan eşlemesi, %10 örnek dağılımı ±1,5, hedef matematği, boş küme, bilinmeyen sonuç). SINIR: seçilen raporun ikinci okuyucuya **ataması/bildirimi** ve kurum RADPEER konferans iş akışı yok.",
    action: "Örneklenen raporu ikinci okuyucuya ata + bildirim gönder; RADPEER konferans/toplantı kaydı.",
  },
  {
    id: "d-ambient", category: "report", title: "Ambient dokümantasyon + yapılandırılmış makrolar",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Nuance", "Rad AI"],
    ours: "**Bu sürümde eklendi:** rapor düzenleme ekranında 14 hazır makro (teknik/bulgu/öneri; RadReport benzeri cümle blokları) + Türkçe Web Speech dikte. Ambient tıbbi sözlük/otomatik konuşmadan metne çevrim yok.",
    action: "Konuşmadan yapılandırılmış metin üretimi; Radlex/ACR ile eşleştirilmiş makro sözlüğü.",
  },
  {
    id: "d-icd", category: "report", title: "ICD-10 / ACR Appropriateness ve kodlama desteği",
    status: "kismi", priority: "P3", effort: "S",
    market: ["RadPal"],
    ours: "src/lib/icd10.ts: 28 kayıtlık bulgu→ICD-10 yaklaşık eşleme (hekim onayı zorunlu etiketiyle) ve 10 kurala dayalı istem uygunluğu puanı (1–9, ACR tarzı). Rapor düzenleme ekranında önerileri listeler, basıldıkça izlenim satırına 'ICD-10: kod — tanı' ekler; klinik bilgiden uygunluk notu gösterir. Öneriler kesin kodlama değildir.",
    action: "Kurum kodlama veritabanı ve ACR Appropriateness tam tablo; elektronik istem formundan çekilen endikasyonla otomatik puanlama.",
  },
  {
    id: "d-patient-letter", category: "report", title: "Hasta dostu sonuç mektubu (çok dilli)",
    status: "var", priority: "P3", effort: "S",
    market: ["Rad AI"],
    ours: "**Çalışıyor:** Rapor ekranı → «💬 Hasta mektubu». `src/lib/patientLetter.ts` hekimin onayladığı rapordan **TR/EN/DE** dillerinde, **sade/standart** okuma düzeyinde şablon tabanlı mektup üretir; sade düzeyde tıbbi terimler günlük karşılıklarıyla değiştirilir (nodül → küçük yumru, efüzyon → sıvı birikmesi, malign → kötü huylu olabilecek…). Uzun metinler cümle sınırında kısaltılır, tarih seçilen dilin biçimine çevrilir; mektup **yazdırılabilir/PDF**, panoya kopyalanabilir. Rapor onaylı değilse mektup **TASLAK** olarak işaretlenir ve yazdırma kilitlenir; sorumluluk notu ve «hekiminize başvurun» ilkesi her dilde sabittir. 39 test (üç dil, sadeleştirme, tarih biçimi, kısaltma, boş alan yedekleri, taslak uyarısı) + SSR duman testi. SINIR: e-posta/SMS ile gönderim ve hasta portalı entegrasyonu yok (kurum sağlayıcısına bağlı); dil seti TR/EN/DE ile sınırlı.",
    action: "Kurumsal: e-posta/SMS gönderimi, hasta portalı entegrasyonu ve ek diller (çeviri onayı).",
  },
  {
    id: "r-style-cite", category: "report", title: "Üretken AI'da hekim üslubu öğrenme + kesit alıntısı",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Rad AI", "RadPal"],
    ours: "LLM taslak var; üslup öğrenimi ve alıntı yok.",
    action: "Gönüllü düzeltmelerden stil öğrenimi; çıktıda kesit referansları.",
  },
  {
    id: "e-stow", category: "workflow", title: "PACS'a geri gönderme: STOW-RS / C-STORE (SR, KO, anonim DICOM)",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Weasis", "OHIF"],
    ours: "`/api/pacs/stow` tek uçtan dört nesne türü: **SR** (yalnız onaylı rapor → DICOM Basic Text SR), **KO** (anahtar kesitler), **PR** (GSPS sunum durumu) ve **anonim seri**. KO/PR'de kesit UID'leri önce QIDO-RS ile PACS'te doğrulanır; anonim gönderimde baytlar TARAYICIDA sıfırdan üretilir (kimlik/özel etiket/orijinal UID taşımaz), sunucu örnek sayısı + toplam boyut + DICM imzasını yeniden denetler (`stowPayload.ts`), her gönderim denetime yazılır (pacs.send_anon / _partial). C-STORE (DIMSE) yok.",
    action: "C-STORE (DIMSE) ve seçimli gönderme diyaloğu (nesne türü + seri parçası).",
  },
  {
    id: "e-wado-frame", category: "workflow", title: "WADO-RS URI + kare/bulk (frame-level) getirme",
    status: "kismi", priority: "P1", effort: "S",
    market: ["OHIF", "Weasis"],
    ours: "Instance bazlı WADO + **yeni:** kare düzeyinde getirme — `wadoFrames()` (`.../instances/{sop}/frames/1,2,3`), çok parçalı yanıtın TÜM parçalarını çıkaran `parseAllMultipart()`, `/api/pacs/frames?studyUid=…&seriesUid=…&sopUid=…&frames=1,2,3` (tek kare `raw=1` ile doğrudan ikili; her getirme denetime yazılır). İstemcide LRU kare önbelleği (`FrameCache`, 240 kare), grup istekleri ve ±2 ön getirme penceresi (`wadoClient.ts`). KALAN: bulkdataURI ile piksel verisinin metadata içinden çekilmesi (DICOMweb standardı; OHIF uyumu için).",
    action: "bulkdataURI ile metadata-içi piksel erişimi; sıkıştırılmış aktarımda istemci codec köprüsü.",
  },
  {
    id: "e-hl7-mwl", category: "workflow", title: "HL7 v2 MLLP alıcısı + Modality Worklist (MWL)",
    status: "kismi", priority: "P1", effort: "L",
    market: ["Aidoc", "PowerScribe", "MedDream"],
    ours: "`scripts/hl7-mllp-server.ts` + `src/lib/hl7.ts` — MLLP/TCP dinleyici ORM^O01/ORU^R01 mesajını ayrıştırıp `/api/his/orders`'a çevirir ve ACK verir (`npm run hl7:mllp`). **Bu sürümde eklendi — Modality Worklist:** `src/lib/mwl.ts` (DICOM JSON → worklist ögesi, Implicit VR LE okuyucu, süzme/sıralama/özet, öge → çalışma eşlemesi), `pacs.ts` `fetchMwl()` (MWL kökü → DICOMweb `/modality-worklist` → DIMSE köprüsü sırasıyla dener, 401/403 hatasını öne çıkarır), `/api/his/mwl` (GET liste + POST `Çalışmaya al`, `his.mwl_query`/`his.mwl_to_study` denetimi) ve `scripts/mwl-cfind-proxy.ts` (`npm run mwl:cfind`, dcm4che `findscu` ile C-FIND; ham Implicit VR baytlarını da JSON'a çevirir). İş istasyonunda **Çalışma listesi → İş listesi (MWL)** sekmesi. KALAN: gerçek DIMSE C-FIND/N-CREATE (MPPS) yığını Node içinde değil, köprü sürecinde.",
    action: "MPPS (N-CREATE/N-SET) bildirimi; ADT/A08 hasta birleştirme; çoklu AET yönlendirme.",
  },
  {
    id: "e-fhir-in", category: "workflow", title: "FHIR girişi: ServiceRequest/ImagingStudy çekici",
    status: "kismi", priority: "P2", effort: "M",
    market: ["OHIF", "Microsoft Fabric"],
    ours: "Çıktı olarak FHIR DR var; sipariş/çalışma girişi yok.",
    action: "FHIR client (OAuth), sipariş→çalışma, ImagingStudy→WADO eşlemesi.",
  },
  {
    id: "f-prefs", category: "workflow", title: "Kullanıcı başına tercihler sunucuda (layout, preset, kısayol)",
    status: "kismi", priority: "P2", effort: "S",
    market: ["RadiAnt", "OHIF"],
    ours: "**Bu sürümde eklendi:** `/tercihler` sayfası + `/api/profile/preferences` (beyaz-listeli GET/PATCH/DELETE); açılış düzeni ve pencere ön ayarı istasyonda uygulanır. Kısayol tuşları ve tema tercihi yok.",
    action: "Klavye kısayolları ve tema tercihleri.",
  },
  {
    id: "f-tat", category: "workflow", title: "Turnaround/istatistik panosu (TAT, onay süresi, bulgu/adet)",
    status: "var", priority: "P2", effort: "M",
    market: ["Aidoc", "Viz.ai"],
    ours: "`/api/reports/stats` + Yönetim > İş akışı: toplam/onaylanan, durum ve modalite dağılımı, ortalama/medyan/p90 TAT, eski taslak ve hekim kırılımı. **Yeni:** **haftalık TAT trendi** (`weeklyTrend`, 8 hafta, onaylanma tarihine göre, boş haftalar dahil) + **modalite süzgeci**, **hedef TAT eşiği** (varsayılan 24 sa, panelden değiştirilebilir; ≤hedef içinde, ≤1,25×hedef sınırda, üstü hedef dışı) ve otomatik **uyarılar**: hedefi aşan hafta, önceki haftaya göre %25'ten fazla yavaşlama, bayat taslak. Panelde çubuk grafik + kesikli hedef çizgisi (`?targetHours=`/`?modality=` parametreleri; `src/lib/workflowStats.ts`, 37 test).",
    action: "Kurumsal: modalite bazlı ayrı hedefler ve e-posta/Slack raporu (sağlayıcı kurumda).",
  },
  {
    id: "f-batch", category: "workflow", title: "Toplu/arka plan içe aktarma kuyruğu",
    status: "kismi", priority: "P2", effort: "M",
    market: ["OHIF", "Weasis"],
    ours: "**Kısmen:** Klasör/seri toplu içe aktarma çalışır (`tests/folder-import.cjs`); eksik: arka plan kuyruğu, ilerleme durumu, hata raporu ve yeniden deneme.",
    action: "Kuyruk tablosu + ilerleme; başarısız yeniden deneme.",
  },
  {
    id: "f-share", category: "workflow", title: "Süreli paylaşım bağlantısı + watermark + denetim",
    status: "kismi", priority: "P2", effort: "M",
    market: ["RadiAnt", "Weasis"],
    ours: "**Bu sürümde eklendi:** `share_links` tablosu + `/api/shares` (GET/POST), `/api/shares/{token}` (DELETE) ve herkese açık `/paylas/{token}` sayfası (filigranlı salt okunur rapor özeti + anahtar kesitler). Bağlantı süre seçimi 1–30 gün, kapatılabilir, her erişim erişim sayacıyla denetimde işlenir. Ham DICOM/görüntü paylaşımı (imzalı URL) yoktur.",
    action: "Görüntü (kesit) paylaşımı için imzalı/nesne depolama URL'si; paylaşım linki yönetim paneli.",
  },
  {
    id: "f-kimlik-rbac", category: "trust", title: "Kullanıcı hesapları, rol denetimi (RBAC) ve iki faktörlü doğrulama",
    status: "kismi", priority: "P0", effort: "M",
    market: ["Tüm kurumsal ürünler"],
    ours: "AUTH_MODE=hesap ile scrypt parola, imzalı oturum, TOTP/MFA ve rol bazlı authorize() aktif. **Yeni:** oturum listesi/iptali (kullanıcı kendi, yönetici tümü), «bu cihaz dışındakileri kapat» ve hatalı giriş kilidi (5 hata/15 dk → 429) uygulandı; oturum kimliği veritabanında SHA-256 özetiyle saklanır. Kalan: SSO/OIDC/SAML/LDAP, parola sıfırlama, hekim profili çoklu üyelik eşleme.",
    action: "Kurumsal dizine (OIDC/SAML/LDAP) bağlan; parola sıfırlama ve hekim profili eşleştirme.",
  },
  {
    id: "g-webhard", category: "trust", title: "Web hardening: CSP, X-Frame-Options, CSRF, rate limiting",
    status: "kismi", priority: "P1", effort: "S",
    market: ["Kurumsal standart"],
    ours: "**Bu sürümde tamamlandı:** `next.config.ts` statik başlıkları (nosniff, Referrer-Policy, COOP/CORP, Permissions-Policy) + `src/proxy.ts` içinde **nonce tabanlı CSP** (`strict-dynamic`, `object-src none`, `frame-ancestors self`, `wasm-unsafe-eval`), `X-Frame-Options: SAMEORIGIN` ve CSP ihlal rapor ucu (`/api/csp-report`). **Hız sınırı:** `src/lib/webSecurity.ts` `RateLimiter` (kayan pencere, IP/kullanıcı anahtarı, uç sınıfına göre 10–600 istek/dk, `429` + `Retry-After`, `AV_RATE_LIMIT=off`). **CSRF:** Origin/Referer/Sec-Fetch-Site doğrulaması + `av_csrf` çerezi ↔ `x-csrf-token` çift gönderim jetonu; istemci `apiFetch` sarmalayıcısı tüm bileşenlerde kullanılıyor (403 `needsCsrfToken` → bir kez yeniden dene). Test: `npm run test:webhard`.",
    action: "Çok örnekli dağıtım için Redis tabanlı paylaşılan sayaç; CSP raporlarının SIEM'e aktarımı.",
  },
  {
    id: "g-audit-export", category: "trust", title: "Denetim dışa aktarımı (Syslog/CEF/JSON) + uzun vadeli arşiv",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Aidoc", "Viz.ai"],
    ours: "**Bu sürümde eklendi:** `/api/audit/export?format=json|jsonl|cef` (yonetici only, zincir dogrulamali), `AUDIT_SYSLOG_HOST` ile UDP CEF ve `AUDIT_SIEM_URL` ile imzali (HMAC) HTTP teslimati — outbox kuyrugu + ustel yeniden deneme; kuyruk durumu yonetici ekraninda izlenir/elle bosaltilir. Sifreli arsiv/saklama (retention) politikasi yok.",
    action: "Hook ile log collector; şifreli arşiv ve saklama politikası.",
  },
  {
    id: "g-supplychain", category: "trust", title: "Tedarik zinciri: CodeQL, SBOM, imzalı derleme (SLSA), dependency review",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Tüm kurumsal ürünler"],
    ours: "CodeQL (JS/TS, security-and-quality), Dependabot ve PR dependency-review yapılandırması var. Dependency Graph etkinleştirildi; PR #21 üzerinde dependency-review adımı başarıyla çalıştı ve SBOM API erişimi doğrulandı. Bu PR bağımlılık değişikliği içermediğinden güvenlik açığı tespiti ayrıca sınanmadı. **Diğer işler:** `sbom.yml` artık CycloneDX 1.6 SBOM + kaynak arşivi + `SHA256SUMS` üretir ve **SLSA v1 derleme kökenini** GitHub OIDC ile imzalar (`actions/attest-build-provenance`, `gh attestation verify` ile üretimden hemen sonra doğrulanır). `scripts/supplychain.mjs` bağımsız doğrulayıcı: özet eşleşmesi, SBOM biçimi (purl/lisans), kanıtın `subject[].digest.sha256` bağlantısı — `npm run test:supplychain`. `supplychain-verify.yml` yayınlanan varlıkları indirip yeniden denetler.",
    action: "Bağımlılık değişikliği içeren güvenli bir PR ile denetim çıktısını doğrula; SBOM imzalama ve kurumsal HSM değerlendirilmeli.",
  },
  {
    id: "g-backup-dr", category: "trust", title: "Yedek/geri yükleme/DR + nesne depolama adaptörü (S3/MinIO)",
    status: "kismi", priority: "P1", effort: "L",
    market: ["OHIF", "Weasis"],
    ours: "**Bu sürümde eklendi:** `src/lib/storageAdapter.ts` — `StorageAdapter` arayüzü (`put/get/delete/list`), `FsStorage` (atomik yazma, path traversal koruması) ve `S3Storage` (AWS SigV4 elle imzalanır; AWS/MinIO/R2/Wasabi, resmî test vektörüyle doğrulandı). Etkin arka uç `src/lib/server/storage.ts`: ayar → `S3_*` ortam değişkenleri → yerel disk; yükleme/indirme uçları adaptörden geçer (doğrudan `fs` yok). Yedek: `createManifest`/`verifyManifest`/`planRestore` + `/api/admin/backup` (manifest indirme, doğrulama, idempotent geri yükleme; tümü `backup.*` denetim kaydı). Test: `npm run test:backupdr`.",
    action: "Zamanlanmış yedek + S3 yaşam döngüsü/nesne kilidi (WORM); gerçek DR tatbikatı kaydı.",
  },
  {
    id: "g-kms", category: "trust", title: "KMS/anahtar rotasyonu (otomatik rotation, eski anahtarla çöz/yeniyle şifrele)",
    status: "kismi", priority: "P1", effort: "M",
    market: ["Aidoc", "Viz.ai"],
    ours: "**Bu sürümde eklendi:** anahtar halkası (`DATA_ENCRYPTION_KEYS`, en sağdaki yazar) ve anahtar kimlikli şifreli biçim (`enc:v2:<kid>:…`); v1 kayıtlar halkadaki anahtarlarla okunur. `src/lib/keyRotation.ts` rotasyon planı/ilerlemesi (güncel / yeniden şifrelenecek / açık / ÇÖZÜLEMEDİ); çözülemeyen kayıt varsa rotasyon DURDURULUR (anahtar kaybı sinyali) ve eski anahtarlar ancak tüm kayıtlar doğrulandıktan sonra atılabilir. `/api/admin/keyring` (generate/status/rotate/drop-old, tümü `security.key_*` denetimi) + Yönetim → Güvenlik → Anahtar rotasyonu paneli. Test: `npm run test:kms`.",
    action: "Halkayı harici KMS/Vault'tan okuma (imzalı anahtar sarmalama) ve zamanlanmış otomatik rotasyon.",
  },
  {
    id: "g-metrics", category: "trust", title: "Gözlem: Prometheus metrik, yapılandırılabilir log, readiness/liveness ayrımı",
    status: "kismi", priority: "P2", effort: "M",
    market: ["Tüm kurumsal ürünler"],
    ours: "**Bu sürümde eklendi:** `/api/metrics` (Prometheus metin, opsiyonel Bearer), liveness/ready ayrımı (`/api/health/live`, `/api/health/ready`). Yapılandırılabilir/şifrelenmiş log ve panel altyapısı yok.",
    action: "Loglama seviyesi ortam değişkenine bağla; Grafana panosu örneği ekle.",
  },
  {
    id: "i-mobile", category: "trust", title: "Mobil/PWA + çevrimdışı okuma",
    status: "kismi", priority: "P2", effort: "M",
    market: ["OHIF", "Weasis"],
    ours: "PWA: public/manifest.webmanifest (tr-TR, standalone, 192/512 simge), layout viewport/themeColor/appleWebApp ve ServiceWorkerRegister. public/sw.js yalnızca statik varlıkları (_next/static, /wasm, /codecs, /icons) önbelleğe alır; /api ve /paylas hiç önbelleğe girmez, çevrimdışıda hasta verisi gösterilmez (public/offline.html). Viewport'ta dokunmatik (touchAction none) var. Kalan: tam dokunmatik gezinme (kaydırmalı düzen seçici), bölgesel yazı tipi/kontrast ayarları ve çevrimdışı okuma listesi.",
    action: "Dokunmatik odaklı yerleşim ve çevrimdışı çalışma listesi önbelleği (yalnızca okunabilir meta veri).",
  },
  {
    id: "i-a11y", category: "trust", title: "Erişilebilirlik: WCAG, klavye taraması, ekran okuyucu etiketleri, yüksek kontrast",
    status: "kismi", priority: "P2", effort: "M",
    market: ["OHIF", "Weasis"],
    ours: "**Klavye/odak:** global `:focus-visible` halkası (fare odağında çizilmez), «İçeriğe geç» bağlantısı (`#viewer-main` ana bölgeye atlar), panellerde `role=\"dialog\"` + `aria-modal` + `aria-label` ve yeni panellerde **Escape ile kapatma** (`useEscapeKey`); `aria-live` bildirim bölgesi mevcut. **Kontrast:** `src/lib/a11y.ts` WCAG 2.1 kontrast matematiği (bağıl parlaklık, oran, AA/AAA eşikleri) ve arayüz paleti denetimi — `npm run test:a11y` (28 test). Etiket rengi `slate-500` zemin üzerinde 4,03:1 olduğu için **yüksek kontrast teması** (`.hc`: ikincil metinler ≥4,5:1) ve araç çubuğunda «◐ Kontrast» düğmesi eklendi (tercih cihazda saklanır, tüm sayfalarda uygulanır). **Hareket:** `prefers-reduced-motion` ile animasyon/geçişler kapatılır. KALAN: odak tuzağı (focus trap) ve diyalog içi Tab döngüsü, ekran okuyucu ile uçtan uca test, tüm ikonların metin alternatifi.",
    action: "Odak tuzağı + Tab döngüsü, NVDA/VoiceOver ile uçtan uca doğrulama, ikonların aria-label denetimi.",
  },
  {
    id: "i-i18n", category: "trust", title: "Arayüz çevirisi (TR/EN ve diğer diller)",
    status: "kismi", priority: "P2", effort: "M",
    market: ["OHIF", "Weasis"],
    ours: "Tek dil (Türkçe); hasta mektubu tek dil.",
    action: "Metinler i18n katmanına; rapor/MEKTUP çok dilli.",
  },
  {
    id: "h-label", category: "workflow", title: "Etiketleme/annotasyon platformu (fırça, sikayet, ekip)",
    status: "kismi", priority: "P2", effort: "L",
    market: ["3D Slicer", "MONAI Label"],
    ours: "**Kısmen:** Tek kişilik etiketleme + filigranlı salt okunur paylaşım var (F5). Eksik: ekip içi ortak etiket/akış bloğu, işaretleme/statü ve hakim radiology platformu.",
    action: "Etiket tablosu + versiyon; ekip paylaşımı.",
  },
  {
    id: "h-cohort", category: "workflow", title: "Kohort oluşturma / de-id pipeline / veri kuruluşu",
    status: "kismi", priority: "P2", effort: "L",
    market: ["3D Slicer", "MONAI"],
    ours: "Anonim DICOM export var; indeks/kohort yok.",
    action: "Kohort tablosu + dışa aktarım; büyük veri için streaming.",
  },
  {
    id: "h-model-eval", category: "ai", title: "Model eğitim/değerlendirme hook'u + model kayıt defteri",
    status: "kismi", priority: "P2", effort: "L",
    market: ["MONAI", "Aidoc"],
    ours: "ai-worker'da validate*.py betikleri var; CI kayıt defteri yok.",
    action: "evaluate/batch infer API; sonuçlar model kartına ve denetim kaydına yazılır.",
  },
];

type Patch = Partial<Pick<GapItem, "status" | "ours" | "action" | "priority">>;
/** Son güncelleme: yapılanlar gerçek testlerle doğrulandı; "kismi" olanların sınırı `ours` alanında yazılı. */
/**
 * SONRADAN GÜNCELLENEN SATIRLAR — **buradaki metin kazanır** (BASE_ITEMS'in üzerine
 * yazılır). Bir özelliği güncellerken satırın `ours`/`action` metnini **BU blokta**
 * güncelleyin; yalnız BASE_ITEMS'i düzenlerseniz canlı tablo eski metni göstermeye
 * devam eder (2026-11-25'te altı satırda bu sessiz hata oluştu). Koruma:
 * `tests/gap-patch-drift.test.ts` — yama taban metni budayamaz ve bilinen yanlış
 * iddialar geri gelemez. Aynı satırı iki yerde tutmak yerine tek yerde tutmayı
 * tercih edin: güncel metin BASE_ITEMS'te ayrıntılıysa buradaki kısa yamayı silin.
 */
const PATCHES: Record<string, Patch> = {
  "f-codec": { status: "var", priority: "P2", ours: "RLE, JPEG 2000, HTJ2K, JPEG-LS, JPEG Lossless, JPEG Baseline, 12-bit JPEG Extended, Deflated ve Big Endian okunuyor; her biri gerçek dosyayla (pydicom/DCMTK referansı) doğrulandı. 12-bit JPEG için alınan çözücüdeki +15 seviye kayması hatası düzeltildi. MPEG video ve JPEG-XL görüntü olarak çözülmüyor; rapor ekranında açıkça bildiriliyor.", action: "MPEG/JPEG-XL desteği; gerçek PACS verisiyle geniş kapsamlı test." },
  "f-uncompressed": { status: "var", ours: "Implicit/Explicit LE ve Explicit BE okunuyor ve doğrulandı; bit maskeleme, işaretli/işaretsiz, Rescale uygulanıyor." },
  "f-open": { status: "var", ours: "Klasör (alt dizinler), ZIP, sürükle-bırak, her uzantı, başlıksız ham DICOM, sunucu depolaması ve PACS (DICOMweb) ile açılır." },
  "f-objects": { status: "var", priority: "P2", ours: "DICOM Yapısal Raporlar (SR - TID ağaç yapısı ve ölçümler), Encapsulated PDF (belge görüntüleyici ve indirme), 12-Derivasyonlu EKG dalga formu (kalibre pembe kağıt ve kaliper ölçüm aracı), DICOM Katmanları (6000-601e), GSPS okuma **ve yazma** (pencere/döndürme/çevirme + anotasyon grafik katmanı) ve DICOM Key Object Selection tam desteklenir. **Eksik:** MPEG video oynatma (video çerçeveleri piksel kod çözücüye girmez) ve XA/US çok kareli akışın canlı yayını." },
  "v-geo": { ours: "Zoom, pan, döndür, çevir, cine (kare hızı ayarlı, 2–30 fps kaydırıcı), tam ekran. **Yeni — özelleştirilebilir kısayollar:** `src/lib/shortcuts.ts` (tuş normalleştirme, eylem başına en çok 4 tuş, çakışma bildirimi, bozuk kayıtta varsayılana dönüş) + Tercihler sayfasında düzenleme; varsayılanlar R/H/V/K ve ok tuşları (`tests/shortcuts.test.ts`, 28 assert).", action: "Kalan: kısayolların hekim hesabına (sunucu) bağlanması — şu an tarayıcıda `atik_shortcuts` — ve tüm görüntüleyici eylemlerinin (zoom/pan/ölçüm araçları) atanabilir olması." },
  "v-compare": { status: "var", ours: "Çok panelde seri karşılaştırma; ImagePositionPatient'a göre anatomik konum senkronu (konum yoksa oransal yedek); önceki çalışma sunucudan yan panelde açılır." },
  "v-hanging": { status: "var", priority: "P1", ours: "1×1, 1×2, 2×1, 2×2, 1×3, 3×1, 2×3, 3×2 düzenler + modalite/bölgeye göre otomatik sistem protokolleri + görsel Kullanıcı Tanımlı Asma Protokolü Editörü (oluşturma, düzenleme, silme, JSON içe/dışa aktarma ve tek tıkla uygulama) tam çalışır durumda." },
  "v-mpr": { status: "var", ours: "Ortogonal MPR (axial/koronal/sagittal) + OBLİK MPR: üç eksende serbest eğim/dönüş, kalın kesit (Ort./MIP/MinIP). Oblik düzlem mm uzayında örneklenir (küre testinde alan hatası <%1). Kavisli (curved) MPR yok.", action: "Kavisli MPR (damar/omurga merkez hattı) ve oblik düzlemin ortogonal panellerde çizgi olarak gösterimi." },
  "v-xref": { status: "var", ours: "panelRegistry + planes::sliceIndexAtPoint: 'İmleç' aracıyla tıklanan nokta hasta koordinatına (IPP/IOP) çevrilir ve aynı Frame of Reference'i paylaşan diğer panellerin en yakın kesidine geri çağırma ile atlanır; kaynak panel de kilitlenmez. Çapraz referans/localizer çizgileri mevcut. Yalnızca aynı çerçeve geçerlidir (farklı hasta/çerçeve sessizce atlanır).", action: "—" },
  "v-perf": { status: "kismi", ours: "Üç katmanlı hızlandırma var. (1) **GPU pencereleme** (`src/lib/gpuWindow.ts` + Viewport): ≥1 MP gri kesitlerde doku bir kez WebGL2'ye yüklenir (Int16→R16I, Uint16→R16UI, Float32→R32F — hepsi kayıpsız), WL/WW/invert yalnız uniform güncellemesi olur; shader `windowToRGBA`+`buildWindowLUT` ile birebir aynı gri seviyeyi verir (tests/gpu-window.test.ts: 84 kombinasyonda 0 fark), bağlam kaybı/doku sınırı/renkli seride sessizce CPU'ya döner. (2) **Tek geçişli LUT** (`src/lib/window.ts`): 512²'de ~3.4→1.8 ms, 4096²'de ~230→105 ms. (3) **Komşu kesit ön-işleme**: ±2 kesit boş zamanda `baseCache`'e (6 tuval, ≤2 MP kapısı). (4) **Web Worker ile pencereleme (yeni)**: `src/lib/windowWorker.ts` — LUT uygulaması (piksel→RGBA) kendi kendine yeterli Blob worker'da yapılır, `putImageData` ana iş parçacığında kalır; worker yoksa/başarısızsa (CSP, eski tarayıcı, SSR) sessizce eşzamanlı yola düşer. Worker kaynağı ile `windowToRGBA` arasındaki **bit eşdeğerliği** `tests/window-worker.test.ts` içinde `node:vm` ile doğrulanır (5 WL/WW/invert kombinasyonu + float32 + uç değer/NaN). (5) **Kademeli (streaming) PACS yükleme (yeni)**: `src/lib/streamLoad.ts` — kesitler geometrik dalgalarla (ilk 12, ×4, en çok 4 dalga) ve sınırlı eşzamanlılıkla (4) getirilir; ilk dalga gelir gelmez çalışma açılır, kalan kesitler arka planda sürer (seri kimliği korunur, listede kopya oluşmaz). Her kesit en fazla bir kez istenir, tek kesit hatası tüm çalışmayı düşürmez (başarısızlar sayılır ve bildirilir; yarıdan fazlası gelmezse açık hata), iptalde yeni istek başlatılmaz. `tests/stream-load.test.ts`: 32 assert. (6) **Piksel çözme Web Worker'da (yeni)**: `src/lib/pixelDecode.ts` + `src/lib/pixelWorker.ts` — sıkıştırılmamış gri (8/16 bit, tek örnek) çerçevelerin çözülmesi (bayt→örnek, endian, Bits Stored maskesi/işaret, Rescale Slope/Intercept, Int16/Uint16/Float32 paketleme) kendi kendine yeterli Blob worker'da yapılır; worker yoksa/başarısızsa eşzamanlı yola düşer. Bit eşdeğerliği `tests/pixel-worker.test.ts` (26 assert, `node:vm`) ile, seri düzeyi doğruluk `tests/gray-decode-e2e.test.ts` (12 assert: slope/intercept, 12 bit maske, işaret, çok kare sırası) ile sabitlendi. (7) **Doku atlası (TEXTURE_2D_ARRAY) (yeni)**: `src/lib/gpuAtlas.ts` + `gpuWindow.ts` — çok kesitli/kareli gri serilerde kesitler tek dizi dokusunun katmanlarına yerleşir; kaydırmada atlasta duran kesit **yeniden yüklenmez** (LRU tahliye). Katman sayısı cihaz sınırıyla (`MAX_ARRAY_TEXTURE_LAYERS`) ve 256 MB bellek bütçesiyle sınırlanır, gerekçesi arayüz/tanılama için metin olarak tutulur. `tests/gpu-atlas.test.ts` (37 assert): katman planı, LRU sırası, sahte (kayıt tutan) GL ile «gereksiz yükleme yok» sözleşmesi (64 kesitlik taramada 64 yükleme, geri dönüşte 8 isabet/0 yükleme) ve atlas shader metni. Atlas yolunda herhangi bir GL hatası olursa kalıcı olarak kapanır ve tek doku yolu kullanılır. MPR ayırımsız döngüyle 2–3×, 3B hacim GPU'da. Kalan: **sıkıştırılmış** çerçeveler (JPEG/JLS/J2K/RLE codec WASM) ve renkli seriler hâlâ ana iş parçacığında, kademeli akış önizlemesi dalga başına seri önekini yeniden parse eder (≤4 dalga), 8192 px üstü/2 GB üstü hacimlerde GPU yolu kapalı. ATLAS SINIRI: gerçek GPU'da görsel/performans doğrulaması yapılmadı (sandbox'ta WebGL yok) — sözleşme birim test düzeyinde.", action: "Kalan: sıkıştırılmış çerçeve codec'lerinin (WASM) worker'a taşınması; doku atlasının gerçek GPU'da ölçülmesi." },
  "v-multimon": { status: "var", ours: "Üç parça da çalışır. **Tam ekran:** her panelin kendi ⛶ düğmesi (o paneli tam ekrana alır, Esc çıkar) + çalışma alanı tam ekranı. **Dokunmatik jestler** (`src/lib/gestures.ts`): iki parmak kıstırma → zoom, iki parmak kaydırma → pan, tek parmak → kaydırma; tek karede ×2,5 sıçrama sınırı, zoom 0,15–12, parmaklar üst üste gelince bölme yapılmaz; fare/kalem aracı değişmez. **İkinci ekran / çoklu monitör** (`src/lib/mirror.ts` + `/ayna`): seri künyesi ve yalnız görüntülenen kesit BroadcastChannel ile ikinci pencereye canlı yayınlanır (WL/WW, kesit, zoom/pan/çevirme); pencere başka monitöre sürüklenir. Tüm seri kopyalanmaz (kesit kesit aktarım, alıcıda son 12 kesit, kesit başına 16 MP sınırı), bozuk mesaj yok sayılır, alıcı salt izlemedir, oturum kapısı ana sayfayla aynı, veri sunucuya gitmez; iki pencere arası taşıma testte gerçek `BroadcastChannel` ile doğrulanır (tests/mirror.test.ts). Sınır: monitörler arası otomatik yerleşim (Window Management API izni) kullanılmaz — pencereyi kullanıcı taşır.", action: "İsteğe bağlı: tarayıcı izniyle ikinci pencereyi otomatik diğer ekrana taşıma." },
  "m-shapes": { status: "var", ours: "Elips/dikdörtgen/çokgen ROI, Cobb açısı, SAPMA (referans doğrusuna dik uzaklık, mm) ve ELİPSOİD HACİM (π/6·d1·d2·d3, mL; 3. çap girilir) çalışıyor ve tarayıcıda sayısal olarak doğrulandı. Segmentasyondan hacim ayrı madde (m-seg).", action: "3. çapı otomatik başka kesitten alan 3 eksenli ölçüm sihirbazı." },
  "m-calib": { status: "var", ours: "Manuel uzunluk kalibrasyonu + PET için SUVbw (hasta ağırlığı, toplam doz, yarı ömür, enjeksiyon–çekim süresi; bozunma düzeltmeli). ROI ve fare altı değerinde SUV gösterilir; gerçek DICOM etiketleriyle beklenen değer (tümör 8,29 / zemin 0,83) doğrulandı. Etiket eksik/uyumsuzsa SUV hesaplanmaz ve nedeni yazılır. SUVlbm/SUVbsa **(yeni)**: `src/lib/suvVariants.ts` — Janmahasatian yağsız kütle ve Du Bois vücut yüzey alanı; boy (0010,1020) ve cinsiyet (0010,0040) etiketlerinden okunur, yoksa panelde elle girilir; hesaplanamayan varyantta nedeni yazılır (`tests/suv-variants.test.ts`).", action: "Kalan: üretici-özel PET etiketleri (Philips/Siemens özel SUV ölçekleri) ve SUVpeak/SUVmean için ROI tabanlı otomatik hesabın varyantlarla birlikte rapora yazılması." },
    "m-persist": { status: "var", ours: "Ölçümler ve anahtar kesitler çalışma+seri bazında sunucuya kaydedilir (autosave, `study_state`), rapora 'Ölçümler' bölümü olarak girer (ReportPrintModal) ve dışa aktarma menüsündeki «Ölçümler → DICOM SR (TID 1500)» ile sayısal ölçüm ağacı olarak yazılır. **PR (GSPS) artık anotasyonları da taşır:** `src/lib/gspsGraphics.ts` her ölçümü grafik nesnesine (uzunluk/açı/ok → POLYLINE, dikdörtgen/poligon → kapalı POLYLINE, elips/elipsoid → ELLIPSE, tek nokta → POINT) çevirir, etiketleri Text Object olarak yazar, anotasyonu kendi referans görüntüsüne (0008,1140) bağlar ve Graphic Layer («ANNOT») tanımlar; kesiti kaynak SOP Instance ile eşleşmeyen anotasyon atlanır ve menü kaç tane yazıldığını söyler (`tests/gsps-annotations.test.ts`, 22 assert; belge dicom-parser ile geri okunup grafik verisi FL olarak doğrulanır)." },
  "m-key": { status: "var", ours: "★ ile anahtar kesit (en fazla 8); rapora ilk 4 görsel, zaman çizelgesinde işaret. Dışa aktarma: DICOM Key Object Selection (TID 2010, KO) VE Grayscale Softcopy Presentation State (GSPS/PR: referans seri+kesitler, VOI LUT WL/WW, döndürme, çevirme; üretilen belgeler dicom-parser ile doğrulanır). PR rapor/imza belgesi değildir.", action: "—" },
  "m-seg": { status: "var", ours: "İnteraktif segmentasyon editörü var (araç çubuğu → 🧩 Segmentasyon, `src/components/SegEditor.tsx` + testli çekirdek `src/lib/segmentation.ts`): **fırça / silgi** (1–40 px yarıçap, sürükleme boyunca ara nokta doldurma), **eşik dolgusu** (HU aralığı, tek tıkla tüm kesit), **tohumdan bölge büyütme** (4-komşuluk flood fill, eşik dışına taşmaz), kesit gezinme, «sonraki kesite kopyala», kesit/tüm maske silme. Hacim **mL ve mm³** olarak canlı hesaplanır (piksel aralığı × kesit kalınlığı; kesit aralığı gösterilir). Maske seri kimliğiyle tarayıcıda saklanır ve **DICOM SEG (1 bit/piksel) / RTSTRUCT** olarak dışa aktarılır; Dışa aktar menüsündeki işaret tabanlı SEG çıktısı elle çizilen maskeyle **birleştirilir** (`unionMasks`, boyut uyuşmazsa sessiz bozulma yok). AI aday örtüsü düzenlenebilir maske değildir. Kalan: geri al/yinele, kesitler arası enterpolasyon ve SAM tabanlı hızlı seçim; hacim hekim onayına tabidir.", action: "Geri al/yinele, kesitler arası enterpolasyon ve (isteğe bağlı) SAM tabanlı ön segmentasyon." },
  "a-model": { status: "var", priority: "P0", ours: "DERİN ÖĞRENME VAR (yerel, ücretsiz): MONAI lung_nodule_ct_detection bundle (LUNA16 eğitimi, RetinaNet+ResNet50-3D) yerel AI worker'da (127.0.0.1:8787, CUDA) çalışır; BT toraks serilerinin gerçek HU hacmi gzip ile gönderilir, model kesit+boyut döndürür. Sentetik toraks phantoms'ında bilinen 12 mm ve 9 mm nodüller mm düzeyinde konum isabetiyle bulundu (skor 0.96/0.95, e2e API testi geçti). BT beyin hâlâ kural tabanlı (derin öğrenme değil). Diğer modalitelerde (US, MR, CR/DX vb.) kare bazlı nicel ölçüm vardır; bu tanı DEĞİLDİR. Klinik doğrulama YOKTUR — tüm bulgular radyoloji uzmanı onayı gerektirir.", action: "Kendi kohortunuzda klinik doğrulama (duyarlılık/özgüllük); BT beyin kanama için ayrı derin öğrenme modeli." },
  "a-loc": { status: "var", ours: "Kesit bazlı kutu, kesit aralığı, anahtar kesit, z konumu, ölçülen HU/boyut/hacim — BT'de gerçek hesaplanır. Derin öğrenme kutuları (worker → Finding) kesit aralığı + normalize bbox olarak gelir ve otomatik anahtar kesit önerisine girer; MR/CR demo.", action: "Kalan: MR/CR/mamografi için gerçek model çıktısı (şu an demo) ve modelin kutu yerine lezyon sınırı (piksel maskesi) üretmesi." },
  "a-heat": { status: "var", ours: "CXR modeli (Medical_X) pozitif sınıflar için Grad-CAM benzeri aktivasyon haritası döner; Viewport'ta renkli yarı saydam örtü (mavi→yeşil→sarı→kırmızı, düşük aktivasyon eşikli, saydamlık kaydırıcı, tuval önbelleği). 3B maskeler ve derin model aday alanları aynı örtü katmanında (ayarlanabilir opaklıkla) çizilir. src/lib/heat.ts ile paylaşılan kurallar test edilir; örtü KLINİK onay gerektiren görselleştirmedir ve rapora işlenmez." },
  "a-triage": { status: "var", ours: "AI Triaj sekmesi onaylanmamış iş durumundaki çalışmaları mevcut skora göre listeler; analizsiz çalışmalar da görünür. En fazla 500 kayıt gösterilir. Bulguların nedenleri ve bağımsız bulgu kararı saklanmaz; araştırma/demodur, klinik önceliklendirme değildir." },
  "a-notify": { status: "kismi", ours: "Kritik/yüksek aday bulguda uygulama içi bildirim (zil) + masaüstü tarayıcı bildirimi (src/lib/notify.ts). **Yeni — kanal yönlendirici (`src/lib/notifyChannels.ts` + `src/lib/server/notifyDispatch.ts`):** aynı olay **e-posta / SMS / çağrı cihazı / webhook** kanallarına paralel POST edilir; kanal başına önem eşiği (webhook+e-posta `yüksek`, SMS/çağrı `kritik`, ayarlanabilir) ve `enabled` anahtarı var. Yük **kimliksizdir** (önem, çalışma UID, modalite, kısa mesaj; hasta adı/numarası yok — tests/notify-channels.test.ts ile sabitlenir). Eski tek `criticalWebhookUrl` ayarı `legacy-webhook` kanalı olarak korunur (gövde sözleşmesi aynı). Yönetim → Entegrasyon'da kanal JSON'u, kanal başına **test gönderimi** (`POST /api/notifications/test`) ve HTTP durum/kod listesi; her gönderim `notify.critical`/`notify.test` olarak denetim kaydına (kanal bazında ok/hata) yazılır. 8 sn zaman aşımı, bir kanalın hatası diğerlerini engellemez. Kalan: gerçek sağlayıcı sözleşmeleri/anahtarları (SMTP relay, SMS operatörü, FCM/APNs) ve çağrı merkezi entegrasyonu — kurumun ağında tanımlanır, kod tarafı hazır.", action: "Kurumun SMTP/SMS/push ağ geçidi adreslerini ve alıcı listelerini tanımlaması (sözleşme/anahtar kurumda)." },
  "a-prior": { status: "var", ours: "Hasta bazlı geçmiş çalışmalar/raporlar listelenir; önceki çalışma ikinci panele **anatomik senkronla** açılır (paralel serilerde IPP/kesit konumuna göre eşleme, `mapSliceByPosition`) ve bulgu kartında önceki nicel ölçümle çap/hacim farkı gösterilir (`src/lib/priorCompare.ts`, testli). **Yeni — görsel kayıt (registration):** karşılaştırma panelinde 🎯 **Hizala** düğmesi iki kesidi normalize çapraz korelasyonla (NCC) hizalar; katı dönüşüm (öteleme + izotropik ölçek) kabadan inceye aranır (`src/lib/registration.ts`: indirgeme → sentetik kaydırmalarla tam geri kazanım testi, `tests/registration.test.ts`). Sonuç Δx/Δy/ölçek/skor olarak yazılır, skor < 0,55 ise «GÜVENİLİR DEĞİL» uyarısı verilir ve **uygulanmaz**; güvenilir hizada görüntü `alignPx` ile kaydırılır, ölçüm/annotasyon koordinatları değişmez. Farklı matris boyutları (64² ↔ 128²) ve farklı HU ölçeği NCC sayesinde sorun değildir; hesaplama düğmeye basınca yapılır (512²'de ≈0,5 sn). Sınır: **döndürme, elastik/deformable ve 3B hacim kaydı yok**; BT↔MR gibi farklı modalitelerde güvenilmez; uygulama hekim görsel doğrulamasına tabidir.", action: "İsteğe bağlı: döndürme/deformable kayıt ve otomatik (düğmesiz) ön hizalama; farklı modalite için karşılıklı bilgi (MI) tabanlı ölçüt." },
  "a-track": { status: "kismi", ours: "Nodül takibi (`src/components/NoduleTracker.tsx`): nodül başına tarih–çap zaman serisi + grafik, Lung-RADS v2022 özet kategorisi, hacim ikilenme süresi, CSV. RECIST 1.1: bazal/izlem çap toplamı, % değişim, CR/PR/SD/PD, organ/toplam sınırları, «yeni lezyon»/«tümü kayboldu» hekim işareti, lenf nodu kısa eksen kuralı ve non-hedef bileşeni (`recistFull.ts`). **Yeni — çalışmalar arası eşleştirme paneli:** en yeni iki çalışma tarihi otomatik karşılaştırılır; lezyonlar anatomi + lezyon adı imzasıyla eşleştirilir, eşleşenlerin Δ mm / Δ%, yeni ve saptanmayan lezyonlar ile **lenf nodu kısa eksen tablosu** (normal/takip/patolojik) gösterilir ve CSV'ye eklenir (`src/lib/lesionTracking.ts` → `summarizeNoduleTracking`; testler: eşleşme, yeni lezyon, lenf nodu kategorisi, tek tarih/boş girdi). Eşleştirme kural tabanlıdır (aynı lezyon olduğu hekimce doğrulanmalıdır) ve kategori klinik karar aracı değildir. KALAN: veriler yalnız tarayıcıda (`localStorage`) — **sunucuda hasta bazlı saklama/senkron ve çok kullanıcılı ortak liste yok**.", action: "Sunucuda hasta bazlı nodül/lezyon kaydı (çok kullanıcı, denetim izi) ve otomatik ölçüm aktarımı." },
  "a-quant": { status: "var", ours: "Nicel çıktılar üç kaynaktan gelir. (1) **Aday/ROI bazlı** (`src/lib/analyze.ts`, ROI istatistikleri): hacim (mL/mm³), ortalama/maks HU, çap. (2) **Agatston kalsiyum skoru** (`src/lib/structuredReport.ts`, testli): damar bazlı (LM/LAD/LCx/RCA) pik HU ağırlıkları (130/200/300/400 eşikleri), Σ(alan × ağırlık), kategori ve takip önerisi — Rapor ekranı → Yapılandırılmış skorlar. (3) **Oportünist kemik yoğunluğu**: vertebra trabeküler HU ile normal/sınırda/yüksek-risk kategorisi; DEXA T-skoru OLMADIĞI açıkça yazar. Ek olarak PA akciğer grafisinde kardiyotorasik oran (CTR) hesaplanır. Zaman serisi/trend grafiği ayrı maddede (c-measure-history) izlenir. Sınır: insidental bulgu tarama iş akışı (otomatik kuyruk) ve DEXA eşdeğeri ölçüm yoktur.", action: "Kurumsal: insidental bulgu tarama/triage iş akışı ve DEXA ile korelasyon çalışması." },
  "a-feedback": { status: "var", ours: "Bulgu bazlı onay/red/düzenleme + 'AI'nın kaçırdığı bulgu' girişi; Yönetim → AI performans'ta kesinlik (PPV) tablosu. **Yeni — uyuşmazlık panosu:** `src/lib/aiDisagreement.ts` + `/api/ai/performance` yanıtındaki `disagreement` bloğu; Yönetim → AI sekmesinde kategori bazlı karar/ret/düzenleme sayıları, **uyuşmazlık oranı** ve hekim **gerekçe metinleri** (en çok 20 satır) görünür (`tests/ai-disagreement.test.ts`). SINIR: oran yalnız hekim kararlarına dayanır — duyarlılık/özgüllük değildir (kaçırılan bulgu için elle ekleme gerekir)." },
  "a-vlm": { status: "kismi", ours: "İsteğe bağlı LLM (OpenAI uyumlu) yalnızca hekimin doğruladığı bulgu metninden taslak izlenim üretir; görüntü modele verilmez. Canlı LLM ile denenmedi (yapılandırma yok → kural tabanlı yedek denendi)." },
  "a-uncert": { status: "kismi", ours: "Belirsizlik bandı (src/lib/uncertainty.ts): skor−eşik mesafesinden SINIRDA/ORTA/GÜÇLÜ üç bant; CXR skor listesi ve AI bulgu kartlarında not + etiket. Finding.threshold alanı modele özgü eşiği taşır. KALAN GERÇEK EKSİK: kalibrasyon eğrisi/gerçek güven aralığı — doğrulama seti ve klinik süreç gerekir (kurumsal).", action: "Kalibrasyon eğrisi ve güven aralığı: doğrulama seti + klinik süreç (kurumsal)." },
  "r-template": { status: "kismi", priority: "P1", ours: "24+ hazır şablon (BT beyin/toraks, MR beyin/boyun/omurga/diz/kar/abdomen/pelvis/prostat/MRA/DWI, US, EKO, Doppler, MG, PET-CT, CR/DX PA/lateral vb.); modaliteye göre filtreleme + arama, /api/templates CRUD, rapordan şablonu kaydet; tohum eksiksiz. Yer tutucu (makro) yardımcısı: src/lib/templateMacro.ts — [BOYUT]/[KONUM] gibi alanları tanır, onay öncesi 'doldurulmamış şablon alanları' uyarısı, fillPlaceholders ile doldurma. KALAN: RSNA RadReport standardı/ACR şablon paketleri (lisans/kurum süreci).", action: "RSNA RadReport/ACR şablon paketleri ve endikasyon bazlı seçim listeleri (kurumsal/lisans)." },
  "r-genai": { status: "kismi", ours: "Taslak izlenim: yalnızca doğrulanmış bulgulardan (hasta kimliği ASLA gönderilmez); LLM varsa OpenAI uyumlu uç kullanılır, yoksa kural tabanlı. Üslup uyumu: src/lib/styleProfile.ts — hekimin geçmiş ONAYLI raporlarından (bölge tercihli, en uzun) kimliksiz örnek seçilir ve LLM sistem talimatına eklenir. KALAN: tam 'üslup klonu'/fine-tune ve kalite ölçümü kurumsal gereksinim.", action: "Üslup uyumunu kurum raporları üzerinde nicelleştirme (dış/değerlendirme)." },
  "r-version": { status: "var", priority: "P1", ours: "Her kayıt/onay sürüm olarak saklanır; onay sonrası rapor sunucuda kilitlenir (409); düzeltme addendum ile." },
  "r-esign": { status: "kismi", priority: "P0", ours: "src/lib/esign.ts: kanonik imza kaydı (SHA-256 hash, imza sahibi, kurum, zaman, sürüm, yöntem), verifySignatureRecord bütünlük denetimi, signatureNote etiketi. Rapor ekranında 'İmza kaydı' paneli: yöntem seçimi (NES seçeneği entegre olmadan devre dışı), NES olmadığını açık yazan onay kutusu ve son kayıtlar. /api/reports/[id]/signature POST/GET: onaylı (hash'i olan) içeriğe kayıt düşürür, kaydı denetim zincirine report.esignature olarak yazar. HÂLÂ NES DEĞİLDİR: akreditasyonlu mobil imza/kart okuyucu entegrasyonu kurumsal süreç.", action: "NES/mobil imza sağlayıcı entegrasyonu (sağlayıcı API'si, cihaz/OTP doğrulaması) ve yasal süreç." },
  "r-export": { status: "var", ours: "Rapor çıktıları: DICOM Basic Text SR (Türkçe UTF-8, onaylıysa VERIFIED işareti, anahtar kesit kanıt listesi; pydicom ile doğrulandı), HL7 FHIR DiagnosticReport, yazdırma/PDF; ayrıca dışa aktarma menüsünden ölçümler **DICOM Comprehensive SR (TID 1500)** olarak yazılır ve SR/KO/PR PACS'e STOW-RS ile gönderilir. SR bir elektronik imza değildir. RSNA CDE kodlaması yok.", action: "Kalan: RSNA CDE kod paketi ve ölçüm SR'ının rapor onayıyla otomatik PACS'e gönderimi (şu an dışa aktarma menüsünden elle)." },
  "r-link": { status: "var", ours: "Rapor metnindeki ve tablodaki 'Kesit N' bağlantıları görüntüleyicide o kesite götürür." },
  "w-pacs": { status: "kismi", ours: "DICOMweb QIDO/WADO/STOW istemcisi ve SR/KO/PR gönderimi var. STOW artık yalnızca gönderilen SOP UID ile eşleşen kabul kaydını başarı sayar; red, kısmi red veya doğrulanamayan yanıt hata verir. Ortak istemci STOW/QIDO/WADO akışı CI'da Orthanc ile sınanır; ayrıca sahte sunucuyla başarısız yanıtlar test edilir. Bu test hastane PACS uyumunu garanti etmez.", action: "dcm4chee ve kurumsal PACS uyumluluğu; DIMSE C-FIND/C-MOVE ve C-STORE." },
  "w-worklist": { status: "var", ours: "Çalışma listesi: durum, atama, triyaj sıralaması, arama; yerel/HBYS/PACS kaynaklı." },
  "w-auth": { status: "kismi", priority: "P0", ours: "ACCESS_TOKEN tek kapı + AUTH_MODE=hesap ile scrypt parola, TOTP/MFA ve rol denetimi tüm API uçlarında aktif. **Yeni — sunucu taraflı oturum kaydı:** her giriş `user_sessions` satırı oluşturur (çerez yalnız rastgele kimlik taşır; veritabanında SHA-256 özeti tutulur); Yönetim → **Oturumlar** sekmesinde açık oturumlar IP/istemci/zaman ile listelenir, tek tek veya «bu cihaz dışındakiler» topluca kapatılır, yönetici tüm kullanıcılarınkini görür/kapatır. İptal edilen oturumun çerezi süresi dolmamış olsa bile reddedilir (test: `tests/session-policy.test.ts`; PostgreSQL akışı: `tests/auth-login.integration.ts`). **Hesap kilidi:** 15 dk içinde 5 hatalı giriş → 15 dk kilit, 429 + `Retry-After` (`LOGIN_LOCK_*`). Çıkış oturumu sunucuda da iptal eder. Eksik: SSO/OIDC/LDAP/SAML ve parola sıfırlama.", action: "Kurumsal dizin (OIDC/SAML/LDAP) ve parola sıfırlama akışı." },
  "w-audit": { status: "kismi", priority: "P1", ours: "Hash zincirli, DB tetikleyicisiyle değiştirilemez denetim kaydı çalışıyor (kurcalama testi). AUTH_MODE=hesap kullanıldığında her işlem oturumdaki gerçek kullanıcıya atfedilir. SIEM aktarımı: her kayıt AYNI işlemde `audit_delivery` kuyruğuna CEF olarak yazılır; `AUDIT_SIEM_URL` tanımlıysa HMAC imzalı POST ile gönderilir, başarısızlıkta üstel geri çekilmeyle yeniden denenir (vazgeçilen satır silinmez, yönetici ekranında görünür). UDP syslog da isteğe bağlı. KALAN: AUTH_MODE=hesap üretimde kurum politikasıyla zorunlu kılınmalı.", action: "Üretimde AUTH_MODE=hesap zorunlu; SIEM tarafında imza doğrulama sözleşmesi (kurum)." },
  "w-his": { status: "kismi", ours: "REST istem alımı (API anahtarlı, `x-api-key`) + FHIR R4 DiagnosticReport çıktısı. **Bu kayıt seviyesinde yapılanlar:** HL7 v2 MLLP alıcısı (`npm run hl7:mllp`, ORM^O01/ORU^R01 → ACK + sipariş yazımı) ve Modality Worklist (MWL C-FIND köprüsü `npm run mwl:cfind` + DICOMweb `/modality-worklist` + `/api/his/mwl`). Ayrıntılı sınırlar `e-hl7-mwl` maddesinde. Kalan: MPPS (N-CREATE/N-SET), ADT/A08 hasta birleştirme ve RIS'ten otomatik sipariş çekme (kurum entegrasyonu).", action: "MPPS bildirimi, ADT/A08 birleştirme, çoklu AET yönlendirme (kurumsal)." },
  "w-storage": { status: "var", ours: "Görüntüler sunucuda AES-256-GCM ile şifreli saklanır, tekilleştirilir, çalışma listesinden geri açılır. Tek düğüm dosya sistemi; nesne depolama/yedekleme sizin altyapınızdadır." },
  "w-deid": { status: "var", ours: "Anonim DICOM (ZIP) dışa aktarma: bellekten sıfırdan yazılır (özel etiket/UID/ad/kimlik/tarih/kurum taşınmaz), gerçek dosyayla gidiş-dönüş doğrulandı, denetim kaydı tutulur. Etiket düzenleyici yok." },
  "w-export": { status: "kismi", ours: "PNG, anonim DICOM (ZIP), cine video (WebM, kesit aralığı/kare hızı), tüm kesitler PNG (ZIP), anahtar kesitler DICOM KO, SR, FHIR, STL. Video tarayıcıda MediaRecorder ile üretilir (VP9 ile doğrulandı). CD/DVD ve paylaşım bağlantısı yok.", action: "Hasta CD'si/ISO, süreli paylaşım bağlantısı, MP4 çıktı." },
  "t-disclaimer": { ours: "Üst çubuk, durum çubuğu, panel ve rapor çıktısında; model kartı ve DEMO/kural tabanlı etiketleri." },
  "t-mdr": { status: "kismi", ours: "Kodla tamamen çözülemez; belgeler ve izlenebilirlik eklendi. docs/RISK_YONETIMI.md (ISO 14971 biçiminde genel + model bazlı risk tabloları, kalan risk) ve docs/KLINIK_DOGRULAMA_PLANI.md hazır. Yönetim → Uyum sekmesindeki 12 maddelik takip listesi devrede. Amaçlanan kullanım/sınıflandırma, ISO 13485/62304/14971 sertifikası ve klinik değerlendirme kurumsal süreçler olarak açık.", action: "Kurumsal kalite yönetim sistemi: amaçlanan kullanım beyanı, sınıflandırma, ISO 13485/62304/14971, klinik değerlendirme; hukuki danışmanlık." },
  "t-privacy": { status: "kismi", priority: "P0", ours: "Veriler diskte AES-256-GCM ile şifreli ve saklama politikası var; kimlik+MFA+rol denetimi ve sunucu taraflı oturum iptali çalışıyor. **Yeni — TLS zorunluluğu:** `REQUIRE_TLS=1` (ters vekil `x-forwarded-proto` bildirir) veya `REQUIRE_TLS=direct` ile TLS'siz sayfa istekleri https'e yönlendirilir, TLS'siz API istekleri **426** ile reddedilir; sağlık uçları/statik varlıklar muaf. HSTS başlığı (`max-age`, `includeSubDomains`, isteğe bağlı `preload`) TLS'li yanıtlarda yazılır (`tests/webhard.test.ts`). Eksik: alan düzeyi rol matrisi, veri sahibi silme talebi iş akışı ve kurumsal KMS/süreçler.", action: "Kurumda TLS sonlandırma + `REQUIRE_TLS=1`; veri sahibi başvuru/silme süreci ve rol matrisi (kurumsal)." },
  "t-automation": { ours: "Bulgular 'Onay bekliyor' gelir; hekim her bulguyu işaretlemeden onay verilemez (sunucuda da zorunlu); reddedilen/düzenlenen bulgu için gerekçe zorunlu (`findingsReason`) ve hekim kararı AI önerisinden ayrı saklanır (onay haritası + gerekçe, sürüm anlık görüntüsünde); skor 'kalibre değil' etiketli; demo/motor yok durumları açık. Uyuşmazlık panosu Yönetim → AI sekmesinde (kategori bazlı oran + gerekçeler).", action: "Kalan: uyuşmazlık oranı eşiği aşınca (ör. kategori bazında %30) yöneticiye uyarı ve gerekçelerin sınıflandırılarak modele geri beslenmesi." },
  "v-vr": { status: "var", ours: "WebGL2 ışın izleme: VR (renk/opaklık aktarım işlevi, gölgelendirme) ve MIP; kemik/yumuşak doku/gri/sıcak ön ayarları, fare ile döndürme/yakınlaştırma. Eşik yüzeyinden ikili STL dışa aktarma (RAS, mm; normaller dışa bakıyor, küre testinde hacim hatası %0,4). VR yalnızca görselleştirmedir.", action: "Kesme düzlemi/kırpma kutusu, kemik çıkarma, segmentasyondan yüzey, mesh düzgünleştirme." },
};
export const GAP_ITEMS: GapItem[] = BASE_ITEMS.map((i) => ({ ...i, ...(PATCHES[i.id] ?? {}) }));

export const COMPETITORS: Competitor[] = [
  {
    name: "RadiAnt", type: "viewer", focus: "Windows masaüstü; hız ve sadelik",
    strengths: [
      "Çok hızlı 2D, MPR, 3D VR; MIP/MinIP/Avg kalın kesit",
      "Seri senkronizasyonu, cross-reference çizgileri, 3D imleç",
      "Elips/çokgen/Cobb/deviation ölçümleri, füzyon, TIC, DSA",
      "CD/DVD, klasör, ZIP; JPEG/JPEG2000/JPEG-LS/RLE sıkıştırma çözme",
    ],
    learn: "Hız, ölçüm çeşitliliği ve hasta CD'sinden tek tıkla açma.",
  },
  {
    name: "OHIF", type: "viewer", focus: "Web tabanlı, sıfır kurulum, DICOMweb",
    strengths: [
      "Tarayıcıda çalışır; PACS ile DICOMweb üzerinden konuşur",
      "MPR, hanging protocol, segmentasyon, SR desteği",
      "Eklenti mimarisi; MONAI Label ile AI destekli etiketleme",
    ],
    learn: "Mimari olarak bize en yakın rakip; DICOMweb ve eklenti modeli yol gösterici.",
  },
  {
    name: "Weasis", type: "viewer", focus: "Çapraz platform, PACS entegrasyonlu",
    strengths: [
      "Key Object notları, hanging protocol, SR/ECG/RT desteği",
      "MPR, MIP ve v4 ile 3D hacim görüntüleme",
      "Hastane ve araştırma kullanımı; DICOMweb",
    ],
    learn: "Key image ve yapısal rapor nesneleriyle klinik iş akışı.",
  },
  {
    name: "Horos", type: "viewer", focus: "macOS; OsiriX tabanlı",
    strengths: [
      "MPR, 3D VR, füzyon",
      "Geniş eklenti ekosistemi",
      "OsiriX MD ile FDA/CE onaylı klinik kullanım seçeneği",
    ],
    learn: "Eklenti mimarisi ve klinik onaylı sürüm modeli.",
  },
  {
    name: "3D Slicer", type: "viewer", focus: "Araştırma düzeyi analiz ve segmentasyon",
    strengths: [
      "Segmentasyon, registration, 3D/4D görselleştirme",
      "150+ eklenti; yapay zeka araştırma araçları",
    ],
    learn: "Segmentasyon ve nicel analiz derinliği.",
  },
  {
    name: "MedDream", type: "viewer", focus: "Web radyoloji görüntüleyici",
    strengths: [
      "Hanging protocol, Key Object, Presentation State, CAD işaretleri",
      "PET-CT füzyon, 4D, montaj, panel bölme",
    ],
    learn: "Klinik düzen ve ilişkili tetkik yönetimi.",
  },
  {
    name: "MicroDicom", type: "viewer", focus: "Windows; ücretsiz başlangıç sürümü",
    strengths: [
      "Ücretsiz sürüm kişisel/ticari olmayan kullanım için tam işlevli",
      "DICOM görüntüleme, temel ölçüm, MPR, DVD/CD okuma",
      "Kurulumu hafif; klinik dışı istasyonlarda yaygın",
    ],
    learn: "Ücretsiz sürümün kapsamını net anlatmak — beklenti yönetimi ve sadelik.",
  },
  {
    name: "OsiriX", type: "viewer", focus: "macOS; araştırma + MD (onaylı) sürümü",
    strengths: [
      "MPR, 3D VR, PET-CT füzyon, TIC eğrisi",
      "Açık kaynak temel + OsiriX MD ile regüle klinik sürüm ayrımı",
      "Geniş eklenti ve betik ekosistemi",
    ],
    learn: "Açık kaynak çekirdeği korurken regüle edilmiş sürümle iş modeli kurma.",
  },
  {
    name: "Aidoc", type: "ai", focus: "Akut bakım triyajı ve çok bulgulu BT yapay zekası",
    strengths: [
      "PACS'e DICOM ile entegre; çalışma listesini yeniden önceliklendirir",
      "EHR gelen kutusu, mobil push ve çağrı cihazıyla çok kanallı bildirim",
      "Analitik panoları: bildirim→okuma→tedavi süreleri",
      "Çok sayıda ayrı onaylı modül (üretici/derleme kaynaklarına göre; ICH, PE, C-omurga kırığı, inme)",
    ],
    learn: "Yapay zekayı ayrı bir ekran değil, çalışma listesinin içine gömmek; bildirim ve denetim izi.",
  },
  {
    name: "Viz.ai", type: "ai", focus: "İnme ve nörovasküler/kardiyak ekip koordinasyonu",
    strengths: [
      "Büyük damar tıkanıklığı ve kanama odaklı tespit",
      "Mobil uygulamayla bakım ekibine anında bildirim",
      "Tedavi süresinde ölçülmüş iyileşme (kaynaklarda dakika düzeyinde azalma bildirilir)",
    ],
    learn: "Tespitten sonra iletişim: kim, ne zaman, ne gördü — kayıt altında.",
  },
  {
    name: "Lunit", type: "ai", focus: "Akciğer grafisi ve mamografi yapay zekası",
    strengths: [
      "Isı haritası (heatmap) çıktısı ve REST API",
      "Lezyon olasılık skorları; nodül odaklı BT modülü",
    ],
    learn: "Isı haritası + olasılık skoru ile açıklanabilir sunum.",
  },
  {
    name: "Annalise", type: "ai", focus: "Geniş anatomik kapsam (akciğer grafisi, BT beyin)",
    strengths: [
      "Çok sayıda bulguyu tek geçişte tarama",
      "Rutin PACS iş akışına entegrasyon",
    ],
    learn: "Tek modelle geniş bulgu kapsamı ve bulgu-bazlı sunum.",
  },
  {
    name: "Gleamer", type: "ai", focus: "Travma/MSK ve akciğer grafisi",
    strengths: [
      "Bayraklar PACS içinde görünür; hekim kabul/ret eder",
      "Kırık ve akciğer bulguları için hafif iş akışı",
    ],
    learn: "Hekimin tek tıkla kabul/ret ettiği hafif etkileşim.",
  },
  {
    name: "Rad AI", type: "report", focus: "Üretken yapay zeka ile rapor/izlenim",
    strengths: [
      "Dikte edilen bulgulardan taslak izlenim ve kılavuz önerisi",
      "Hekimin dilini ve üslubunu öğrenir",
      "Değişmeyen kontrollerde yalnızca değişimin dikte edilmesi",
    ],
    learn: "İzlenim taslağı ve kişiselleştirme; takip önerilerinde standartlaşma.",
  },
  {
    name: "PowerScribe", type: "report", focus: "Konuşma tanıma ve yapısal raporlama",
    strengths: [
      "Konuşma tanıma, ortam (ambient) modu",
      "Yapısal veri ve RSNA/ACR ortak veri öğeleri (CDE)",
      "Karar desteği ve takip izleme",
    ],
    learn: "Yapısal veri modeli ve standart terminoloji.",
  },
  {
    name: "RadPal", type: "report", focus: "Dikte tabanlı rapor/izlenim asistanı",
    strengths: [
      "Dikteden yapısal rapor ve izlenim",
      "ACR Appropriateness Criteria sihirbazı",
      "Sıfır veri saklama iddiası",
    ],
    learn: "Hafif, mevcut dikte araçlarına eklenen yardımcı modeli.",
  },
];

const ROADMAP_OLD: RoadmapPhase[] = [
  {
    id: "faz0", title: "Faz 0 — Dürüstlük ve güvenlik zemini", timeframe: "Bu turda yapıldı",
    goal: "Yanıltıcı çıktıları kaldır; okunamayan veriyi sessizce işleme.",
    itemIds: ["t-disclaimer", "t-automation", "r-review", "f-pixel", "f-open", "f-series"],
  },
  {
    id: "faz1", title: "Faz 1 — Gerçek ve güvenli çekirdek", timeframe: "1–3 hafta",
    goal: "Gerçek veriyi aç, kullanıcıyı tanı, her şeyi kaydet.",
    itemIds: ["f-codec", "w-auth", "w-audit", "r-version", "m-persist", "a-card", "w-deid", "t-privacy"],
  },
  {
    id: "faz2", title: "Faz 2 — Workstation çekirdeği", timeframe: "3–6 hafta",
    goal: "RadiAnt/OHIF düzeyinde okuma konforu.",
    itemIds: ["v-mpr", "v-xref", "v-mip", "v-hanging", "v-compare", "m-shapes", "m-key", "v-perf"],
  },
  {
    id: "faz3", title: "Faz 3 — Gerçek yapay zeka", timeframe: "6–12 hafta",
    goal: "Simülasyonu gerçek model çıktısıyla değiştir; hekimi sürece bağla.",
    itemIds: ["a-model", "a-heat", "a-triage", "a-feedback", "a-uncert", "a-notify", "r-template", "r-dictate", "r-genai"],
  },
  {
    id: "faz4", title: "Faz 4 — Entegrasyon ve uyum", timeframe: "3–6 ay",
    goal: "Hastane ortamına ve düzenleyici yola hazırlan.",
    itemIds: ["w-pacs", "w-storage", "w-worklist", "r-esign", "r-export", "a-prior", "t-validation", "t-mdr", "w-his"],
  },
];

export const ROADMAP: RoadmapPhase[] = [
  { id: "done", title: "Bu turda tamamlananlar (test edildi)", timeframe: "Tamam", goal: "Gerçek veri, güvenlik temeli, workstation çekirdeği.", itemIds: ["f-codec", "w-auth", "w-audit", "r-version", "t-privacy", "m-persist", "w-storage", "w-worklist", "v-mip", "v-mpr", "a-model", "a-card", "w-deid", "r-template", "r-structured-score", "a-calcium"] },
  { id: "code", title: "Sıradaki mühendislik işleri (kodla yapılabilir)", timeframe: "1–3 ay", goal: "Kalan teknik boşluklar.", itemIds: ["v-vr", "v-mpr", "f-codec", "m-shapes", "r-export", "w-pacs", "v-perf", "v-hanging", "f-objects"] },
  { id: "ai", title: "Gerçek model ve doğrulama", timeframe: "3–9 ay", goal: "Lisanslı/doğrulanmış modeller + kendi verinizde ölçüm.", itemIds: ["a-model", "a-heat", "a-uncert", "t-validation", "a-track", "a-prior"] },
  { id: "org", title: "Kurum/üretici süreçleri (kodla bitmez)", timeframe: "Sürekli", goal: "Düzenleyici uyum, NES, altyapı ve entegrasyon sözleşmeleri.", itemIds: ["t-mdr", "r-esign", "t-privacy", "w-his", "a-notify", "w-pacs"] },
];

/**
 * Eski serbest "kaynak listesi" kaldırıldı: kaynaklar artık satır bazında
 * `src/lib/gapSources.ts` kayıt defterinden gelir (doğrulama tarihi + yöntemi ile).
 */

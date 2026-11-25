# ATIKVIEWER — 2026 Piyasa Eksikleri ve Ürün Fikirleri

> Bu belge, [PIYASA_ANALIZI.md](PIYASA_ANALIZI.md) ve uygulamadaki **📊 Kıyaslama**
> (`/kiyaslama`) ekranını tamamlar. Amaç: “piyasada var ama bizde yok/kısmi olan”
> her işi tek yerde toplayıp, her biri için **neyi, neden, nasıl** sorusuna somut
> yanıt vermektir.
>
> **Sabit kural:** Tüm özellikler araştırma/demo çerçevesindedir; klinik doğrulama
> olmadan tanı/ölçüm olarak sunulamaz ve “hekim onayı” zorunluluğu bozulmaz.
> Bu listedeki öğeler ürün yol haritası adayıdır, klinik iddia değil.

### AI Triaj İş Listesi (araştırma/demonstrasyon)

Çalışma listesinde **AI Triaj** sekmesi, onaylı iş durumunda olmayan çalışmaları
mevcut AI skoruna göre gösterir; analiz edilmemiş ve simüle edilmiş kayıtlar
açıkça işaretlenir. Liste en fazla 500 kayıt içerir, daha fazla kayıt varsa
uyarı verir. Skor çalışma kaydındaki son analiz veya rapor bilgisinden gelir; bulgu gerekçesi, bağımsız
karar kaydı ve gerçek zamanlı güvenlik ağı bu sürümde yoktur. İş durumu ile
rapor durumu farklı olabilir ve ayrı gösterilir. Statik demo sunucu kuyruğunu
desteklemez. AI sıralaması klinik olarak doğrulanmış değildir ve bir çalışma
listede yoksa veya düşük sıralanmışsa güvenli olduğu anlamına gelmez.

### İlerleme ölçümü ve Dependency Graph

Kıyaslama ekranındaki durumlar elle gözden geçirilir. Tamamlanan madde oranı
`var / toplam`dır; durum endeksi `var=1, kısmi=0,5, yok=0` ağırlıklarıyla
hesaplanır. Endeks gerçek çalışma yüzdesi veya klinik uygunluk değildir. Kısmi
olan bir maddenin gerçek yüzdesi ölçülmemiştir.

G3 hâlâ kısmi: PR dependency-review daha önce `continue-on-error` nedeniyle
başarısız olsa da yeşil görünüyordu; artık hata gizlenmez. Dependency Graph
etkinleştirildi: 25 Kasım 2026'da SBOM API'si 602 paket döndürdü ve PR #21'de
**Bağımlılık denetimi** adımı başarıyla tamamlandı. Bu PR'da bağımlılık farkı
olmadığından, açık içeren bir değişikliğin tespit edilmesi ayrıca sınanmadı.
SBOM imzalama ve kurumsal HSM gibi kalan işler nedeniyle G3 kısmi kalır.

### P0 — kimlik giriş kaydı (w-auth)

Son başarılı giriş zamanı yalnız parola ve gereken MFA doğrulandıktan ve oturum
imzalanabildikten sonra güncellenir. Yanlış parola/MFA, MFA kurulmamış hesap ve
imzalama anahtarı yokluğu zaman damgasını değiştirmez. PostgreSQL destekli CI
entegrasyon testi bu durumları ve oturum çerezini denetler. Bu değişiklik hesap
kilitleme, oturum iptali veya kurumsal kimlik entegrasyonunu sağlamaz; P0 madde
kısmi kalır ve demo modu gerçek kullanıcı kimliği doğrulamaz.

## 0.0c Ölçüm geçmişi, RADPEER ve model kayıt defteri

**Ölçüm geçmişi (c-measure-history → var).** `measurement_history` tablosu hasta,
çalışma, seri, etiket, tür, değer, birim ve kesit taşır; `/api/measurements` GET/POST
uçları hasta bazlı okuma ve aynı hasta+çalışma+seri için değiştirme yapar (birim
beyaz listesi, pozitif/sonlu değer, denetim kaydı). Araç çubuğundaki **📈 Trend**
paneli etiket bazında zaman serisi, mini grafik, yüzde değişim ve ikilenme süresi
gösterir; bu çalışmanın uzunluk/alan/elipsoid hacim/HU/SUV ölçümlerini kaydeder.
Saf hesap `src/lib/measureHistory.ts`; `tests/measure-history.test.ts` mm/mm²/mL
dönüşümünü, tarih sıralamasını, %değişimi, ikilenmeyi ve %5 stabil eşiğini sınar.

**RADPEER (d-peer → var).** `src/lib/radpeer.ts` puan eşlemesi (1/2a/2b/3), oran ×
toplam hedef örneklem, güne bağlı deterministik seçim, kendi raporunu ve zaten
değerlendirdiğini dışlama, uyuşmazlık istatistikleri ve %95 Wilson aralığı içerir.
`/api/peer-review/sample` ve `/api/peer-review/stats` uçlarını araç çubuğundaki
**⚖ Peer** paneli gösterir. Hedefe ulaşılamazsa uydurma seçim yapılmaz. Test:
`tests/radpeer.test.ts` (2000 konuluk kohortta sapma <5 puan).

**Model kayıt defteri (a-modelops, kısmi).** `model_registry` tablosu model
anahtarı, sürüm, aşama (aday/gölge/aktif/emekli), trafik %, artifact özeti ve
notları tutar; `/api/models` (yalnız yönetici) aşama/trafik kurallarını doğrular ve
her değişikliği önce/sonra ile denetim kaydına yazar. `/yonetim → Model kayıt
defteri` sekmesinden sürüm kaydedilir, gölgeye alınır veya emekliye ayrılır. A/B
planı ve konu karmasına bağlı atama `src/lib/modelRegistry.ts` içindedir
(`tests/model-registry.test.ts`). Kısmi kalma nedeni: atama gerçek çıkarım isteğine
bağlı değil ve sürüm bazlı canlı metrik toplanmıyor.

**Doğrulama sınırı:** bu ortamda PostgreSQL yok; ölçüm geçmişi, RADPEER ve model
kayıt defteri uçlarının uçtan uca (DB'li) testi çalıştırılamadı. Saf mantık ve
istemci eşlemeleri test edildi; DB'li CI adımları `test:review`/`test:folder` gibi
mevcut entegrasyon testleriyle birlikte koşar.

## 0.0b Performans hattı: GPU pencereleme + Web Worker (v-perf)

`v-perf` kısmi kalıyor ama iki büyük kalem kapandı. **GPU:** `src/lib/webglWindow.ts`
işaretli 16 bit kesiti `R16I` dokusuna yükler, WL/WW'yi parçacık gölgelendiricisinde
uygular; pencere alt sınırı tam sayı değilse veya çıktı CPU referansından
(`windowSampleGray`) ±1'den fazla saparsa GPU yolu kendini kapatır ve CPU yolu
kullanılır — yanlış gri tonu gösterme riski yoktur. **Worker:** `src/workers/window.worker.ts`
≥1 MP kesitleri ana iş parçacığı dışında çevirir; piksel kopyası transfer edilir
(seri verisi sahipsiz kalmaz), RGBA tamponu geri transfer edilir. Worker yoksa,
CSP engellerse, hata verirse veya 2,5 s'de yanıt gelmezse aynı hesaplama ana iş
parçacığında yapılır. GPU yolu etkinken komşu kesitlerin CPU ön-işlemesi atlanır.

Doğrulama: `tests/perf-window.test.ts` gölgelendirici formülünü LUT ile
karşılaştırır (`windowGrayFromIndex`, `windowSampleGray`), worker sözleşmesini
(kaynak denetimi) ve tarayıcısız ortamda CPU yedeğinin birebir aynı sonucu
verdiğini sınar. Ölçüm: `npm run bench:window`.

Kalan: float32/işaretsiz seriler için GPU, gerçek ilerlemeli decode
(çok çözünürlüklü piramit) ve Int16 bellek düzeni.

## 0.0a Bu turda kapatılan madde: etkileşimli segmentasyon (m-seg)

`m-seg` **kısmi**den **var**a geçti. Kütüphane zaten vardı; eksik olan tuval üstü
düzenleme arayüzüydü. Eklenenler: araç çubuğunda **🧩 Segment** düğmesi,
`src/components/SegmentationEditor.tsx` (fırça, silgi, HU eşik dolgusu, tohumdan
bölge büyütme, kesit kopyalama, kesit/tüm maske temizleme, 12 adımlı geri al, renk
ve opaklık), `Viewport` içinde AI aday örtüsünden bağımsız `OverlayData.manual`
katmanı, alt bilgi çubuğunda mL hacim ve aynı maskeden DICOM SEG/RTSTRUCT indirme.

Doğrulama: `tests/seg.test.ts` tuval→piksel eşlemesini (`screenToImage`, kırpma
dahil), hızlı fırça darbesinde boşluk kalmamasını (`paintStroke`), geri alma
kopyasının bağımsızlığını (`cloneMask`) ve SEG/RTSTRUCT gidiş-dönüşünü sınar.
`tests/seg-editor-browser.cjs` (`npm run test:seg-ui`) gerçek tarayıcıda fırça,
eşik, geri al, kesit kopyalama ve mL hacmin ana görünümleyiciye aktarımını
denetler; Playwright tarayıcı ikilisi kurulu olmayan ortamda çalışmaz.

Kalan iş (neden hâlâ tam puan değil): AI/SAM aday maskesini düzenlemeye açma
(tohumlama) ve kesit kesit hacim trendi yoktur; RTSTRUCT konturları satır
taramasıyla üretildiği için konkav segmentlerde dış zarfa yaklaşır. Maske hekim
düzenlemesidir, rapora otomatik yazılmaz ve AI aday örtüsü düzenlenebilir maske
değildir.

Bu turun sonunda kıyaslama verisi **101 madde — 43 var / 58 kısmi / 0 yok**
durumundadır (turun başında 101 / 40 / 61). `/kiyaslama` sayfası bu sayıları
`gapAnalysis.ts` verisinden üretir; yayındaki sayfalar ancak yeni sürüm
yayımlandığında güncellenir.

## 0.0 Bu turda açılan yeni hat: radyasyon dozu (RDSR)

Piyasa listesinde ayrı bir madde olmayan, ama doz yönetimi ürünlerinin (DoseWatch
vb.) çekirdeğini oluşturan **RDSR okuma** işine başlandı. `src/lib/dose.ts` DICOM
X-Ray Radiation Dose SR (SOP Class `1.2.840.10008.5.1.4.1.1.88.67`) içeriğini
ayrıştırır: ışınlama olaylarından CTDIvol/DLP, olay yoksa accumulated toplamlar;
eksik değer **tahmin edilmez**, uyarı olarak yazılır. Panel (`☢ Doz`) dosyayı
tarayıcıda okur (sunucuya göndermez), DLP × bölge katsayısıyla yaklaşık etkin doz
gösterir ve **örnek** DRL değerleriyle oran karşılaştırması yapar (değerler
kullanıcı tarafından düzenlenebilir, doğrulanmamıştır). Sentetik RDSR gerçek DICOM
baytlarıyla yazılıp dicom-parser + SR ayrıştırıcısından geri okunur (`npm run test:dose`).

Kalan iş (kısmi kalma nedeni): hasta/modalite bazında sunucuda doz birikimi ve
trend, uyarı eşikleri, PACS'ten otomatik RDSR çekme ve ulusal/kurumsal DRL
tablosunun onaylı sürümü. Etkin doz ve DRL karşılaştırması klinik kanıt değildir.

## 0.0b Erişilebilirlik ve kısayollar

Klavye kısayolları artık sunucudaki kullanıcı tercihine bağlıdır ve çakışmalar
`src/lib/shortcuts.ts` içinde çözülür; `?` erişilebilir yardım tablosunu açar.
“İçeriğe geç” bağlantısı, görünür odak halkaları, `aria-live` bildirim, yüksek
kontrast teması ve hareket azaltma eklendi. Kalan: ekran okuyucuyla uçtan uca
bağımsız denetim, ölçek/yazı tipi seçenekleri ve WCAG 2.2 AA doğrulaması
(kurum/bağımsız denetim) — bu nedenle `i-a11y` kısmi kalır.

## 0. Nasıl okunur

| Öncelik | Anlamı |
|---|---|
| **P0** | Olmadan ya ürün eksik kalır ya güvenlik/açığı vardır |
| **P1** | Rakip dezavantajı yaratır; klinik iş akışında görünür |
| **P2** | Kalite/kapsam artırır; fark yaratır |
| **P3** | İyi olur, öncelikli değil |

Çabalar: **S** (hafta), **M** (1–3 ay), **L** (3+ ay).

---

## 0.1 Modalite bazında donanım durumu (tarama)

Görüntüleme altyapısı (füzyon, ölçüm, pencere, hanging protocol) tüm modalitelerde
ortaktır; **MPR/MIP/VR henüz yoktur**. Modaliteye özel **AI bulgu motoru** ve
**rapor şablonu** kapsamı aşağıdadır:

| Modalite | Görüntüleme | AI bulgu/analiz | Rapor şablonu | Asma protokolü |
|---|---|---|---|---|
| CT | Tam (pencereler, kalibrasyon, füzyon); MPR/MIP yok | **Yerel modeller:** toraks nodül (MONAI, bbox) + beyin İCH (6 sınıf, bbox) — hasta verisi dış ağa çıkmaz | 11 | BT Beyin / Toraks / Abdomen-Pelvis / Anjiyo / Ürotrakt |
| MR | Tam (sekans listesi, karşılaştırma, ölçüm) | **Yalnız görüntü incelemesi** (tanı üretmez) — MR'ya özel model yok | 17 | MR Çoklu Sekans (T1/T2/FLAIR/DWI düzeni) |
| CR / DX | Tam (PA/lateral düzeni, teknik kalite kontrolü) | **Yerel derin model:** Medical_X DenseNet121 (Apache-2.0) — 14 torasik bulgu olasılığı + Grad-CAM ısı örtüsü; CTR hesaplayıcı. Lokalizasyon kutusu YOK, skorlar kalibre değil, klinik doğrulaması yok | 2 | Direkt Grafi |
| US | Tam (cine + renkli Doppler) | TI-RADS skor paneli; tanı motoru yok | 6 | Yok |
| MG | Tam (RCC/LCC/RMLO/LMLO 2×2) | BI-RADS/ACR yoğunluk paneli + DBT şablonu; otomatik yoğunluk algılama yok | 3 | Mamografi |
| PET / NM | Füzyon + SUVbw | TIC/DSA/MTV yok | 1 | PET-CT füzyon |

> **Toplam 42 hazır şablon.** Her şablonda `indication` (endikasyon) ve `protocol`
> (önerilen sekans/düzen) alanı vardır; rapor ekranında modaliteye göre aranabilir.

Notlar:
- **MR raporu yazılabiliyor**: rapor penceresi her seride açılır, teknik metin MR'e
  uyarlanır, 24 hazır şablonun 13'ü MR (beyin, boyun, dorsal omurga, diz, kar,
  abdomen, pelvis, MRA, DWI/kontrast şablonları). Eksik olan, MR'ya özel
  tanı/ölçüm motorudur (örn. difüzyon restriksiyonu otomatik skoru).
- Pencere ön ayarları artık tüm modalitelerde listelenir (daha önce yalnız CT'deydi).

---

## A. Klinik yapay zekâ ürün fikirleri

| ID | Özellik | P | Çaba | Piyasa örneği | Bizde şu an | Fikir / nasıl yapılır |
|---|---|---|---|---|---|---|
| A1 | **Akciğer grafisi/filitrio AI** (pnömotoraks, effüzyon, konsolidasyon, katlak, TB) + ısı haritası | P1 | M | Lunit, Aidoc, Gleamer | **Bu sürümde kısmen:** CTR hesabı + CXR teknik kalite modülü (`src/lib/cxr.ts`: projeksiyon, inspirasyon, rotasyon, penetrasyon → rapora teknik satır); tanısal sınıflandırma ve ısı haritası hâlâ yok. | Kalan: CXR ONNX modeli + bbox/Grad-CAM (ağırlık kaynağı kararı gerekli); bulgu onay akışına bağlanır.
| A2 | **İnme paketi: ASPECTS + CTP perfüzyon** (CBF/CBV/MTT/Tmax, core/penumbra) | P1 | L | Viz.ai, Aidoc | **Bu sürümde kısmen:** ASPECTS 10 bölge skoru panelde işaretlenir; `stroke.ts` basitleştirilmiş CTP özeti (TTP/gecikme, CBF/CBV oranları, core/penumbra adayı). Dekonvolüsyon/AIF seçimi yoktur. | Kalan: model tabanlı AIF + dekonvolüsyon; injeksiyon öncesi/sonrası seri eşleme.
| A3 | **MSK/X-ışını kırık ve landmarke AI** | P2 | L | Gleamer | Yok (görüntü ölçümü var) | Öncelikle açık-kinelig/veya bölge sınıflandırma + heatmap; el/omurGAĞI/ayak Landmarke nokta önerisi. |
| A4 | **Mamografi: BI-RADS yoğunluk + DBT (tomosentez)** | P2 | L | Lunit, iCAD | “MG modu” olduğu belgelenmiş ama yoğunluk/DBT özel akışı yok | CC/MLO layout + DBT slab navigasyonu + BI-RADS a/b/c/d yoğunluk önerisi; PI-RADS/Radslex benzeri sözlük. |
| A5 | **Kalsiyum skoru (Agatston) + kemik yoğunluğu** | P2 | M | Aidoc | **Bu sürümde kısmen uygulandı:** `src/lib/structuredReport.ts` içinde damar bazlı Agatston (HU ağırlıkları, ≥1 mm² alan eşiği, S0–S4 kategori) + oportünist L1–L4 trabeküler HU kategorisi; rapor panelinden hekim ölçü değerleri girer. Otomatik piksel segmentasyonu yok. | Kalan: piksel bazlı otomatik kalsiyum/segmentasyon modeli + DEXA korelasyonu. |
| A6 | **Akciğer kvantifikasyonu: lob/emphisema (LAA-950)/volüm** | P2 | L | 3D Slicer, Aidoc | **Bu sürümde eklendi:** histogramdan LAA-950, ortalama HU, PD15 ve hacim mL (`lungQuant.ts`); sınıf normal–hafif/orta/ağır. Lob segmentasyonu yok. | Kalan: lob segmentasyonu (kural/SAM) + kesit/3B dağılım grafiği.
| A7 | **Nükleer tıp: DSA çıkarma, TIC, MTV/SUVpeak** | P3 | L | RadiAnt, Hermes | **Bu sürümde eklendi:** pre/post subtraksiyon özeti, TIC modeli (wash-out/plato/progressif) ve SUV haritasından MTV/SUVpeak (`nuclear.ts`). | Kalan: gerçek rekonstrüksiyon kalibrasyonu + 3B metabolik hacim görselleştirmesi.
| A8 | **Model operasyonları: kayıt, A/B, kalibrasyon, drift** | P2 | L | Tüm üreticiler | **Bu sürümde eklendi:** güven kalibrasyonu (binler + ECE), z tabanlı drift kontrolü, model parmak izi (`modelOps.ts`); `/api/ai/performance` kalibrasyon/ECE dönüyor. Kayıt defteri tablosu yok. | Kalan: model kayıt defteri + A/B dağıtımı ve denetim kaydı.

**Hızlı kazanç:** A1’in ilk sürümü (CXR sınıflandırma + heatmap) mevcut `ai-worker` mimarisine doğal uyar; `Finding`/`bbox`/onay akışı hazır. A5 (Agatston) kural tabanlı olduğu için en düşük riskli nicel modüllerden biridir.

---

## B. Görüntüleme ve post-processing

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| B1 | **Kavisli MPR + damar/omurga merkez hattı** | P1 | M | Oblik MPR var; curved yok | IP/centroid algoritmasıyla merkez hattı örnekleme; oblik panele bağlama. |
| B2 | **3B imleç / tıklayınca diğer panele atlama** | P1 | M | Cross-reference çizgileri kısmi; tıklayınca senkron yok | İMPP koordinatını diğer serilerde konuma çevir; “git” olayı. |
| B3 | **Cinematic / fotorealistik VR, kırpma kutusu, kemik çıkarma** | P2 | M | WebGL VR var; kırpma/kemik çıkarma yok | Transfer fonksiyonu genişlet; clip plane + marching cubes ile kemik yüzeyi. |
| B4 | **Çoklu monitör, dokunmatik, stack scroll, referans çizgileri** | P3 | S–M | Tam ekran var; geri kalanı yok | Fullscreen API + window.open port paylaşımı; pointer pinch; scroll-wrap modu. |
| B5 | **Airway analizi** (trakea/bronş çapı) + **dual-energy/spectral** ipuçları | P3 | M | Yok | Merkez hat + çap ölçümü; spectral BT’de virtual non-contrast/iodine haritası (iki enerji serisi gerektirir). |

**Hızlı kazanç:** B4’ün tam ekran/çoklu pencere kısmı küçük ve kullanıcı algısını büyütür.

---

## C. Ölçüm, segmentasyon ve standart çıktılar

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| C1 | **Yapılandırılmış ölçümler: DICOM SR TID 1500 + RadLex/RSNA CDE** | P1 | M | Basic Text SR üretiliyor; ölçüm/CDE kodlaması yok | Ölçüm modellerini TID 1500 measurement container’ına taşı; RadLex OID eşlemeli sözlük. |
| C2 | **Segmentasyon editörü + DICOM SEG/RTSTRUCT dışa aktarma** | P1 | M | Motor aday maskesi salt-okunur | Fırça/eşik/SAM ile düzenleme; hacim; SEG/RTSTRUCT üretimi; rapora aktarım. |
| C3 | **RECIST tamamlayıcıları:** lenf nodu (kısa eksen), non-hedef lezyon, çalışmalar arası otomatik eşleştirme | P1 | M | **Bu sürümde eklendi:** anatomi+konom eşleştirme (`lesionTracking.ts`; sayı içeren ifadelerde birebir eşleşme), lenf nodu kısa eksen tablosu (<10 normal / 10–<15 takip / ≥15 patolojik), non-hedef lezyon durumu. | Kalan: hedef lezyon seçimi/limitleme arayüzü ve karşılaştırma raporu.
| C4 | **Key Object / GSPS / SR / SEG / RTSTRUCT’ı PACS’a geri gönderme** | P1 | M | Dışa aktarma var; PACS’a gönderme yok | Bkz. E2. |
| C5 | **Ölçüm geçmişi ve trend grafikleri** (çap/HU/SUV zaman serisi) | P2 | M | Nodül takibi tarayıcıda; ölçümler rapora | Ölçümleri `study_state`’e yapılandırılmış kayıt olarak yaz; sunucu tarihçesi + grafik. |

---

## D. Raporlama ve kapanış döngüsü

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| D1 | **Kritik sonuç kapanış döngüsü:** ACK + iletim kanıtı + eskalasyon kaydı | P1 | M | Bildirim “alındı” var; kim/süre/eskalasyon ve iletilme kanıtı yok | Zaman damgalı ACK, okundu/iletildi kanıtı, hekime tekrar hatırlatma, denetim satırı. **Bu sürümde kısmen uygulandı:** `notifications.relayedTo`/`relayedAt`/`escalated`/`escalatedAt` + zil üzerinde “İletildi…/Eskalasyon” ve `notify.relay` denetim kaydı; süre hatırlatması yok. |
| D2 | **Takip önerilerini iş listesine taşıma** | P1 | S | Öneri raporda kalıyor; görev kuyruğuna düşmüyor | “Takip önerisi” nesnesi: modalite/bölge/süre + durum; çalışma listesinde görünür. **Bu sürümde uygulandı:** onaylı raporun “Öneri” metni otomatik göreve dönüşür (`acik/tamamlandi/iptal`), gün/hafta/ay/yıl süresi ayrıştırılır; biyopsi/kritik ifadelerde önem derecesi ve varsayılan süre otomatik atanır (`followupText.ts`, `closeLoop.ts`). Yaklaşan tarih bildirimi yok. |
| D3 | **Peer review / ikinci okuma / uyuşmazlık kaydı (RADPEER)** | P2 | M | **Bu sürümde eklendi:** rapor ekranında ikinci okuma kartı + `peer_reviews` tablosu (sonuç/fark türü/not; uyumsuzda açıklama zorunlu). | Rastgele örnekleme oranı, uzun vadeli uyuşmazlık istatistikleri ve RADPEER puanlama.
| D4 | **Ambient dokümantasyon + yapılandırılmış makrolar** | P2 | M | **Bu sürümde kısmen:** 14 hazır makro bloğu rapor ekranından eklenebilir; ambient tıbbi sözlük yok. | Kalanlar arşiv/KMS ve SLSA attestation; log seviyesi ortam değişkenine bağlanacak.
| D5 | **ICD-10 / ACR Appropriateness / kodlama desteği** | P3 | S | Yok | Bulgu→ICD-10 öneri tablosu; istek uygunluğu sorgulama (RadPal benzeri). |
| D6 | **Hasta dostu sonuç mektubu (çok dilli)** | P3 | S | Hasta özeti var | PDF/e-posta çıktısı; okuma düzeyi seçeneği. |
| D7 | **Üretken AI’da hekim üslubu öğrenme + alıntı** | P2 | M | LLM taslak var; üslup yok | Hekim düzeltmelerinden stil öğrenimi (opsiyonel, gönüllü); çıktıda kesit referansları. |

**Hızlı kazanç:** D1 + D2 birlikte “kritik bulgu yönetimi” açısını kapatır; denetim zinciri zaten var.

---

### P1 — PACS gönderim doğrulaması (E1/E6)

STOW isteği tek bir DICOM nesnesi gönderir. HTTP 2xx tek başına başarı değildir:
PACS yanıtındaki kabul edilen SOP UID gönderilen nesneyle eşleşmelidir. Red,
karışık sonuç veya boş/ayrıştırılamayan yanıt başarılı gösterilmez; sonuç
belirsizse nesne PACS'te kaydedilmiş olabilir, yeniden göndermeden önce PACS'te
kontrol edilmelidir. Uygulama istemcisinin STOW/QIDO/WADO döngüsü Orthanc CI
testine eklenmiştir; yerel HTTP testleri red ve hatalı yanıtları da sınar.
Bu, dcm4chee veya hastane PACS uyumluluğunun kanıtı değildir. DIMSE desteği
açıktır; bu nedenle `w-pacs` kısmi kalır.

## E. Entegrasyon (PACS / HIS / IHE)

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| E1 | **DICOMweb STOW-RS / DIMSE C-STORE ile PACS’a gönderme** (SR, KO, anonim DICOM) | P1 | M | **Bu sürümde eklendi:** `/api/pacs/stow` + PACS istemcisinde `stowInstance()` (STOW-RS, onaylı rapor → DICOM SR). | Anahtar nesne (KO) ve anonim seri gönderimi; C-STORE.
| E2 | **WADO-RS URI + kare/bulk veri (frame-level) getirme** | P1 | S–M | Instance bazlı WADO var | `accept=multipart/related;type=image/jpeg;transfer-syntax=*`, frame parametresi, `bulkdataURI`. |
| E3 | **HL7 v2 MLLP alıcısı + Modality Worklist (MWL)** | P1 | L | **Bu sürümde eklendi:** MLLP alıcısı (`npm run hl7:mllp`) + HL7 ayrıştırıcı; ORM^O01 siparişini `/api/his/orders`'a çevirip ACK döner. | ADT/değişiklik mesajları ve MWL SCP (C-FIND).
| E4 | **FHIR girişi: ServiceRequest/ImagingStudy/P Çekici** | P2 | M | Çıktı FHIR DR var; giriş yok | FHIR client (kimlik/OAuth), sipariş→çalışma, ImagingStudy→WADO URL eşlemesi. |
| E5 | **IHE profilleri (SWF, AI Results, DICOMweb)** | P2 | L | Yok | Önce SWF (scheduled workflow) + AI Results Storage Profile. |
| E6 | **Gerçek PACS ile uçtan uca test** (Orthanc/dcm4chee) | P1 | S | **Bu sürümde uygulandı:** `tests/pacs.orthanc.e2e.ts` gerçek Orthanc'ta STOW yükle → QIDO bul → WADO geri al → temizlik; CI `pacs-e2e` işi ve `docker compose --profile pacs`. | Kalan: dcm4chee ile de çalıştırma; CI'da C-FIND/C-MOVE ve anonimleştirilmiş DICOM gönderimi. |

---

## F. İş akışı, kullanıcı ve kurumsal özellikler

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| F1 | **Kimlik:** kullanıcı adı/parola + MFA + oturum zaman aşımı (SSO sırasıyla) | P0 | L | ACCESS_TOKEN tek kapıydı; parola/oturum/MFA yoktu | **Bu sürümde minimum uygulandı:** `AUTH_MODE=hesap` ile scrypt parola, imzalı oturum çerezi (8 saat), TOTP/MFA (`otplib`), `REQUIRE_TOTP_FOR_ROLES`. Kalan: SSO/OIDC/LDAP/SAML entegrasyonu. |
| F2 | **RBAC detayı:** radyolog/teknisyen/arator/yönetici + hekim profilleri | P0 | M | Tek operatör profili; `authorize()` rolleri yok sayıyordu | **Bu sürümde uygulandı:** `yonetici/radyolog/teknisyen` rol denetimi tüm API uçlarında aktif, Yönetim → Kullanıcılar (ekle/rol/pasif/parola sıfırla). Kalan: arator rolü ve hekim profil çoklu üyelikleri. |
| F3 | **Kullanıcı başına tercihler** (layout, preset, kısayol) sunucuda | P2 | S–M | **Bu sürümde eklendi:** `/tercihler` sayfası + `/api/profile/preferences`; açılış düzeni uygulanır. | Kalanlar arşiv/KMS ve SLSA attestation; log seviyesi ortam değişkenine bağlanacak.
| F4 | **Turnaround/istatistik panosu** (TAT, bulgu/adet, onay süresi) | P2 | M | **Bu sürümde eklendi:** `/api/reports/stats` + Yönetim > İş akışı (TAT medyan/p90, durum/modalite dağılımı, eski taslak). | Haftalık trend grafikleri ve hedef eşik uyarıları.
| F5 | **Toplu/arka plan içe aktarma kuyruğu** | P2 | M | Tek seri akışı | Kuyruk tablosu + ilerleme; başarısız yeniden deneme. |
| F6 | **Paylaşım:** süreli bağlantı + watermark + denetim | P2 | M | **Bu sürümde eklendi:** `/paylas/{token}` filigranlı salt okunur sayfa + `share_links` tablosu; 1–30 gün süreli, kapatılabilir, erişim sayaclı ve denetimli (rapor metni + anahtar kesit). | Ham görüntü/DICOM paylaşımı için imzalı URL ve nesne depolama adaptörü.
| F7 | **Hasta CD’si / ISO** (DICOM CD, otomatik görüntüleyici) | P3 | M | ZIP + kurulum var | ISO üretimi + DICOMDIR + autostart viewer. |

---

## G. Güvenlik, uyum ve gözlem

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| G1 | **Web hardening:** CSP, X-Frame-Options, CSRF koruması, rate limiting | P1 | S–M | **Bu sürümde kısmen:** nosniff, Referrer-Policy, COOP/CORP, Permissions-Policy ve CSP (`frame-ancestors 'self'`) tüm yanıtlara; no-store. Rate limiting ve CSRF token yok. | Kalan: IP/kullanıcı bazlı hız sınırı + state-değiştiren uçlar için CSRF koruması.
| G2 | **Denetim dışa aktarımı** (Syslog/CEF/JSON) + uzun vadeli arşiv | P2 | M | **Bu sürümde:** `/api/audit/export` (JSON/JSONL/CEF, yönetici only, zincir doğrulamalı) + UDP CEF (syslog). | Kalanlar arşiv/KMS ve SLSA attestation; log seviyesi ortam değişkenine bağlanacak.
| G3 | **Tedarik zinciri:** CodeQL, SBOM, imzalı derleme (SLSA), dependency review | P1 | M | **Bu sürümde:** CodeQL, SBOM (release'a yüklenir), PR'de dependency-review; imzalı derleme yok. | Kalanlar arşiv/KMS ve SLSA attestation; log seviyesi ortam değişkenine bağlanacak.
| G4 | **Yedek/geri yükleme/DR + nesne depolama adaptörü** (S3/MinIO) | P1 | L | Dosya sistemi; elle yedek | Depolama arayüzü + S3/MinIO; `pg_dump` playbook’u, DR tatbikatı. |
| G5 | **KMS/anahtar rotasyonu** (yazılımsal KMS, otomatik rotation) | P1 | M | Anahtar env dosya; rotasyon yok | Arayüz + rotasyon akışı; eski anahtarla çöz, yeniyle şifrele. |
| G6 | **Gözlem:** Prometheus metrik, yapılandırılabilir log, readiness/liveness ayrımı | P2 | M | **Bu sürümde:** `/api/metrics` (Prometheus) + liveness/readiness ayrımı; yapılandırılabilir log yok. | Kalanlar arşiv/KMS ve SLSA attestation; log seviyesi ortam değişkenine bağlanacak.
| G7 | **Uyum günlüğü:** MDR/TİTCK/FDA sınıflandırma, ISO 13485/62304/14971 takibi | P0 (kurum) | L | Yönetim → Uyum kontrol listesi var | Dokümantal süreç; kodla kapatılamaz. |

---

## H. Araştırma ve model işletimi

| ID | Özellik | P | Çaba | Fikir |
|---|---|---|---|---|
| H1 | Etiketleme/annotasyon platformu (fırça, sikayet, ekib) | P2 | L | Mevcut çizim katmanı genişletilir; etiket bloğu DB’de. |
| H2 | Kohort oluşturma / de-id pipeline / veri kuruluşu | P2 | L | Anonim DICOM export + indeks; kohort dışa aktarım. |
| H3 | Model eğitim/değerlendirme hook’u + model kayıt defteri | P2 | L | ai-worker’a evaluate/batch infer; model kartı hash/sürüm. |

---

## I. Mobil, erişilebilirlik ve yerelleştirme

| ID | Özellik | P | Çaba | Fikir |
|---|---|---|---|---|
| I1 | PWA + çevrimdışı okuma (service worker, cached series) | P2 | M | Viewer bundle statik; API’ler çevrimdışı shim’e benzer yaklaşımla. |
| I2 | WCAG: klavye taraması, ekran okuyucu etiketleri, yüksek kontrast | P2 | M | Temel aria’lar var; eksik. |
| I3 | TR/EN (ve diğer) arayüz çevirisi | P2 | M | Şu an tek dil; sabit metinler çevrilebilir. |

---

## J. Önerilen 90 günlük yol haritası

1. **1–2 hafta — güvenlik/altyapı (P0/P1):** F1/F2 kimlik minimumu, G1 hardening, G3 CodeQL/SBOM, E6 gerçek Orthanc testi, `.gitattributes` + migration stratejisi.
2. **3–6 hafta — klinik iş akışı:** D1 kapanış döngüsü, D2 takip önerisi, C3 RECIST tamamlayıcı, C1/C2 SR TID 1500 + SEG/RTSTRUCT, E1/E2 PACS gönderme/alma.
3. **6–12 hafta — AI ürünleşme:** A1 CXR + heatmap, A2 ASPECTS/CTP, A5 kalsiyum skoru, C5 ölçüm geçmişi, H3 model operasyonları.
4. **Sürekli:** G7 uyum, G4 yedek/DR, I2 erişilebilirlik.

### Açık karar noktaları (sana sorulacaklar)

- Kimlik minimumu mu (erişim anahtarı) yoksa kurumsal SSO mu hedefleniyor?
- PACS entegrasyonunda öncelik **okuma (WADO/STOW)** mı, **yazma (C-STORE)** mı?
- Yeni AI modülleri için lisanslı model mi, kendi verimizle eğitilen model mi?
- Küçük politika: `docs/PIYASA_ANALIZI.md`’deki “bizde eksik” tabloları ile bu liste
  senkron tutulmalı; yeni özellik eklenince `/kiyaslama` öğesi güncellenir.
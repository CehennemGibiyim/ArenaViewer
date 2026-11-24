# Risk Yönetimi Dosyası (ISO 14971 yaklaşımı)

> **Bu belge bir risk yönetimi dosyası taslağıdır; nihai ve hukuki geçerliliği olan
> dosya üretici kurum tarafından onaylanmalıdır.** Yazılım **tıbbi cihaz değildir** ve
> klinik karar için kullanılamaz; bu dosya demo/araştırma kullanımındaki azaltıcı
> kontrolleri ve kurumsal yükümlülükleri tarif eder.

Risk puanı: **Olasılık** (1 nadir, 2 olası, 3 sık) × **Şiddet** (1 hafif, 2 orta,
3 ciddi). Puan ≥ 6 kabul edilemez sayılır; azaltıcı kontroller sonrası kalan risk
(RR) tabloya yazılmalıdır.

## 1. Genel (tüm modaliteler)

| # | Tehlike | Olası hasar | O | Ş | ÖKP | Azaltıcı kontroller | RR |
|---|---------|-------------|---|---|-----|----------------------|----|
| G1 | AI yanlış negatif → erken tedavi ertelenmesi | Morbidite/artış | 2 | 3 | 6 | Tüm AI bulgusu “aday” etiketli; hiçbir bulgu “normal” demez; radyolog raporu zorunlu; boş sonuç uyarısı. | 4 |
| G2 | AI yanlış pozitif → gereksiz ek tetkik/anksite | maliyet, radyasyon | 3 | 1 | 3 | Skor/eşik açıkça yazdırılır; kalibre edilmemişskor uyarısı; hekim onayı zorunlu. | 2 |
| G3 | Otomasyon yanlılığı (automation bias): hekim AI’yı körü körüne benimser | tanı hatası | 2 | 3 | 6 | Bulgu sayısı/teknik açıklamalar raporda; model kartı (sınırlılıklar); zorunlu gözden geçirme; “YAPAY ZEKA ÇIKTISIDIR” ibaresi. | 4 |
| G4 | Görüntü kalitesi/protokol uyuşmazlığı → AI performansı düşer | yanlış skor | 2 | 2 | 4 | CXR teknik kalite modülü (projeksiyon/kosta/rotasyon/penetrasyon); BT için HU/boyut denetimi. | 3 |
| G5 | Hasta verisinin yetkisiz erişime açılması | KVKK ihlali | 1 | 3 | 3 | Oturum/parola, rol matrisi, erişim kapısı, AES-256-GCM at-rest, denetim zinciri. | 2 |
| G6 | Veri bozulması/yitimi | rapor kaybı | 1 | 2 | 2 | Kalıcı depolama + SHA-256 denetimi + yedekleme (kurum). | 2 |

## 2. CXR sınıflandırma (Medical_X DenseNet121, Apache-2.0)

Kaynak: NIH ChestX-ray14 (zayıf NLP etiketli, dengesiz sınıf dağılımı); kaynağın
makro AUROC’u 0,851, en zayıf sınıf (Pnömoni) AUPRC 0,054. Model lokalizasyon kutusu
**üretmez**; Grad-CAM ısı haritası “burada odağı var” gösterir, konum kesinliği yoktur.

| # | Tehlike | Olası hasar | O | Ş | ÖKP | Azaltıcı kontroller | RR |
|---|---------|-------------|---|---|-----|----------------------|----|
| C1 | Zayıf etiketli eğitim → sistemik hata (bias) | erken/tanı atlama | 2 | 3 | 6 | Model kartında eğitim seti ve bilinen sınırlar; kendi cohort’unda doğrulama zorunluluğu (bkz. KLINIK_DOGRULAMA_PLANI.md). | 4 |
| C2 | Seyrek sınıflarda yüksek FP (Hernia, Fibrozis vb.) | aşırı tetkik | 3 | 1 | 3 | Sınıf bazında eşik kaynaktan alınır; sınıf adı + olasılık + “aday” etiketi. | 2 |
| C3 | Tek kare/yanlış seri seçimi → yanlış girdi | yanlış skor | 2 | 2 | 4 | `cxrEligible` modalite/bölge/kare tutarlılığı denetimi; çok kareli seride yalnızca temsilci kare + uyarı. | 3 |
| C4 | AP/portatif grafide CTR ve kalite farkı | ölçüm sapması | 2 | 2 | 4 | Projeksiyon tanımı + “AP notu abartılabilir” uyarısı (cxr.ts). | 3 |
| C5 | Isı haritası yanlış alanı vurgular | yanlış yerleştirme | 2 | 3 | 6 | İstemci notu “lokalizasyon kutusu üretmez”; raporda ısı verisi saklanmaz (yalnızca oturumda görselleştirilir). | 4 |

## 3. BT toraks nodül (MONAI lung_nodule_ct_detection, Apache-2.0)

| # | Tehlike | Olası hasar | O | Ş | ÖKP | Azaltıcı kontroller | RR |
|---|---------|-------------|---|---|-----|----------------------|----|
| T1 | Küçük (<4 mm) nodülde düşük duyarlılık | takip atlaması | 3 | 3 | 9 | Doğrulama raporu (LUNA16), sentetik fantom sonuçları; Lung-RADS kılavuzuyla boyut eşiği; hekim onayı zorunlu. | 6 |
| T2 | HRCT olmayan seride yüksek FP | gereksiz tarama | 3 | 1 | 3 | Kural tabanlı motor iki aşamalı (konum + boyut); kesit maskesi + opaklık. | 2 |

## 4. BT beyin İCH (ianpan/ct-head-hemorrhage-detection, MIT)

| # | Tehlike | Olası hasar | O | Ş | ÖKP | Azaltıcı kontroller | RR |
|---|---------|-------------|---|---|-----|----------------------|----|
| I1 | Vaka duyarlılığı %43 (kendi doğrulamamız) | SAH/ICH atlama | 2 | 3 | 6 | Performans raporu açıkça yayınlanır; AI yalnızca acil triyaj desteği; radyolog her vakayı görür. | 4 |
| I2 | Kesit bazında çok düşük duyarlılık (%7,6) | bazı kanamalar görünmez | 2 | 3 | 6 | Kutu aralığı (kesit start/end) rapora yazılır; triyaj skoru + “DEĞERLENDİRİLMEDİ” durumu. | 4 |

## 5. Kurumsal yükümlülükler (kod kapatamaz)

- **Saklama/yedekleme**: G6’nın kalıcı kısmı kurum politikası; yedek tatbikatı.
- **Satış sonrası izleme**: AI performans kayıtları (`/yonetim → AI performans`) ve
  denetim zinciri olay bildiriminin girdisidir.
- **Risk işlemi**: Bu tablo değiştiğinde (model/modalite/veri kaynağı değişimi)
  güncellenmelidir. Model kartı ve doğrulama raporları bu dosyanın kanıtıdır.
- **Sorumlu kullanım**: Her raporda ve her bulgu satırında “hekim onayı zorunlu”
  ibaresi yer alır; kullanıcı eğitimi kurum içinde verilmelidir.

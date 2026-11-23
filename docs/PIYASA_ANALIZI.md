# ATIKVIEWER — Piyasa Analizi: Radyoloji Programları ve Eksiklerimiz

> Bu belge, 2026 itibarıyla incelenen görüntüleyici / PACS / radyoloji yapay zekâ
> ürünlerini ve ATIKVIEWER’daki karşılıklarını listeler.
> Canlı ve filtrelenabilir sürümü uygulamada: **📊 Kıyaslama → `/kiyaslama`**
> (kaynak bağlantılarıyla). Bu dosya sürüm kontrolü içindir.

## 1. Görüntüleyiciler (viewer)

| Ürün | Platform | Ücret | Öne çıkan | ATIKVIEWER’daki durum |
|---|---|---|---|---|
| **RadiAnt DICOM Viewer** | Windows | Ücretli (deneme) | Çok hızlı 2D, MPR, 3D VR, MIP/MinIP, füzyon, TIC | MPR/oblik MPR, MIP/MinIP, VR, füzyon var; **hız için Web Worker/GPU yolu yok** (kısmi) |
| **Weasis** | Win/macOS/Linux | Ücretsiz (açık kaynak) | DICOMweb, Key Object, SR/RT, hanging protocol, v4 3D | Key Object (KO) var, DICOMweb var (kısmi), 3D var |
| **OHIF Viewer** | Web | Ücretsiz (açık kaynak) | Sıfır kurulum, DICOMweb, eklenti mimarisi, MONAI Label | DICOMweb QIDO/WADO var (gerçek PACS ile denenmedi), eklenti mimarisi yok |
| **Horos / OsiriX** | macOS | Ücretsiz / OsiriX MD ücretli | Geniş eklenti ekosistemi, VR, füzyon | VR + füzyon var; eklenti mimarisi yok |
| **3D Slicer** | Tümü | Ücretsiz (araştırma) | Segmentasyon, registration, 4D | Segmentasyon elle çizilemiyor (motor maskesi var), **registration yok** |
| **MicroDicom** | Windows | Ücretsiz başlangıç | Hafif kurulum, DVD okuma | Taşınabilir ZIP + kurulum EXE var |
| **MedDream** | Web | Ücretli | Key Object, GSPS, CAD işaretleri, montaj | KO, GSPS, CAD adayları var |
| **syngo.via (Siemens)** | Masaüstü | Ücretli | Kapsamlı post-processing, okuma iş akışı | MPR/VR/ölçüm var; kurumsal iş akışı yok |
| **Sectra / Agfa IMPAX / Philips IntelliSpace / Fujifilm Synapse / GE Centricity** | Kurumsal PACS | Ücretli | Tam iş akışı, arşiv, raporlama entegrasyonu | **Kurumsal PACS değildir**; DICOMweb istemcisi + şifreli yerel depolama vardır |
| **Orthanc / dcm4chee** | Sunucu | Ücretsiz | DICOM sunucu | Docker compose ile dağıtılabilir; uygulama istemcidir |

## 2. Radyoloji yapay zekâ ürünleri

| Ürün | Odak | Öne çıkan | ATIKVIEWER’daki durum |
|---|---|---|---|
| **Aidoc** | Akut BT triyajı | Çalışma listesi önceliklendirme, çok kanallı bildirim, analitik | Triyaj skoru + sıralama + uygulama içi bildirim + webhook var; **e-posta/SMS/çağrı yok** |
| **Viz.ai** | İnme / nörovasküler | Ekip koordinasyonu, mobil push | Kritik bulgu bildirimi (uygulama içi + webhook) var; mobil push yok |
| **Lunit INSIGHT** | Akciğer grafisi + mamografi | Isı haritası, REST API | **Isı haritası (Grad-CAM) yok**; aday maskesi örtüsü var |
| **Annalise.ai** | Geniş kapsam (göğüs + beyin) | Tek geçişte çok bulgu | BT toraks (MONAI nodül) + BT beyin (ICH) derin modelleri **yerel ve ücretsiz** var; diğer modaliteler kural tabanlı |
| **Gleamer** | Travma/MSK + akciğer | Bayrak + hekim kabul/ret | Bulgu bazlı onay/red iş akışı var (sunucuda zorunlu) |
| **iCAD / Therapixel** | Mamografi | Kanser tespiti | Mamografi/DBT modu var (son çalışma); derin model doğrulaması yok |
| **Rad AI / RadPal / PowerScribe** | Rapor/izlenim | Dikte → yapısal rapor, hekim üslubu | Yapısal rapor, şablon, Türkçe dikte (Web Speech), taslak izlenim var; **LLM opsiyonel (Ollama, ücretsiz)**, üslup öğrenimi yok |

## 3. Bizde gerçekten eksik olanlar (dürüst liste)

### Kodla kapatılabilir (mühendislik işi)
1. **Isı haritası / Grad-CAM** (Lunit benzeri açıklanabilirlik) — model tarafı gerekir.
2. **İelle segmentasyon fırçası** (3D Slicer seviyesi) — Viewport’a çizim katmanı.
3. **Web Worker + kademeli yükleme** (1000+ kesit performansı).
4. **Gerçek PACS ile uçtan uca test** (Orthanc/dcm4chee; DIMSE C-FIND/C-MOVE).
5. **Lenf nodu kısa eksen ölçümleri ve non-hedef lezyon değerlendirmesi** (RECIST tamamı için).
6. **Çalışmalar arası otomatik lezyon eşleştirme** (takip incelemelerinde).
7. **E-posta/SMS/çağrı bildirim sağlayıcıları** (webhook köprüsü hazır).
8. **MPEG/JPEG-XL codec desteği.**
9. **HL7 v2 MLLP alıcısı** (HBYS istem bilgisi için; REST+FHIR var).

### Kodla kapatılamaz (kurum/süreç işi)
1. **Erişim kontrolü / oturum** — bilinçli olarak kaldırıldı; gerçek hasta verisi için
   **ağ düzeyinde kısıtlama (VPN/ters vekil/güvenlik duvarı) şarttır**.
2. **NES/e-imza sağlayıcısı** (e-Devlet/mobil imza) — sözleşmeli entegrasyon.
3. **Klinik doğrulama çalışması** (gölge okuma, 500–1000 vaka, duyarlılık/özgüllük).
4. **MDR/TİTCK/FDA sınıflandırması, ISO 13485/62304/14971** — hukuki süreç.
5. **Kurumsal PACS entegrasyon sözleşmeleri ve altyapısı.**

## 4. Bu turda kapatılanlar

| Öğe | Ne yapıldı |
|---|---|
| **Çapraz platform kurulum paketi** | `packaging/linux` (.deb + tar.gz + systemd + masaüstü), `packaging/macos` (DMG + LaunchAgent), `packaging/universal` (evrensel ZIP + doğrulama betiği), CI’a Linux/macOS işleri eklendi |
| **RECIST 1.1** (nodül/lezyon takibi) | Bazal/izlem çap toplamı, % değişim, CR/PR/SD/PD, yeni lezyon & kaybolma işaretleri, lezyon tablosu, CSV; 8 birim testi |
| **Kurulum sayfası** | `/paketler` — indirme, dosya yolları, işletim sistemi komutları, canlı AI worker durumu |
| **Piyasa analizi belgesi** | Bu dosya + `/kiyaslama` sayfası |

## 5. Kaynaklar

- RadiAnt özellikleri, OHIF, Weasis, MedDream, MicroDicom resmî sayfaları
- Radiogyan “DICOM Viewer Comparison (2026)”, Medicai “Best DICOM Viewers in 2026”
- Aidoc vs Viz.ai karşılaştırmaları, Lunit/Annalise/Gleamer ürün sayfaları
- ACR Lung-RADS v2022, RECIST 1.1 (Eisenhauer ve ark., Eur J Cancer 2009)
- MONAI `lung_nodule_ct_detection` (LUNA16), `ct-head-hemorrhage-detection` (MIT/RSNA)

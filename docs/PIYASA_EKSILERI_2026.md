# ATIKVIEWER — 2026 Piyasa Eksikleri ve Ürün Fikirleri

> Bu belge, [PIYASA_ANALIZI.md](PIYASA_ANALIZI.md) ve uygulamadaki **📊 Kıyaslama**
> (`/kiyaslama`) ekranını tamamlar. Amaç: “piyasada var ama bizde yok/kısmi olan”
> her işi tek yerde toplayıp, her biri için **neyi, neden, nasıl** sorusuna somut
> yanıt vermektir.
>
> **Sabit kural:** Tüm özellikler araştırma/demo çerçevesindedir; klinik doğrulama
> olmadan tanı/ölçüm olarak sunulamaz ve “hekim onayı” zorunluluğu bozulmaz.
> Bu listedeki öğeler ürün yol haritası adayıdır, klinik iddia değil.

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

Görüntüleme altyapısı (MPR/MIP/füzyon/ölçüm/pencere) tüm modalitelerde ortaktır;
modaliteye özel **AI bulgu motoru** ve **rapor şablonu** kapsamı aşağıdadır:

| Modalite | Görüntüleme | AI bulgu/analiz | Rapor şablonu | Asma protokolü |
|---|---|---|---|---|
| CT | Tam (pencereler, MPR, kalibrasyon) | ICH kanama + toraks nodül (kural tabanlı, yerel MONAI modeli worker'a bağlanabilir) | 4 | BT Beyin / Toraks / Abdomen-Pelvis |
| MR | Tam (sekans listesi, karşılaştırma, ölçüm) | **Yalnız görüntü incelemesi** (tanı üretmez) — MR'ya özel model yok | 13 | MR Çoklu Sekans (T1/T2/FLAIR/DWI düzeni) |
| CR / DX | Tam (PA/lateral düzeni) | Görüntü ölçümü; sınıflandırma yok | 2 | Direkt Grafi |
| US | Tam (cine + renkli Doppler) | Tanı motoru yok | 2 | Yok |
| MG | Tam (RCC/LCC/RMLO/LMLO 2×2) | BI-RADS yoğunluk akışı yok | 2 | Mamografi |
| PET / NM | Füzyon + SUVbw | TIC/DSA/MTV yok | 1 | PET-CT füzyon |

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
| A1 | **Akciğer grafisi/filitrio AI** (pnömotoraks, effüzyon, konsolidasyon, katlak, TB) + ısı haritası | P1 | M | Lunit, Aidoc, Gleamer | Görüntü inceleme **yalnızca piksel ölçümü** (tanı sınıfı üretmez); Grad-CAM yok | `torchxrayvision`/ONNX modelini yerel worker'a ekle; bbox + sınıf + Grad-CAM katmanını mevcut `Finding` yapısına bağla; bulgu onay akışı değişmeden kullanılır. |
| A2 | **İnme paketi: ASPECTS + CTP perfüzyon** (CBF/CBV/MTT/Tmax, core/penumbra) | P1 | L | Viz.ai, Aidoc | Yalnız ICH kanama modeli var; perfüzyon/ASPECTS yok | Kural tabanlı ASPECTS bölge skoru (M1–M6, insula, kapsül) + CTP zaman-yoğunluk eğrilerinden perfüzyon haritası; injeksiyon öncesi/sonrası seri eşleme gerekir. |
| A3 | **MSK/X-ışını kırık ve landmarke AI** | P2 | L | Gleamer | Yok (görüntü ölçümü var) | Öncelikle açık-kinelig/veya bölge sınıflandırma + heatmap; el/omurGAĞI/ayak Landmarke nokta önerisi. |
| A4 | **Mamografi: BI-RADS yoğunluk + DBT (tomosentez)** | P2 | L | Lunit, iCAD | “MG modu” olduğu belgelenmiş ama yoğunluk/DBT özel akışı yok | CC/MLO layout + DBT slab navigasyonu + BI-RADS a/b/c/d yoğunluk önerisi; PI-RADS/Radslex benzeri sözlük. |
| A5 | **Kalsiyum skoru (Agatston) + kemik yoğunluğu** | P2 | M | Aidoc | Yok | BT'de L1–L4 HU ölçümü → Agatston; DEXA/HU T-skor önerisi; prospektif ”insidental” kategori. |
| A6 | **Akciğer kvantifikasyonu: lob/emphisema (LAA-950)/volüm** | P2 | L | 3D Slicer, Aidoc | Aday hacmi var, lob/emphisema yok | Lob segmentasyonu (kural veya SAM) + −950 HU oranı; kesit/3B dağılım grafiği. |
| A7 | **Nükleer tıp: DSA çıkarma, TIC, MTV/SUVpeak** | P3 | L | RadiAnt, Hermes | Füzyon var; DSA/TIC yok; SUVbw var | Pre/post subtraksiyon, zaman-yoğunluk eğrisi, metabolik tümör volümü (threshold SUV alanı). |
| A8 | **Model operasyonları: kayıt, A/B, kalibrasyon, drift** | P2 | L | Tüm üreticiler | Model sabit; PPV panosu var, kalibrasyon/drift yok | Model kartına sürüm/hash ekle; feedback verisinden eşik/PPV izleme; model değişiminde denetim kaydı. |

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
| C3 | **RECIST tamamlayıcıları:** lenf nodu (kısa eksen), non-hedef lezyon, çalışmalar arası otomatik eşleştirme | P1 | M | Hedef lezyon + CR/PR/SD/PD var | Lezyon imza (anatomi+konum) eşleştirme; lenf nodu tablosu; “yeni/kayboldu” sinyali zaten var. |
| C4 | **Key Object / GSPS / SR / SEG / RTSTRUCT’ı PACS’a geri gönderme** | P1 | M | Dışa aktarma var; PACS’a gönderme yok | Bkz. E2. |
| C5 | **Ölçüm geçmişi ve trend grafikleri** (çap/HU/SUV zaman serisi) | P2 | M | Nodül takibi tarayıcıda; ölçümler rapora | Ölçümleri `study_state`’e yapılandırılmış kayıt olarak yaz; sunucu tarihçesi + grafik. |

---

## D. Raporlama ve kapanış döngüsü

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| D1 | **Kritik sonuç kapanış döngüsü:** ACK + iletim kanıtı + eskalasyon kaydı | P1 | M | Bildirim “alındı” var; kim/süre/eskalasyon ve iletilme kanıtı yok | Zaman damgalı ACK, okundu/iletildi kanıtı, hekime tekrar hatırlatma, denetim satırı. **Bu sürümde kısmen uygulandı:** `notifications.relayedTo`/`relayedAt`/`escalated`/`escalatedAt` + zil üzerinde “İletildi…/Eskalasyon” ve `notify.relay` denetim kaydı; süre hatırlatması yok. |
| D2 | **Takip önerilerini iş listesine taşıma** | P1 | S | Öneri raporda kalıyor; görev kuyruğuna düşmüyor | “Takip önerisi” nesnesi: modalite/bölge/süre + durum; çalışma listesinde görünür. **Bu sürümde uygulandı:** onaylı raporun “Öneri” metni otomatik göreve dönüşür (`acik/tamamlandi/iptal`), gün/hafta/ay/yıl süresi ayrıştırılır; yaklaşan tarih bildirimi yok. |
| D3 | **Peer review / ikinci okuma / uyuşmazlık kaydı (RADPEER)** | P2 | M | Yok | Rapor yanında ikinci hekim ataması, uyuşmazlık kategorisi, kalite metriği. |
| D4 | **Ambient dokümantasyon + yapılandırılmış makrolar** | P2 | M | Web Speech dikte var; ambient tıbbi sözlük yok | Makro kitaplığı (cümle/blok), ACR uygunluk sorgusu; sözlük genişletilebilir. |
| D5 | **ICD-10 / ACR Appropriateness / kodlama desteği** | P3 | S | Yok | Bulgu→ICD-10 öneri tablosu; istek uygunluğu sorgulama (RadPal benzeri). |
| D6 | **Hasta dostu sonuç mektubu (çok dilli)** | P3 | S | Hasta özeti var | PDF/e-posta çıktısı; okuma düzeyi seçeneği. |
| D7 | **Üretken AI’da hekim üslubu öğrenme + alıntı** | P2 | M | LLM taslak var; üslup yok | Hekim düzeltmelerinden stil öğrenimi (opsiyonel, gönüllü); çıktıda kesit referansları. |

**Hızlı kazanç:** D1 + D2 birlikte “kritik bulgu yönetimi” açısını kapatır; denetim zinciri zaten var.

---

## E. Entegrasyon (PACS / HIS / IHE)

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| E1 | **DICOMweb STOW-RS / DIMSE C-STORE ile PACS’a gönderme** (SR, KO, anonim DICOM) | P1 | M | Yalnız QIDO/WADO istemcisi | `STOW-RS` upload ucu + rapor/KO/SR gönderim diyaloğu; hata/ack kaydı. |
| E2 | **WADO-RS URI + kare/bulk veri (frame-level) getirme** | P1 | S–M | Instance bazlı WADO var | `accept=multipart/related;type=image/jpeg;transfer-syntax=*`, frame parametresi, `bulkdataURI`. |
| E3 | **HL7 v2 MLLP alıcısı + Modality Worklist (MWL)** | P1 | L | REST istemi + FHIR rapor çıktısı var | MLLP listener + worklist import; MWL SCP hedefi (sipariş→çalışma listesi). |
| E4 | **FHIR girişi: ServiceRequest/ImagingStudy/P Çekici** | P2 | M | Çıktı FHIR DR var; giriş yok | FHIR client (kimlik/OAuth), sipariş→çalışma, ImagingStudy→WADO URL eşlemesi. |
| E5 | **IHE profilleri (SWF, AI Results, DICOMweb)** | P2 | L | Yok | Önce SWF (scheduled workflow) + AI Results Storage Profile. |
| E6 | **Gerçek PACS ile uçtan uca test** (Orthanc/dcm4chee) | P1 | S | Mock sunucu testi var; gerçek PACS yok | CI’ya Orthanc servisi ekleyip QIDO/WADO/STOW senaryoları. |

---

## F. İş akışı, kullanıcı ve kurumsal özellikler

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| F1 | **Kimlik:** kullanıcı adı/parola + MFA + oturum zaman aşımı (SSO sırasıyla) | P0 | L | ACCESS_TOKEN tek kapıydı; parola/oturum/MFA yoktu | **Bu sürümde minimum uygulandı:** `AUTH_MODE=hesap` ile scrypt parola, imzalı oturum çerezi (8 saat), TOTP/MFA (`otplib`), `REQUIRE_TOTP_FOR_ROLES`. Kalan: SSO/OIDC/LDAP/SAML entegrasyonu. |
| F2 | **RBAC detayı:** radyolog/teknisyen/arator/yönetici + hekim profilleri | P0 | M | Tek operatör profili; `authorize()` rolleri yok sayıyordu | **Bu sürümde uygulandı:** `yonetici/radyolog/teknisyen` rol denetimi tüm API uçlarında aktif, Yönetim → Kullanıcılar (ekle/rol/pasif/parola sıfırla). Kalan: arator rolü ve hekim profil çoklu üyelikleri. |
| F3 | **Kullanıcı başına tercihler** (layout, preset, kısayol) sunucuda | P2 | S–M | localStorage | Ayarlar tablosu + profil ucu. |
| F4 | **Turnaround/istatistik panosu** (TAT, bulgu/adet, onay süresi) | P2 | M | Çalışma listesi var, metrik yok | Denetim + rapor verisinden agregasyon; Yönetim sekmesi. |
| F5 | **Toplu/arka plan içe aktarma kuyruğu** | P2 | M | Tek seri akışı | Kuyruk tablosu + ilerleme; başarısız yeniden deneme. |
| F6 | **Paylaşım:** süreli bağlantı + watermark + denetim | P2 | M | Yok | imzalı URL, maske/watermark, erişim logu. |
| F7 | **Hasta CD’si / ISO** (DICOM CD, otomatik görüntüleyici) | P3 | M | ZIP + kurulum var | ISO üretimi + DICOMDIR + autostart viewer. |

---

## G. Güvenlik, uyum ve gözlem

| ID | Özellik | P | Çaba | Bizde şu an | Fikir |
|---|---|---|---|---|---|
| G1 | **Web hardening:** CSP, X-Frame-Options, CSRF koruması, rate limiting | P1 | S–M | CORS var; CSP/rate-limit yok | `next.config.ts` header’ları + ağ güvenlik Duvarı; IP/user bazlı sınır. |
| G2 | **Denetim dışa aktarımı** (Syslog/CEF/JSON) + uzun vadeli arşiv | P2 | M | UI/API okuma var | Hook ile log collector. |
| G3 | **Tedarik zinciri:** CodeQL, SBOM, imzalı derleme (SLSA), dependency review | P1 | M | Dependabot var; CodeQL/SBOM yok | GitHub Actions job’ları + sign/release attestation. |
| G4 | **Yedek/geri yükleme/DR + nesne depolama adaptörü** (S3/MinIO) | P1 | L | Dosya sistemi; elle yedek | Depolama arayüzü + S3/MinIO; `pg_dump` playbook’u, DR tatbikatı. |
| G5 | **KMS/anahtar rotasyonu** (yazılımsal KMS, otomatik rotation) | P1 | M | Anahtar env dosya; rotasyon yok | Arayüz + rotasyon akışı; eski anahtarla çöz, yeniyle şifrele. |
| G6 | **Gözlem:** Prometheus metrik, yapılandırılabilir log, readiness/liveness ayrımı | P2 | M | `/api/health` var; metrik yok | `/metrics` + yapılandırılabilir log seviyesi; health DB’ye bağımlı olduğu için readiness ayrılmalı. |
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

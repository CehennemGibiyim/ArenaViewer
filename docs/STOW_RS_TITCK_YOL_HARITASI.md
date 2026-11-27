# STOW-RS (PACS'a geri yazma) ve TİTCK (Türkiye) yol haritası

> **Bu belge bir plan ve envanterdir; hukuki/regülasyon danışmanlığı DEĞİLDİR.**
> Rakamlar 2026 piyasa tahminleridir (± geniş); her adım düzenleyici danışman ve
> TİTCK ile doğrulanmalıdır. Hiçbir maddeyi "yapılıyor/onaylandı" olarak değerlendirir
> gibi okumayın — bkz. §4 "Durum" sütunu.

## 0. Onaylanan sıra (kullanıcı kararı, 2026-11)

**SKM-TEA → gölge mod → STOW-RS → TİTCK**

- SKM-TEA kaydı: **henüz başlamadı** (kullanıcı kararı bekliyor; bkz. [KLINIK_DOGRULAMA_PLANI.md](KLINIK_DOGRULAMA_PLANI.md) §6 — ölçülmüş hiçbir Dice/HD95 yoktur).
- Bu belge STOW-RS ve TİTCK'yı **planlar**; ikisini de başlatmış kabul etmez.
- Teknik sertleştirme (Faz A0) SKM-TEA'dan bağımsız yürütülebilir; klinik akışın
  "PACS'a geri yaz" anahtarını açmak ancak doğrulama + gölge mod **GO** kararına bağlıdır.

## 1. Bugünkü durum — ölçülmüş (kod + testler)

| Alan | Durum | Kanıt |
|---|---|---|
| STOW-RS istemcisi (SR / KO / PR / anonim seri) | **Var + testli** | `/api/pacs/stow`, `src/lib/{stowPayload,stowResponse,stowClient}.ts`, `tests/stow*.test.ts` |
| TID 1500 Comprehensive SR | Var (onay ekranında **opt-in**, varsayılan kapalı) | `w-pacs`; `tests/sr1500-send.test.ts` |
| Anonim seri gönderimi | Var — tarayıcıda sıfırdan üretim + sunucu yeniden denetimi (örnek sayısı/byte/DICM) | `tests/stowanon.test.ts`, `stowPayload.ts` |
| Kesit aralığı seçerek gönderim | Var (seçim aralığı zorlaması, denetim kaydı) | `estow-selection.test.ts` |
| Canlı XA/US kabulü (modalite → viewer) | Var — `POST /api/dicomweb/studies` (x-api-key + multipart) | `f-objects`; `tests/dicom-ingest.test.ts` |
| QIDO/WADO (metadata, frames, BulkDataURI vekil + SSRF koruması) | Var | `wadoClient.ts`, `/api/pacs/{metadata,bulkdata,frames}` |
| Gerçek Orthanc'a karşı uçtan uca | Var — CI `pacs-e2e` işi | `tests/pacs.orthanc.e2e.ts` — **kurumsal PACS uyumunu garanti ETMEZ** (kodda ve kılavuzda açıkça yazar) |
| SEG / RTSTRUCT'un STOW ile geri yazımı | **Yok** | `gapAnalysis` → aday `seg-stow-return` (nextUp) |
| DIMSE C-STORE / C-FIND / C-MOVE | **Yok** — Orthanc/dcm4chee ağ geçidi kararı gerekir | pazar analizleri, `e-stow` |
| Tam Presentation State yazma | **Yok** | `f-objects` |
| Kurumsal/PACS-vendor kabul profili (en az bir dcm4chee + bir ticari PACS) | **Yok** | — |
| DICOM Conformance Statement (ürün karşılığı) | **Yok** | — |
| TİTCK / MDR süreçleri | **Başlamadı** — ürün bugün "tıbbi cihaz değildir" etiketlidir | tüm paketler/UI/dokümanlar |

## 2. Faz A — STOW-RS'i "üretim" seviyesine çıkarmak

### A0 — Şimdi başlayabilir (yalnız mühendislik; doğrulamaya bağlı değil)
- **A0.1** `seg-stow-return`: SEG / RTSTRUCT STOW (triyaj/AI maskesi geri yazımı) + Orthanc e2e genişletme; SEG SOP sınıfı doğrulaması.
- **A0.2** Gönderim kimliği sözleşmesi: kurum PACS başına yapılandırılabilir **TLS/mTLS + kullanıcı doğrulama** (bugün QIDO/WADO/STOW aynı presetten çalışır; PACS tarafında AE/IP beyaz liste, Basic/Bearer auth veya VPN kurumu yaygın şarttır).
- **A0.3** Hata yolu: STOW yanıtının `00081198` detayını kullanıcıya görünür kılmak, kısmi kabul uyarısı, "önce tek kesitle dene" yolu; yeniden deneme kuyruğu (şu an yok).
- **A0.4** dcm4chee-arc + en az bir ticari PACS profili; worklist bağı (modalite doğru çalışmayı seçince `/api/dicomweb/studies`'e düşüş) için kurumla test senaryosu.

### A1 — Kurum ile (kabul profili)
- PACS'ın STOW-RS ile kabul ettiği SOP sınıflarının listesi alınır (Basic Text SR, TID 1500, KO, PR/GSPS, SEG, RTSTRUCT — hangisi var/yok).
- Pilot test: fantom çalışma + onaylı SR/KO/PR → PACS'te görünür mü; kabul oranı; hata mesajları elden geçilir.
- IP/AE beyaz listesi, hesap, kota; audit kayıtlarında PACS yanıt kodlarının saklanması (hassas veri yok).
- Kabul ölçütü (örnek): SR/KO/PR kabul ≥ %98, 2 haftada 0 sessiz kayıp, %100 gönderimin denetim kaydında görünmesi.

### A2 — Klinik akış (gölge mod GO'dan sonra)
- Gölge mod sonrası kararı: onaylı rapor → (opt-in) TID 1500 otomatik STOW **varsayılanı açık kalsın mı?** (Öneri: TİTCK kararına kadar opt-in kalır; kararı ürün sahibi verir.)
- Ölç: `pacs.send_sr1500` / `pacs.send_anon` denetim kayıtlarından kabul oranı, red sayısı, kısmi kabul; haftalık özet.
- Geri alma planı: PACS düşerse kuyruk + kullanıcı bildirimi; "yerel sakla, sonra tekrar dene"; rapora dokunmadan yalnız gönderim tekrarlanır.

### A3 — Bitti tanımı (DoD)
- A0 testlerle yeşil; A1 pilot raporu docs'a işlendi; A2 iki haftalık ölçüm raporu yeterli; SEG/RTSTRUCT gönderimi kanıtlı; kılavuzlar (MENU_KILAVUZU, GORSEL_ANLATIM) güncel.

## 3. Faz B — TİTCK (Türkiye) yolu

> Aşağıdakiler süreç haritasıdır; hukuki tavsiye değildir. Metin sürümünü TİTCK'nın
> kendi sitelerinden doğrulayın; çelişkide resmi metin esastır.

### B0 — Konum kararı (en kritik adım)
Bugün ATIKVIEWER **tıbbi cihaz değildir**; tanı iddiası yoktur; bu konum bilinçlidir.
- **Yol 1 (bugün):** research/in-house kalır → TİTCK yükümlülüğü yok; klinik karar teşvik edilmez; etiket kalkmaz.
- **Yol 2:** "tını/triage kararını destekleyen yazılım" gibi düzenlemeye girecek bir iddia eklenirse → B1.

### B1 — Sınıflandırma
- **Tıbbi Cihaz Yönetmeliği** (AB MDR 2017/745'e uyumlu; 02.06.2021 tarih ve 31499 sayılı Resmî Gazete — teyit edin) **Rule 11**: tanı/tedavi kararlarına **bilgi sağlayan** yazılımlar çoğunlukla **Sınıf IIa**; "ciddi bozulma" senaryoları IIb'ye çıkar.
- ATIKVIEWER'ın mevcut konumu (tanı koymaz, araştırma taslağı) korunursa cihaz sayılmaz; iddia değişirse sınıflama değişir. Kararı regülasyon danışmanı verir.

### B2 — Gereksinim çerçevesi (sınıf IIa SaMD için tipik)
- **ISO 13485** kalite yönetim sistemi (üretim/dağıtım süreçleri).
- **ISO 14971** risk dosyası — depoda taslak var: [RISK_YONETIMI.md](RISK_YONETIMI.md) (kurum onayı + nihai dosya gerekir).
- **IEC 62304** yazılım yaşam döngüsü: yazılım gereksinimleri (SRS), mimari (SDS), risk yönetimi, doğrulama/geçerleme, izlenebilirlik matrisi, sürüm değişiklik kontrolü.
- **Klinik değerlendirme** (MDR Ek XIV): diz MR için SKM-TEA/OAI referans maskeleriyle Dice/HD95 + kendi kurum verisi + **prospektif/gölge mod** kanıtları.
- **UDI**, **Türkçe IFU**, **CE işareti** (sınıf IIa'da Onaylanmış Kuruluş denetimi), **TİTCK Ürün Takip Sistemi (ÜTS)** kaydı, **PMS/PMCF**, uyanıklık (vigilance) bildirim yükümlülüğü, sorumlu kişi (PRRC).

### B3 — Adımlar, tahmini süre ve maliyet (2026 tahmin aralıkları; ±)

| # | Adım | Süre | Yaklaşık maliyet |
|---|---|---|---|
| 1 | Boşluk analizi + regülasyon planı (danışman) | 1–2 ay | €5–15k |
| 2 | QMS kurulumu (ISO 13485) | 3–9 ay | €10–30k |
| 3 | IEC 62304 haritalama + V&V paketi (deponun test zinciri güçlü bir başlangıçtır; SRS/SDS/izlenebilirlik yok) | 2–4 ay | iç emek |
| 4 | Klinik kanıt: SKM-TEA (ücretsiz kayıt) + kurum kohortu + gölge mod raporu + etik kurul | 6–12 ay | kurumsal süreç |
| 5 | Teknik dosya + Onaylanmış Kuruluş denetimi (Türkiye/AB) | 6–12 ay | ~€15–50k/yıl OK ücreti (değişken) + dokümantasyon |
| 6 | CE işareti + ÜTS kaydı + piyasaya arz/ithalat bildirimi | 1–2 ay | düşük |
| 7 | PMS/PMCF + yıllık OK gözetim + vijilance | sürekli | sürekli |

**Toplam: ~18–30 ay ve ~€60k–200k+** — kapsam (Yol 2a yalnız diz MR mı; Yol 2b tam motor seti mi) ve OK seçimine göre büyük değişir. **Hukuki tavsiye değildir.**

### B4 — Dürüst alternatifler
- **(a) Research konumunu koru** (bugün): sıfır regülasyon yükü; klinik iddia yok; gözetim yükü kurumda.
- **(b) Dar kapsam IIa** (ör. yalnız diz MR segmentasyonu, CE'si olan bir motoru entegre etme — ör. KEROS/Incepto): daha hızlı ve ucuz; kapsam netleşmeli.
- **(c) Tam SaMD seti** (BT toraks, ICH, CXR, diz MR): her motorun ayrı klinik kanıtı; en pahalı ve en uzun yol.
- **(d) Önce AB (MDR CE), sonra ÜTS**: pratikte Türkiye'de piyasaya arz için ÜTS zaten gerekir; sırasıyla yapılabilir.

### B5 — Depodaki sıfır maliyetli avantajlar
~2.600 testli CI zinciri (`pacs-e2e` gerçek Orthanc dahil), SHA-256 denetim zinciri, risk dosyası taslağı, model kartları + ICH 100 vaka doğrulama raporu, kılavuz kültürü (CI kılavuz zorlaması), STOW-RS'in testli çalışır durumda olması. Eksikler: IEC 62304 izlenebilirliği, SRS/SDS, QMS dokümanları, klinik kanıt paketi.

## 4. Durum kaydı (2026-11-27)

| Faz | Durum |
|---|---|
| SKM-TEA kaydı | **Başlamadı** — kullanıcı kararı bekliyor |
| Gölge mod | Planlandı, kurum verisi gerekir |
| A0 (mühendislik) | Planlandı — başladı/bitti işi YOK |
| A1 (kurum kabul profili) | Planlandı — kurum PACS bilgisi gerekir |
| A2 (klinik akış) | Gölge mod GO'ya bağlı |
| B0 konum kararı | Kullanıcının kararı bekliyor (bu belge karar vermez) |
| B1–B7 | Başlamadı |

Kural: bu tablo ve ilgili § bölümleri değiştiğinde PR açıklamasına "docs: stow-rs/titck güncellemesi" yazılır.

## 5. İlgili belgeler

[KLINIK_DOGRULAMA_PLANI.md](KLINIK_DOGRULAMA_PLANI.md) (§6 SKM-TEA durumu) ·
[KLINIK_ONAY_KILAVUZU.md](KLINIK_ONAY_KILAVUZU.md) (gölge okuma protokolü) ·
[RISK_YONETIMI.md](RISK_YONETIMI.md) (ISO 14971 taslak) ·
[PIYASA_ANALIZI.md](PIYASA_ANALIZI.md) (pazar referansları) ·
[MENU_KILAVUZU.md](MENU_KILAVUZU.md) / [GORSEL_ANLATIM.md](GORSEL_ANLATIM.md) (kullanıcı kılavuzları)

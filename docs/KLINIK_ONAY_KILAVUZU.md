# ATIKVIEWER — Radyoloji Uzmanı Onay Kılavuzu

> **Amaç:** Yapay zekânın ürettiği bulguların bir radyoloji uzmanı tarafından
> gerçek görüntüler üzerinde tek tek incelendiğinden, yanlış/eksik bulguların
> rapora geçmediğinden ve doğrulama verisinin kayıt altına alındığından emin
> olmak. Bu kılavuz bir **klinik doğrulama protokolü** taslağıdır; kurumunuzun
> etik kurul kurallarına göre uyarlanmalıdır.

---

## 0. Kurulum ve çalışma ön koşulları

| # | Adım | Beklenen sonuç | Doğrulama |
|---|---|---|---|
| 0.1 | `bash packaging/universal/verify.sh` | tüm maddeler “GEÇTİ” | `dist/ATIKVIEWER-dogrulama-*.log` |
| 0.2 | AI worker açık | `/api/deep-scan` → `worker: up`, model dosyaları HAZIR | 📦 Kurulum sayfasındaki canlı durum paneli |
| 0.3 | Model kurulmamışsa | panel “YOK / kapalı” gösterir, uygulama kural tabanlı motora düşer | **Sahte bulgu üretilmediği doğrulanır** |
| 0.4 | Veritabanı | `/api/health` → `{"ok":true}` | durum çubuğu |

> Ücretsizdir: model indirme, çıkarım ve raporlama için **hiçbir ücretli servis
> kullanılmaz**. Hasta verisi `127.0.0.1` dışına çıkmaz.

---

## 1. Vaka seti seçimi (gölge okuma)

En az **50 vaka** (önerilen hedef: 200–500) seçin; her modalite/protokol için:

- **BT toraks** — bilinen/negatif nodül vakaları (LUNA16 benzeri dağılım)
- **BT beyin** — kanama pozitif ve negatif vakalar (ICH)
- **Diğer** (MR, US, CR/DX, mamografi) — kural tabanlı motorun sınırlarını ölçmek için

Her vaka için şunları kaydedin: çalışma UID, tarih, modalite, uzman kararı
(pozi/negatif), ölçülen çap/HU, AI çıktısı ve AI skoru.

**Kural:** Vaka seçimi ve uzman kararı, AI’dan **bağımsız** verilmelidir
(görmezden okuma / blind read). AI çıktısı okuma sırasında görünürse
“görmezden okuma” olmaz — bu, yanlılık (automation bias) yaratır.

---

## 2. Vaka başına inceleme adımları

1. **Görüntüyü aç** — seriyi ve kesit kalitesini değerlendir (artefakt, hareket).
2. **AI paneline bak** — model kartını oku: model adı, sürüm, doğrulama durumu,
   sınırlılıklar. “Model yok / worker kapalı” etiketini gör.
3. **Her AI bulgusu için**:
   - [ ] Kutu/kesit aralığı **gerçek lezyonla hizalı mı**? (değilse → RED)
   - [ ] Ölçülen **HU / çap / hacim gerçekçi mi**?
   - [ ] Skor **“kalibre değil”** etiketiyle mi sunuluyor (olasılık gibi değil)?
   - [ ] **Kaçırdığımız** bulgu var mı? (AI’nın bulamadığı gerçek lezyonu girin)
4. **Kararı ver** — her bulgu için: `Onayla` / `Reddet` / `Düzenle`.
   Red/düzenleme gerekçesi yazın (bu, model iyileştirmesinin hammaddesidir).
5. **Raporu onayla** — bekleyen bulgu kalmadan rapor onaylanamaz
   (bu kural sunucuda da zorunludur).

---

## 3. Toplu ölçüm (klinik doğrulama)

Yönetim → **AI performans** panelinde biriken veriyle hesaplanır:

| Metrik | Tanım | Hedef |
|---|---|---|
| Duyarlılık (Sensitivity) | Gerçek pozitiflerin AI tarafından bulunma oranı | modüle göre belirlenir |
| Özgüllük (Specificity) | Gerçek negatiflerin doğru negatif kalma oranı | — |
| PPV (kesinlik) | AI pozitiflerinin gerçekte pozitif olma oranı | kayıt zaten var |
| Kaçırılan bulgu | Uzman bulduğu, AI’nın bulamadığı lezyon sayısı | **en kritik sayı** |
| Yanlış pozitif / vaka | Vaka başına gereksiz uyarı | okuma süresini artırır |

Sonuçları **sürüm bazlı** kaydedin (model sürümü ↔ metrikler). Yeni sürüm
ancak bu tablo iyileştiğinde okuma akışına alınır.

---

## 4. Yayın öncesi zorunlu kapılar

- [ ] AI bulguları **hiçbir ekranda ön onaylı/kesin** görünmüyor
- [ ] Model kartı panelde ve rapor çıktısında yer alıyor
- [ ] “KLİNİK KARAR İÇİN KULLANILAMAZ” ibaresi üst çubukta, panelde ve raporda var
- [ ] Denetim kaydı (audit) değişikliği yakalıyor — `docs/Dogrulama_Raporu.md`
- [ ] Hasta verisi AES-256-GCM ile şifreli; uygulama yalnız yerel ağda erişilebilir
- [ ] **Erişim kısıtı** tanımlı (VPN / güvenlik duvarı / ters vekil) — KVKK için şart
- [ ] İlgili kişi aydınlatma metni ve saklama/silme süresi hazır
- [ ] Bu kılavuzdaki ölçüm tablosu dolduruldu ve etik kurula sunuldu

---

## 5. Sınırlılıklar (rapora ve sunuma yazın)

- Çıkarım **yereldir ve ücretsizdir**; ancak **düzenlemeye tabi tıbbi cihaz
  yazılımı onayı (TİTCK/CE-MDR/FDA 510(k)) alınmamıştır** — klinik karar aracı
  olarak kullanılamaz.
- Skorlar **kalibre değildir**; olasılık olarak yorumlanamaz.
- RECIST/Lung-RADS çıktıları **özet** niteliğindedir; hedef lezyon seçimi ve
  non-hedef değerlendirme hekim sorumluluğundadır.
- Kural tabanlı motorlar (worker kapalıyken) **gösterge/demo** niteliğindedir ve
  açıkça etiketlenir.

**İmza:** Uzm. Dr. ____________________  Sicil ________  Tarih __________

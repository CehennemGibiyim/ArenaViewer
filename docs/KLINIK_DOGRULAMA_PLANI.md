# Klinik Doğrulama Planı ve Kayıtları

> Amaç: Her yerel modelin performansını **kendi verimizde** ölçmek, sonuçları ve
> eksikleri açıkça yazmak. AI çıktısı klinik doğrulama olmadan “normal” ya da “hasta”
> demez; bu plan uygulanmadan modeller yalnızca araştırma/demo olarak sunulur.

## 0. Mevcut kayıtlar (tamamlanmış)

| Model | Belge | Kapsam | Özet sonuç |
|---|---|---|---|
| MONAI lung_nodule_ct_detection (BT toraks) | `Dogrulama_Raporu.md` | 6 sentetik fantom vaka | Nodül bazlı eşleşme yüksek; negatif vakalarda FP sinyali var (≥0.05 eşik) |
| ianpan/ct-head-hemorrhage-detection (ICH/SAH) | `Klinik_Dogrulama_ICH.md` | 100 gerçek vaka (Zenodo RHUH, CC BY 4.0) | Vaka duyarlılığı %43; konumlandırma 37/43; kesit düzeyinde FP yok |
| LUNA16 doğrulaması | `Klinik_Dogrulama_LUNA16.md` | LUNA16 split | Bkz. belge |

Üçü de **yerel** yapılmıştır (hasta verisi dış ağa gitmez). Hepsi “aday/yönlendirme”
sonucudur; hiçbiri tanı iddiası taşımaz.

## 1. Açıkta kalan model: CXR (Medical_X DenseNet121)

`Medical_X` için **kendi cohort doğrulamamız yok**. Kaynak metrikler (makro AUROC
0,851) NIH ChestX-ray14 doğrulama split’ine aittir ve bizim hasta popülasyonumuzu
temsil etmez.

Yapılması gereken adımlar (sıra ile):

1. **Veri seti**: Kurum PACS’inden geriye dönük, etik kurul onaylı ~1000 PA graf;
   sınıf dağılımı ve yaş/cihaz karışımı raporlanır.
2. **Altın standart**: En az iki radyoloji uzmanının bağımsız okuması; üçüncü
   uzman uzlaştırma (adjudication). Okuma ortamı AI'dan bağımsız tutulur.
3. **Ölçüm**: Sınıf bazında duyarlılık/özgüllük, AUROC/AUPRC, eşik taraması,
   calibration (ECE — kodda `src/lib/modelOps.ts::expectedCalibrationError` hazır),
   alt grup analizi (yaş/cihaz/projeksiyon).
4. **Gölge mod**: AI sonuçları rapora girilmeden bir süre kaydedilir; hekim okuması
   sonrası bulgu bazında TP/FP/FN etiketlenir (`AI_SHADOW_MODE`, bkz. §2).
5. **Sonuç**: Bu dosyaya rapor eklenir; model kartı güncellenir; eşikler mevcut
   kaynak değerlerden farklıysa belirtilir.

## 2. Gölge mod (shadow mode) — teknik plan

Amaç: Üretimde modeli “görünmez ama çalışır” kılarak hekim geri bildirimini toplamak;
henüz doğrulanmamış modelin bulgularını rapora yazmaktan kaçınmak.

- Etkinleştirme: `NEXT_PUBLIC_AI_SHADOW_MODE=true` (istemci davranışı) + sunucu kaydı.
- Davranış: AI motoru normal çalışır; çıktılar **rapora ve bulgu listesine girmez**,
  bunun yerine `/api/shadow` kaynağına `engine + studyUid + bulgular JSON` yazılır.
- Ekran: Kullanıcı “gölge mod aktif — bulgular kaydedildi, rapora girmedi” satırı görür.
- Değerlendirme: Radyolog raporu onayladığında bulgu bazında onay/red kaydı
  `/api/ai/performance` özetine beslenir (kodda mevcut).
- Kapatma: Doğrulama tamamlanınca `AI_SHADOW_MODE` kapatılır; bulgular yeniden
  “aday” etiketiyle rapora girer.

## 3. Performans izleme (çalışan altyapı)

- `/yonetim → AI performans`: motor/bulgu kategorisi bazında gösterilen, onaylanan,
  reddedilen, düzenlenen sayıları; **PPV = onaylanan / (onaylanan + reddedilen)**;
  kalibrasyon bölmeleri (reliability) ve ECE.
- Veri kaynağı: Rapor kayıtlarındaki `findingsApproval` alanı; denetim zinciri
  (`auditLogs.contentHash`) değişiklikleri izler.
- Sorumlu kullanım: Panel yalnızca yönetici/radyolog rollerindedir; tek hekim
  (yani küçük örnek) istatistikleri yanıltıcı olabilir, örnek sayısı her zaman gösterilir.

## 4. Yanlılık (bias) ve eşitsizlik izleme

- Modalite/modül bazında sonuçlar (AI performans sekmesi) alt kalemlere ayrılabilir.
- Demografik alt gruplar (yaş aralığı, cinsiyet, cihaz) şu an **toplanmıyor**; KVKK
  nedeniyle hasta ile AI skoru eşleştirmesi kurum gerekçesiyle yapılmalı ve etik
  kurula sunulmalıdır. Öneri: Yalnızca yaş aralığı/cihayet ve projeksiyon gibi
  teknik alt gruplar başlayacak şekilde kısıtlı tutmak.
- Görüntü kalitesi değişkenleri (CXR teknik kalite puanı, BT ince/ılımlı kesit)
  skorla birlikte raporlanmalıdır (CXR tarafı zaten üretir: `cxrQuality`).

## 5. Tanı ve sorumluluk sınırı

Bu depodaki hiçbir model tanı koymaz. Rapor her zaman “aday/yönlendirme” dilini
korur ve hekim onayı olmadan “onaylandı” statüsüne geçemez. Doğrulama eksik olan
her model bu listede açıkça “açıkta” sayılır.

## 6. Diz MR — SKM-TEA (Stanford AIMI) karşılaştırması — **YAPILMADI**

> Durum kaydı (2026-11-27): **Bu kıyaslama hiçbir aşamada başlatılmamıştır; ölçülmüş
> değer yoktur.** Bu depoda SKM-TEA verisi indirilmemiş, işlenmemiş ve üzerinde
> Dice/HD95 gibi hiçbir ölçüm çalıştırılmamıştır.

- Kayıtlar (§0) tablosunda SKM-TEA **yer almaz**; diz MR modeli yalnız
  araştırma etiketlidir ve bağımsız referansla ölçümü **bekleyen iş**tir
  (`src/lib/gapAnalysis.ts` → `skm-tea-validation`, `nextUp`).
- Model kartında ve `/kiyaslama` aday listesinde aynı dürüst not vardır:
  bağımsız/prospektif doğrulama yapılmamıştır.
- Ölçüm tamamlandığında bu bölüme aynı §0 biçiminde tablo satırı eklenir
  (kapsam, Dice/HD95, tarih) ve `docs/KURULUM_VE_KULLANIM.md` §7 güncellenir.
- Kullanıcı SKM-TEA kaydını **henüz başlatmadı** (karar bekliyor). Kayıt olmadan
  veri yoktur; veri yoksa kıyaslama yoktur — raporlanır, ölçülmüş gibi yazılamaz.
- Gerekirse yalnızca herkese açık örnek (`arjundd/skm-tea-mini`) ile hat doğrulaması
  yapılabilir; bu da RUA'ya tabidir ve yine ölçümle ve bu dosyaya kayıtla kapanır.
- Üretim hattı sıralaması ve TİTCK adımları: [STOW_RS_TITCK_YOL_HARITASI.md](STOW_RS_TITCK_YOL_HARITASI.md).

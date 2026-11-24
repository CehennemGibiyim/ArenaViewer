# Güvenlik Politikası

> **Kapsam:** Bu yazılım **araştırma/demo** ürünüdür; klinik karar için kullanılamaz
> ve tıbbi cihaz değildir. Aşağıdaki kurallar demo/araştırma kullanımı içindir;
> gerçek hasta verisiyle kullanım için ek kurumsal süreçler (KVKK, MDR/TİTCK,
> ağ erişim kontrolü) şarttır.

## Sürümler

Yalnız `main` dalı desteklenir. Güvenlik düzeltmeleri `main`'e gider; sürümlü
etiket (`v*`) yalnız release akışıyla oluşur.

## Güvenlik Açığı Bildirimi

Lütfen herkese açık issue **açmayın**. Açıklanmadan önce şu adresten iletişime geçin:
depo sahibinin GitHub profilindeki iletişim kanalı / kurum içi güvenlik e-postası.
Bildirimde şunlar olsun: etkilenen dosya/yol, yeniden üretme adımları, olası etki.
Yanıt süresi olarak 7 gün hedeflenir.

## Sır Yönetemi

- `.env`, `.data/`, şifreleme anahtarları ve hasta verisi **asla** Git'e girmez.
- `DATA_ENCRYPTION_KEY` üretimi: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- Eğer bir anahtar hiç commitlendiyse (bu depoda `v0.1.0` öncesi durum gibi),
  o anahtar **iptal edilmiş** sayılır: yeni anahtar üretin, eski kayıtları
  Yönetim → Güvenlik → “Mevcut kayıtları şifle” ile yeni anahtarla yeniden şifreleyin.
- Anahtarı veritabanında/ortam değişkeninde tutun; üretimde KMS gibi ayrı bir
  sır yöneticisi önerilir. Anahtar yedeği olmadan şifreli veri kurtarılamaz.

## Varsayılan Güvenlik Durumu (bilinçli tasarım)

- Uygulama içinde **oturum/kimlik doğrulama yoktur**: adresi bilen herkes verileri
  görür ve değiştirebilir. Bu yüzden demo ortamında bile uygulamayı yalnızca
  güvenli ağda/VPN arkasında açın ya da önüne kimlik doğrulamalı ters vekil koyun.
- Hasta adı/kimliği, klinik bilgi, anahtar kesitler ve DICOM dosyaları diskte
  AES-256-GCM ile şifrelidir; denetim kaydı hash zincirlidir.
- Harici LLM isteği yalnızca isteğe bağlıdır ve hasta adı/kimliği gönderilmez;
  ancak klinik not serbest metin olduğu için PHI taşıma riski kullanıcıdadır.

## Raporum ve İzlenebilirlik

- Tüm yetkili eylemler denetim kaydına yazılır ve hash zinciriyle doğrulanabilir
  (Yönetim → Denetim → “Hash zincirini doğrula”).
- Üretim dağıtımlarında TLS, yedekleme, saklama/silme politikası ve erişim logları
  kurum sorumluluğundadır; yazılım bunları zorunlu kılmaz.

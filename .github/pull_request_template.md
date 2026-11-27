## Özet

<!-- Ne ve neden? -->

## Kılavuz güncellemesi (zorunlu kural)

- [ ] Arayüz/menü/düğme/kısayol değişikliği varsa `docs/MENU_KILAVUZU.md` güncellendi
      (birebir ipucu metinleri + ilgili bölge satırı) **ve** `npm run test:guide-coverage` geçiyor
- [ ] Kurulum/çalıştırma adımı değiştiyse `docs/KURULUM_VE_KULLANIM.md` güncellendi
- [ ] Görüntü eklendiyse anonim (sekme çubuğu / görev çubuğu yok, hasta verisi yok)
- [ ] Görsel akış değiştiyse `docs/GORSEL_ANLATIM.md` §4–§7 güncellendi
- [ ] Yeni görünen metinler 78 tam çeviri paketine eklendi (`npm run test:i18n` yeşil); yeni dil ise `npm run i18n:new` + [docs/CEVIRI_KATKI.md](../docs/CEVIRI_KATKI.md)
- [ ] Değişiklik yoksa nedenini yazın: ________________________________

## Klinik / araştırma etiketi

- [ ] AI çıktısı research etiketli; klinik karar iddiası yok
- [ ] Yeni model ise model kartı + lisans bildirimi eklendi

## Test planı

- [ ] `npm test` (CI) yeşil
- [ ] Ek doğrulama: ________________________________

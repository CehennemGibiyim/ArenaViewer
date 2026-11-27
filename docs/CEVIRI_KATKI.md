# Çeviri Katkısı — yeni dil paketi nasıl eklenir

ARENA Viewer arayüzü **78 dille eksiksiz çevrilidir** (`src/i18n/*.json`). Buna ek
olarak dil seçicisi **ISO 639-3 standardındaki 7.027 canlı dilin tümünü** listeler;
çevirisi henüz yapılmamış bir dil seçilirse arayüz **İngilizce yedeğiyle** açılır
(bilinçli dürüst davranış — makine çevirisiyle doldurulmuş, doğrulanmamış paket
yayımlanmaz; kapsam kaliteden ödün vermez).

Herkes, kendi anadilini tam destekli dil listesine eklemek için katkıda bulunabilir.

## Adımlar

1. **İskeleti üretin** (en.json kopyası + `src/lib/i18n.ts` kayıtları otomatik):

   ```bash
   npm run i18n:new -- <kod> "<Native ad>" "<İngilizce ad>" [rtl|ltr]
   # örnekler: npm run i18n:new -- quc "K'iche'" "Kʼicheʼ" ltr
   #          npm run i18n:new -- uz "Oʻzbekcha" "Uzbek" ltr
   ```

   Kod: ISO 639-1 (2 harf, varsa) veya ISO 639-3 (3 harf). Yaşayan ISO 639-3
   dilinde değilse araç uyarır.
2. **Çevirin** `src/i18n/<kod>.json` içindeki tüm anahtarları — **anlamlı çeviri**;
   değerleri İngilizce bırakmayın, makine çıktısını aynen yapıştırmayın.
   Uzunluk sınırı yok ama üst çubuk dar gelir; kısa ve doğal tutun.
3. **Doğrulayın:** `npm run test:i18n` — anahtar paritesi, boş değer yasağı ve
   kayıt bütünlüğü CI'rdaki `npm test` ile aynı kapıdır.
4. **Kılavuzu güncelleyin:** dil sayısı geçen yerleri güncelleyin
   (`docs/KILAVUZ_BAKIMI.md` zorunludur) ve `docs/GORSEL_ANLATIM.md` §7.3 listesine ekleyin.
5. **PR açın.** Sourcer/yorum istemeyin; `npm run test:i18n` yeşilse ve anlamlı
   çeviriyse inceleme hızlıdır. Türkçe-İngilizce dışındaki dillerde ana dili o dil
   olan bir gözden geçirici idealdir ama şart değildir.

## Kurallar (değiştirilemez)

- **CI eşiği:** anahtarlar `en.json` ile birebir olmalı; boş değer bırakılamaz.
- **Anlamlı çeviri:** İngilizce kopyası olduğu gibi duran paket reddedilir.
- **Bir dilden fazlasını "toplu" eklemeyin:** her dil kendi PR'ında; gerekçe ve
  test kanıtı ayrı ayrı görünsün.
- **Belge metinleri dahil değildir:** kılavuzlar ve uzun raporlar Türkçe kalır;
  çevrilen katman arayüz kromudur (üst çubuk, durum şeridi, tema/dil seçicileri,
  düğme etiketleri).
- Katalog (`src/i18n/catalog.json`) **üretilmiş veridir**, elle düzenlenmez;
  güncelleme `npm run i18n:catalog` ile (girdi: `iso-639-3` paketi, ISO 639-3 / SIL).

## Sık sorulan: "Tüm diller neden hemen çevrilmiyor?"

Dünyada ~7.000 yaşayan dil var; 78'i konuşucuların ~%90'ını kapsıyor. Kalan ~6.950
dilin her biri 30 anahtarın özenli, doğrulanabilir çevirisiyle gelir — binlerce
dilin doğrulanamayan çıktısını "destekleniyor" diye göstermektense, herkes her dili
**seçebilsin** ama arayüz yedeğiyle açılsın: destek iddiasını ancak çeviri ve CI
yapar. Bu yüzden katkı açık ve tek komuttur.

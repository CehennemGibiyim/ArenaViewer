# Kılavuz Bakımı — zorunlu süreç

> **Kural:** Arayüze eklenen, kaldırılan veya yeniden adlandırılan **her** menü / düğme / sekme / kısayol,
> **aynı PR içinde** kullanım kılavuzuna işlenir. "Sonra düzeltiriz" yoktur — CI bunu zorlar.

## Neden

- Kılavuz ([`MENU_KILAVUZU.md`](MENU_KILAVUZU.md)) ile arayüz arasında fark oluştuğunda kullanıcı yanlış düğmeye basar;
  klinik yazılımda yanlış düğme = yanlış işlem.
- ATIKVIEWER **araştırma etiketlidir** ve her değişiklik izlenebilir olmalıdır; kılavuz farkı sürüm notu yerine geçmez.

## Ne zaman ne güncellenir

| Değişiklik | Güncellenecek |
|---|---|
| Düğme/araç eklendi·silindi·ipucu değişti | [`MENU_KILAVUZU.md`](MENU_KILAVUZU.md) — ilgili bölge satırı; **birebir metin** tabloya ve (varsa) §17 referansına |
| Yeni sekme/panel | Bölge 11 yapısı + `docs/menu-kilavuzu.manifest.json` |
| Yeni sayfa (`src/app/**`) | §14 tablosu + gerekiyorsa `KURULUM_VE_KULLANIM.md` §8 bağlantısı |
| Yeni klavye kısayolu | §12 tablosu + `src/lib/shortcuts.ts` + varsa `tests/` |
| Hasta verisi gösteren yeni ekran görüntüsü | `docs/img/` — **anonimleştirerek** (sekme çubuğu ve görev çubuğu kırpılmalı; hasta adı/ID yok) |
| Yeni modal/işlem akışı | İlgili bölgeye akış özeti; **[GORSEL_ANLATIM.md](GORSEL_ANLATIM.md)** §4–§7 akışı güncellenir; gerekirse yeni diyagram (PIL/mermaid, < 100 KB JPEG/SVG) |
| Görsel akış adımı / ekran değişti | GORSEL_ANLATIM.md ilgili bölümü; görüntü güncellendiyse sıkıştırılmış JPEG (q82) veya elle SVG; **hasta verisi asla** |
| Yeni görünen metin / düğme etiketi | [`src/i18n/*.json`](../src/i18n) — **24 dil paketi** aynı anahtarlarla güncellenir; `npm run test:i18n` yeşil |
| Yeni dil paketi | `src/i18n/<kod>.json` + `LANGUAGES` + `registry` satırı; `en.json` anahtarları birebir; `npm run test:i18n` |
| Belge değişikliği (docs/*.md) | Varsa GORSEL_ANLATIM / SSS / MENU_KILAVUZU çapraz bağlantıları gözden geçir |
| Yalnız arka uç / DB değişikliği | Kılavuz gerekmez; PR açıklamasında "kılavuz gerekmedi" yazın |

## Nasıl zorlanır

```bash
npm run test:guide-coverage   # tests/guide-coverage.test.ts — statik title/aria-label ↔ kılavuz birebir
npm run test:i18n             # tests/i18n-coverage.test.ts — 24 paket anahtar paritesi + kayıt/registry
```

- `src/components/Workstation.tsx`, `RightPanel.tsx`, `KneeSegPanel.tsx` dosyalarındaki **statik**
  `title="…"` ve `aria-label="…"` metinlerinin tamamı kılavuzda birebir geçmelidir.
- [`menu-kilavuzu.manifest.json`](menu-kilavuzu.manifest.json) içindeki küratörlü anchor'lar da geçmelidir.
- `KURULUM_VE_KULLANIM.md`, menü kılavuzuna bağlanmalıdır.
- Ayrıca `src/components/{Workstation,RightPanel,KneeSegPanel,LanguageMenu,IntendedUseModal}.tsx` taranır; yeni statik `title`/`aria-label` doğrudan kılavuza bağlıdır.
- Dil paketleri için `test:i18n`, her paketin `en.json` ile anahtar eşleşmesini ve `src/lib/i18n.ts` kaydını doğrular — eksik anahtar ya da kayıt unutulursa CI kırmızıdır.
- `npm test` zinciri her iki testi de içerir; GitHub Actions CI'da her PR ve main itmesinde koşar.

## Kontrol listesi (PR yazarına)

- [ ] UI öğesi eklendi/değişti → `MENU_KILAVUZU.md` güncel
- [ ] Yeni statik `title`/`aria-label` → §17 referansına eklendi
- [ ] `npm run test:guide-coverage` geçiyor
- [ ] Görüntü değiştiyse yenileri anonim (sekme çubuğu/görev çubuğu yok, hasta verisi yok)
- [ ] Kılavuz gerekmediyse neden yazıldı
- [ ] Görsel akış değiştiyse **GORSEL_ANLATIM.md** adımı/görseli güncellendi
- [ ] Yeni görünen tüm metinler **24 dil paketine** eklendi (`npm run test:i18n` yeşil)

## Belge kümesi ve değişmezler

- Gösterge: arayüz = **MENU_KILAVUZU.md**, uçtan uca akış = **[GORSEL_ANLATIM.md](GORSEL_ANLATIM.md)**, şikâyet/cevap = **[SSS.md](SSS.md)** (uygulama içi: `/yardim`).
- Üçü birbirine bağlanır; biri değişince diğerleri gözden geçirilir.
- `ar`/`he` RTL dillerinde yerleşim LTR kalır — RTL görsel denetimi yapılana kadar yeni çeviri eklerken bu bilinçli sınıra uyun.
- "Dünyadaki tüm diller" taahhüdü değildir: **24 pilot paket** bakım eşiğini karşılar; yeni dil ancak kayıt + `test:i18n` + anlamlı çeviri ile girer. Kalite < kapsam.

## Sürüm notu

Her kılavuz güncellemesi PR açıklamasında ve `CHANGELOG`e kısa not olarak geçer ("docs: …").

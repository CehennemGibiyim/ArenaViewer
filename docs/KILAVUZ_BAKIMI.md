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
| Yeni modal/işlem akışı | İlgili bölgeye akış özeti; gerekirse yeni diyagram (PIL/mermaid, < 100 KB JPEG) |
| Yalnız arka uç / DB değişikliği | Kılavuz gerekmez; PR açıklamasında "kılavuz gerekmedi" yazın |

## Nasıl zorlanır

```bash
npm run test:guide-coverage   # tests/guide-coverage.test.ts
```

- `src/components/Workstation.tsx`, `RightPanel.tsx`, `KneeSegPanel.tsx` dosyalarındaki **statik**
  `title="…"` ve `aria-label="…"` metinlerinin tamamı kılavuzda birebir geçmelidir.
- [`menu-kilavuzu.manifest.json`](menu-kilavuzu.manifest.json) içindeki küratörlü anchor'lar da geçmelidir.
- `KURULUM_VE_KULLANIM.md`, menü kılavuzuna bağlanmalıdır.
- `npm test` zinciri bu testi içerir; GitHub Actions CI'da her PR ve main itmesinde koşar.

## Kontrol listesi (PR yazarına)

- [ ] UI öğesi eklendi/değişti → `MENU_KILAVUZU.md` güncel
- [ ] Yeni statik `title`/`aria-label` → §17 referansına eklendi
- [ ] `npm run test:guide-coverage` geçiyor
- [ ] Görüntü değiştiyse yenileri anonim (sekme çubuğu/görev çubuğu yok, hasta verisi yok)
- [ ] Kılavuz gerekmediyse neden yazıldı

## Sürüm notu

Her kılavuz güncellemesi PR açıklamasında ve `CHANGELOG`e kısa not olarak geçer ("docs: …").

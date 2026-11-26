# Katkı Kılavuzu — ATIKVIEWER

## Geliştirme akışı

```bash
npm ci
cp .env.example .env        # PostgreSQL varsayılanı; Docker için docs/KURULUM_VE_KULLANIM.md §3.4
npm run dev                  # http://localhost:3000
npm test                     # tüm birim/entegrasyon testleri
npm run lint && npm run typecheck
```

## Kılavuz zorunluluğu (CI ile uygulanır)

Arayüze eklenen, kaldırılan veya yeniden adlandırılan **her menü/düğme/sekme/kısayol**,
**aynı PR içinde** [`docs/MENU_KILAVUZU.md`](docs/MENU_KILAVUZU.md) belgesine işlenir ve
`npm run test:guide-coverage` yeşildir. Ayrıntı ve kontrol listesi: [docs/KILAVUZ_BAKIMI.md](docs/KILAVUZ_BAKIMI.md).
PR şablonu bu adımı hatırlatır; atlanması CI kırmızı demek, dolayısıyla merge yoktur.

## Klinik / araştırma etiketi kuralı

Tüm AI çıktıları research etiketlidir; tanı koyma iddiası taşımaz. Yeni model eklendiğinde
**model kartı** (sürüm, amaçlanan kullanım, sınırlılıklar, doğrulama) ve lisans bildirimi
repoda yer almalıdır (ör. `ai-worker/models/NOTICE-*.md`).

## Kıyaslama dürüstlüğü

[`/kiyaslama`](/kiyaslama) sayfasındaki GAP tablosunda **kod yoksa satır yok**: bir özellik
yalnızca gerçek, test edilmiş kod varsa "var/kısmi" olarak kaydedilir. `test:gap-sources`
kaynak dosya yollarını diskten doğrular.

## Commit ve PR

- Kısa, emir kipinde, `kapsam: özet` biçiminde commit mesajları (`feat(`, `docs(`, `fix(`).
- PR şablonunu doldurun; "Kılavuz güncellendi" kutusunu yalnızca gerçekten güncellediyseniz işaretleyin.
- CI (`npm test`, lint, typecheck) zorunludur.

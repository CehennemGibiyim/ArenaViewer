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
`npm run test:guide-coverage` yeşildir. **Ayrıca iki eşlik zorunluluğu vardır:**

1. **Resimli anlatım:** [`docs/GORSEL_ANLATIM.md`](docs/GORSEL_ANLATIM.md) §4–§7 içindeki ilgili
   adım/görsel güncellenir (hasta verisi asla; sıkıştırılmış JPEG q82 / elle SVG, depo hedefi < 1 MB).
2. **Dil paketleri:** yeni görünen her metin `src/i18n/*.json` içinde **83 tam çeviri dilinde** eklenir;
   `npm run test:i18n` yeşildir. Yeni bir dil ekleniyorsa tek komut `npm run i18n:new` +
   anlamlı çeviri + `npm run test:i18n` kullanılır — ayrıntı: [docs/CEVIRI_KATKI.md](docs/CEVIRI_KATKI.md).

Ayrıntı ve kontrol listesi: [docs/KILAVUZ_BAKIMI.md](docs/KILAVUZ_BAKIMI.md).
PR şablonu bu adımları hatırlatır; atlanması CI kırmızı demek, dolayısıyla merge yoktur.

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

# SAML 2.0 Service Provider (SP) bağlayıcısı

Kurumsal kimlik sağlayıcısı (ADFS, Keycloak, SimpleSAMLphp, Okta vb.) ile
**SP-initiated** giriş. Uygulama kendi XML/imza altyapısını kullanır: harici XML,
crypto veya SAML kütüphanesi yoktur (`src/lib/server/xmlC14n.ts`, `saml.ts`).

## Akış

```
tarayıcı → GET /api/auth/saml/start?next=/rapor/42
        ← 303 https://idp/sso?SAMLRequest=<DEFLATE+base64>&RelayState=<rastgele>
             + av_saml çerezi (HMAC imzalı: requestID, RelayState, ACS, dönüş yolu, zaman)
IdP      → kullanıcıyı doğrular, imzalı SAMLResponse üretir
tarayıcı → POST /api/auth/saml/callback  (SAMLResponse + RelayState)
        ← 303 /rapor/42 + oturum çerezi (imza/koşullar/replay doğrulandıysa)
```

`GET /api/auth/saml/metadata` SP meta verisini yayınlar (entityID + ACS + NameID
biçimi); IdP'ye bu adres yüklenir.

## Yapılandırma

| Değişken | Gerekli | Açıklama |
|---|---|---|
| `SAML_IDP_SSO_URL` | **Evet** | IdP'nin SSO ucu (HTTP-Redirect binding), ör. `https://adfs.hastane.local/adfs/ls/` |
| `SAML_IDP_ENTITY_ID` | **Evet** | Yanıttaki `Issuer` ile **birebir** eşleşmeli |
| `SAML_IDP_CERT` | **Evet** | IdP imza sertifikası: PEM (`-----BEGIN CERTIFICATE-----`) ya da metadata'dan kopyalanan yalın base64 DER. Açık anahtar PEM de kabul edilir |
| `SAML_ENTITY_ID` | Hayır | SP entityID (varsayılan `atikviewer-sp`); `Audience` olarak beklenir |
| `SAML_ACS_URL` | Hayır | Sabit dönüş adresi; verilmezse istek kökeninden üretilir (ters vekil arkasında **verin**) |
| `SAML_LABEL` | Hayır | Giriş düğmesi etiketi |
| `SAML_ATTR_NAME` / `SAML_ATTR_MAIL` / `SAML_ATTR_GROUPS` | Hayır | Talep adları (varsayılan `displayName` / `mail` / `memberOf`) |
| `SAML_NAME_ID_FORMAT` | Hayır | İstenen NameID biçimi (varsayılan e-posta adresi) |
| `SAML_ADMIN_GROUP` | Hayır | Bu gruptaki kullanıcılar yönetici olur (tam CN ya da grup DN'i) |
| `SAML_DEFAULT_ROLE` | Hayır | Yeni hesapların rolü (varsayılan `radyolog`) |
| `SAML_AUTO_PROVISION` | Hayır | `0` → yalnız önceden bağlanmış hesaplar girebilir |
| `SAML_LINK_BY_EMAIL` | Hayır | `1` → aynı kullanıcı adına sahip bağlı olmayan hesap devralınır (**varsayılan kapalı**: SAML'de "doğrulanmış e-posta" kavramı yok) |
| `SAML_SKIP_TOTP` | Hayır | `0` → SSO ile giren yönetici ayrıca uygulama TOTP'si ister |
| `SAML_CLOCK_SKEW_SEC` | Hayır | Saat kayması toleransı (varsayılan 120, en çok 600) |
| `SAML_ALLOW_SHA1` | Hayır | `1` → SHA-1 imzalı yanıtlara izin verilir (**varsayılan: reddet**) |

Üç zorunlu alan birlikte tanımlı değilse bağlayıcı **kapalı** sayılır: `/giris`'te
düğme çıkmaz, hiçbir SAML isteği üretilmez. Sertifika `createPublicKey` ile
doğrulanamıyorsa da özellik kapanır (yarı çalışır durum bırakılmaz).

## Doğrulama zinciri (her adım zorunlu)

1. **Durum çerezi** `av_saml`: HMAC imzası, 10 dk ömür, `requestID`/`RelayState`/ACS.
2. **RelayState** formdaki değer çerezdekiyle aynı olmalı (CSRF bağlacı).
3. **XML**: DOCTYPE/ENTITY reddedilir (XXE), tek kök, eşleşmeyen etiket reddi.
4. **İmza** (XML DSig, enveloped): Assertion imzası yeğlenir, yoksa Response imzası.
   - `SignedInfo` + referans özeti **kanonikleştirilerek** doğrulanır (Exclusive C14N
     varsayılan; inclusive C14N de desteklenir).
   - Dönüşümlerden yalnız `enveloped-signature` ve C14N kabul edilir (XSLT vb. reddedilir).
   - RSA-SHA256/384/512 kabul; **RSA-SHA1 varsayılan reddedilir**.
   - Anahtar yalnız yapılandırmadaki sertifikadır; belgeye gömülü `KeyInfo` **güvenilmez**.
5. **Status** `...:Success` olmalı.
6. **Issuer** = `SAML_IDP_ENTITY_ID`; **Destination** (varsa) = ACS.
7. **Conditions**: `NotBefore`/`NotOnOrAfter` (saat kayması toleransıyla) ve
   `AudienceRestriction` içinde `SAML_ENTITY_ID`.
8. **SubjectConfirmationData**: `Recipient` = ACS, `NotOnOrAfter` geçerli,
   `InResponseTo` = çerezdeki AuthnRequest ID.
9. **Tek kullanım**: doğrulanan `Assertion ID` `saml_replay` tablosuna yazılır;
   aynı ID ikinci kez gelirse **reddedilir** (replay). Tablo süre dolunca temizlenir.
10. **Hesap**: `(IdP entityID, NameID)` eşleşmesi → (opsiyonel) kullanıcı adı
    devralma → `SAML_AUTO_PROVISION`. Yönetici grubu rolü **yükseltir**; düşürmez.
11. **MFA politikası** ve **sunucu oturumu** (`sessions`), denetim kaydı
    `auth.login.saml` (başarısızlar `auth.login.saml_rejected` + neden).

Kullanıcı adı NameID/e-postanın **yerel kısmından** üretilir
(`ayse.kaya@hastane.local` → `ayse.kaya`); e-posta ayrı alanda tutulur.

## Test

```bash
npm run test:saml                        # imza/c14n/koşullar (ağ ve DB yok)
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:saml-integration          # sahte IdP (gerçek HTTP + imza) + gerçek PostgreSQL
```

Çekirdek testi 9 blok: yapılandırma, XML güvenliği, c14n **bilinen yanıt**
örnekleri, AuthnRequest/redirect, durum çerezi, geçerli yanıt → kimlik,
normalizasyon (öznitelik sırası/boşluk tolere edilir, metin değişikliği edilmez),
9 olumsuz senaryo (imzasız, audience, süre, recipient, InResponseTo, veren, status,
SHA-1) ve hata metinleri. Entegrasyon testi 10 blok: start, başarılı dönüş (hesap +
oturum + denetim), replay, tekrar giriş, yönetici rolü, otomatik açma kapalı, MFA,
kurcalama/imzasız/süre/audience/InResponseTo, çerezsiz dönüş, metadata.

## Bilinen sınırlar (dürüst liste)

- **SP-initiated** akış; IdP-initiated (IdP'den doğrudan POST) desteklenmez.
- Yalnız **HTTP-POST** yanıt binding'i; artifact binding ve HTTP-Redirect yanıtı yok.
- AuthnRequest **imzalanmaz** (`AuthnRequestsSigned="false"`); IdP bunu zorunlu
  tutuyorsa imzalı istek eklenmelidir.
- **Şifreli assertion** (`EncryptedAssertion`) desteklenmez; IdP'de şifreleme kapatılmalı.
- **SLO** (tek çıkış) ve NameID biçim dönüşümü yok.
- C14N alt kümesi: yorum/işlem yönergesi içeren belgelerde c14n uygulanır ama
  `InclusiveNamespaces PrefixList` özniteliği yok sayılır; egzotik IdP çıktısı
  doğrulanamazsa giriş **reddedilir** (fail-closed).
- Grup üyeliği yalnız talep (attribute) olarak okunur; iç içe grup/AD sorgusu yok.
- Hekim çoklu üyelikleri hâlâ yok.

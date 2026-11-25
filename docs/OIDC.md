# Kurumsal giriş (OpenID Connect)

ATIKVIEWER, hastane diziniyle giriş için **authorization code + PKCE** akışını
destekler. Parola ve MFA kimlik sağlayıcıda (Keycloak, Entra ID, Authentik,
Okta, Google Workspace…) doğrulanır; uygulama yalnız imzalı ID token'ı doğrular.

## 1. Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `OIDC_ISSUER` | Evet | Sağlayıcı kökü, ör. `https://sso.hastane.local/realms/rad`. Keşif belgesi `{issuer}/.well-known/openid-configuration` adresinden okunur. |
| `OIDC_CLIENT_ID` | Evet | Uygulama istemci kimliği |
| `OIDC_CLIENT_SECRET` | Hayır | Confidential client kullanılıyorsa (Basic auth ile gönderilir). Public client + PKCE için boş bırakın. |
| `OIDC_REDIRECT_URI` | Hayır | Sabit dönüş adresi. Boşsa istek kökeninden `.../api/auth/oidc/callback` üretilir — ters vekil arkasında **açıkça verin**. |
| `OIDC_SCOPES` | Hayır | Varsayılan `openid email profile` |
| `OIDC_LABEL` | Hayır | Giriş düğmesi etiketi (varsayılan "Kurumsal kimlikle giriş") |
| `OIDC_ADMIN_GROUP` | Hayır | Bu gruptaki kullanıcılar **yönetici** olur. `groups`, `roles` veya `realm_access.roles` talepleri okunur. |
| `OIDC_DEFAULT_ROLE` | Hayır | Yeni hesapların rolü: `radyolog` (varsayılan) / `teknisyen` / `yonetici` |
| `OIDC_AUTO_PROVISION` | Hayır | `0` → yalnız önceden bağlanmış hesaplar girebilir (kapalı devre kurulumlar) |
| `OIDC_LINK_BY_EMAIL` | Hayır | `0` → mevcut hesap, e-posta doğrulanmış olsa bile devralınmaz |
| `OIDC_SKIP_TOTP` | Hayır | `0` → SSO ile giren hesap **ayrıca** uygulama TOTP'si ister (varsayılan `1`: MFA'yı IdP yapar) |

> `ACCESS_TOKEN` kapısı ile kurumsal giriş birlikte kullanılmaz: OIDC ile giren
> kullanıcı erişim anahtarını bilemez. İkisi tanımlıysa başlatma ucu `409` döner.

## 2. Sağlayıcıda yapılacaklar

1. Yeni bir **public** (PKCE) veya confidential istemci oluşturun.
2. Dönüş adresi: `https://<uygulama-adresi>/api/auth/oidc/callback`.
3. Kapsamlar: `openid, email, profile` (+ grup talebi için dizin ayarınız).
4. Yönetici grubunu tanımlayın (ör. `rad-yonetici`) ve `OIDC_ADMIN_GROUP` ile eşleyin.
5. Kullanıcı adının kararlı olduğundan emin olun: `preferred_username` (yoksa
   `email` yerel kısmı) uygulama kullanıcı adına çevrilir.

## 3. Örnek (Keycloak)

```bash
OIDC_ISSUER=https://sso.hastane.local/realms/rad
OIDC_CLIENT_ID=atikviewer
OIDC_CLIENT_SECRET=            # public client + PKCE
OIDC_REDIRECT_URI=https://atikviewer.hastane.local/api/auth/oidc/callback
OIDC_ADMIN_GROUP=rad-yonetici
OIDC_DEFAULT_ROLE=radyolog
OIDC_SKIP_TOTP=1
AUTH_MODE=hesap
SESSION_SECRET=<32+ bayt rastgele>
```

`/giris` sayfasında "🏥 Kurumsal kimlikle giriş" düğmesi görünür. Düğme
`/api/auth/oidc/start?next=/…` adresine gider; akış hatasız biterse kullanıcı
`next` yoluna döner ve normal imzalı oturum çerezi (`sessions` kaydıyla) kurulur —
bu oturum Yönetim → **Oturumlar** ekranından iptal edilebilir.

## 4. Güvenlik kararları (neden böyle)

| Konu | Karar |
| --- | --- |
| CSRF | `state` + `nonce` + PKCE verifier imzalı `av_oidc` çerezinde (httpOnly, 10 dk). URL'de taşınmaz. |
| İmza | Yalnız **RS256**; `alg: none` / HS256 reddedilir (algoritma karışıklığı). |
| Anahtar | JWKS'ten `kid` ile seçilir; anahtar birden fazlaysa kid zorunlu. |
| Talepler | `iss` birebir, `aud` istemci kimliğini içerir, `exp`/`iat` 60 sn toleransla, `nonce` birebir. |
| Bağlama | Önce (issuer, sub). E-posta ile devralma yalnız `email_verified: true` ve hesap başka bir kimliğe bağlı değilse. |
| Rol | Grup üyeliği yöneticiye **yükseltir**; otomatik düşürme yoktur (yanlış grup ayarı yöneticiyi kilitlemesin). |
| Açık yönlendirme | `next` yalnız `/` ile başlayan yerel yol; `//` reddedilir. |
| Denetim | `auth.login.oidc` (created/linked/roleUpgraded + oturum kimliği kısaltması) hash zincirli kayda yazılır. |
| Parola | SSO hesabının parolası yoktur (`-`); SSO kesintisinde yönetici parola atayabilir. |

**Kalan sınırlar:** SAML 2.0 ve LDAP bağlayıcısı yoktur; tek istemci (tek
`OIDC_ISSUER`) desteklenir, çoklu dizin/üyelik yoktur. IdP'nin MFA uyguladığı
varsayılır (`OIDC_SKIP_TOTP=1`); `acr`/`amr` talepleri denetlenmez.

## 5. Testler

```bash
npm run test:oidc              # saf çekirdek: PKCE, state, RS256 doğrulama, eşleme
# ayrılmış test veritabanı + sahte IdP:
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:oidc-integration
```

Entegrasyon testi kendi sahte IdP'sini (keşif + JWKS + token ucu, gerçek RSA
imzası) başlatır; PKCE challenge'ı gerçekten doğrular ve şu yolları kapsar:
ilk giriş/hesap açma, tekrar giriş, yönetici grubu, e-posta ile bağlama, state/
nonce/imza hataları, otomatik açma kapalı, MFA zorunluluğu ve yapılandırma yokluğu.

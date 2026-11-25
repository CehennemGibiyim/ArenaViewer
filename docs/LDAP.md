# LDAP / Active Directory bağlayıcısı

Bu sürümde kurumsal dizin (OpenLDAP, Active Directory, FreeIPA vb.) üzerinden
giriş desteklenir. Sayfa `/giris` aynı formu kullanır: kullanıcı adı + parola önce
yerel hesapta denenir, başarısızsa dizin sunucusuna sorulur.

Uygulama LDAP'ye **yalnız standart LDAPv3** ile bağlanır; kendi BER kodlayıcı/
çözücüsü vardır (`src/lib/server/ldap.ts`), harici LDAP kütüphanesi kullanılmaz.
Desteklenen işlemler: `BindRequest` (simple), `SearchRequest` (wholeSubtree),
`SearchResultEntry`, `SearchResultDone`.

## Yapılandırma

| Değişken | Gerekli | Açıklama |
|---|---|---|
| `LDAP_URL` | **Evet** | `ldap://dc1.hastane.local:389` ya da `ldaps://…:636`. `ldaps` TLS doğrulaması yapar (özel CA için `NODE_EXTRA_CA_CERTS`). |
| `LDAP_BASE_DN` | Birinci mod | Aramanın kökü, ör. `dc=hastane,dc=local`. |
| `LDAP_BIND_DN` + `LDAP_BIND_PASSWORD` | Birinci mod | Kullanıcı araması için servis hesabı. Yalnız **okuma** yetkisi yeterlidir. |
| `LDAP_USER_DN_TEMPLATE` | İkinci mod | Servis hesabı yoksa: `uid={username},ou=people,dc=hastane,dc=local` (AD: `{username}@hastane.local`). |
| `LDAP_USER_FILTER` | Hayır | Varsayılan `(\|(sAMAccountName={username})(uid={username}))`. `{username}` RFC 4515 ile kaçırılır. |
| `LDAP_ATTR_NAME` / `LDAP_ATTR_MAIL` / `LDAP_ATTR_GROUPS` | Hayır | Varsayılan `cn` / `mail` / `memberOf`. |
| `LDAP_ADMIN_GROUP` | Hayır | Üyeliği yönetici rolü veren grup: tam DN (`CN=RAD-Yonetici,OU=Gruplar,DC=…`) ya da yalnız CN (`RAD-Yonetici`). |
| `LDAP_DEFAULT_ROLE` | Hayır | Yeni hesapların rolü (`radyolog` varsayılan; `yonetici` dışındaki roller). |
| `LDAP_AUTO_PROVISION` | Hayır | `1` (varsayılan) ilk girişte hesap açar; `0` ise yalnız önceden tanımlı/bağlı hesaplar girer (403). |
| `LDAP_TIMEOUT_MS` | Hayır | Bağlanma/yanıt zaman aşımı, 1000–30000 ms (varsayılan 5000). |

Yapılandırma geçerli değilse (URL yok, ne taban DN ne şablon var) bağlayıcı
**kapalı** sayılır: `/giris` ipucu göstermez, LDAP'ye hiç bağlanılmaz.

## Giriş akışı (arama modu)

1. Servis hesabıyla `bind` (başarısızsa 503 — yapılandırma hatası).
2. `LDAP_BASE_DN` altında `LDAP_USER_FILTER` ile arama; ilk kayıt alınır.
3. **Kullanıcının DN'i ve parolasıyla** yeniden `bind` → parola doğrulanır.
   Parola hiçbir yerde saklanmaz; uygulama hesabında `password_hash = "-"`.
4. `cn`/`mail`/`memberOf` okunur; `LDAP_ADMIN_GROUP` üyeliği yönetici yapar.
5. Hesap eşleme: `users.ldap_dn` eşleşmesi → aynı kullanıcı adına sahip **bağlı
   olmayan** hesabı devralma → `LDAP_AUTO_PROVISION` açıksa yeni hesap.
6. Oturum `sessions` tablosuna yazılır, denetim kaydı `auth.login` +
   `"method":"ldap"` + `{"ldap":{"created":…,"linked":…,"roleUpgraded":…}}` olur.

Doğrudan mod (`LDAP_USER_DN_TEMPLATE`, servis hesabı yok): DN şablondan üretilir,
tek `bind` yapılır; gruplar kullanıcı yetkisiyle aranır, okunamazsa giriş yine
geçerlidir ama rol varsayılan kalır.

## Güvenlik kararları

- **Boş parola reddedilir** ve ağa hiç çıkılmaz. LDAP'te boş parolalı simple bind
  "unauthenticated bind" sayılabilir ve bazı sunucular **başarı** döndürür; bu,
  kimlik doğrulamayı tamamen atlatırdı. Test bunu doğrular (`bindCalls` artmaz).
- **Filtre enjeksiyonu:** kullanıcı adı RFC 4515 (`\2a \28 \29 \5c \00`) ile
  kaçırılır; `*)(uid=*` gibi girdiler joker etkisi yaratmaz.
- **DN enjeksiyonu:** şablona giren değer RFC 4514 ile kaçırılır (`\,` `\=` `\+` …).
- **Kilitli/pasif hesap LDAP ile atlanmaz:** yerel hesap kilitliyse (423) ya da
  pasifse (401) dizin hiç denenmez.
- **Aynı kullanıcı adı başka dizin kimliğine bağlıysa** giriş reddedilir (hesap
  ele geçirme engeli); bağlı olmayan yerel hesap devralınır ve DN yazılır.
- **Rol düşürülmez:** dizin yönetici grubundan çıkarılan kullanıcının uygulama
  rolü otomatik düşmez (elle yapılır) — kazara yetki kaybını önlemek için.
- **Hata ayrımı:** dizin sunucusu yoksa 503 + açıklama döner; "parola hatalı"
  denmez (yanlış teşhis ve gereksiz kilitlenmeyi önler). Hatalı parola 401 +
  kalan deneme sayısıdır ve yerel kilitleme sayacı işler.
- TLS sertifika doğrulaması kapatılamaz; `ldap://` yalnız güvenli ağda kullanılmalı.
- LDAP parolası hiçbir log/denetim kaydına yazılmaz.

## Bilinen sınırlar

- SASL/Kerberos (GSSAPI), StartTLS ve sayfalama (paged results) yok.
- Şifre değiştirme (`ModifyRequest`) ve parola politikası denetimi yok.
- İç içe grup (`memberOf` zinciri) çözülmez; AD'de kullanıcının doğrudan
  `memberOf` listesi okunur (birincil grup dahil değildir).
- Dizin **kimlik doğrulaması** için kullanılır; yetkilendirme hâlâ uygulama
  rollerinden gelir (dizin grupları → yalnız "yönetici" eşlemesi).
- Hekim çoklu üyelikleri (tek kullanıcı, çok kurum) hâlâ yok.

## Test

```bash
npm run test:ldap          # BER, filtre/DN kaçışı, ayrıştırma (ağ yok)
# Gerçek PostgreSQL + sahte dizin sunucusu (gerçek TCP/BER konuşur):
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:ldap-integration
```

Entegrasyon testi 9 blok doğrular: ilk giriş (hesap + oturum + denetim), tekrar
giriş (mükerrer hesap yok), yönetici grubu yükseltmesi, hatalı/boş parola ve
bilinmeyen kullanıcı, filtre enjeksiyonu, otomatik açma kapalı (403), pasif hesap,
doğrudan bind modu ve dizin sunucusu kapalıyken 503.

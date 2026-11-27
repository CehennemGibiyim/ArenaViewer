import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "ATIKVIEWER — Yardım / S.S.S." };

const QA: [string, string][] = [
  ["Yapay zekâ analizi için AI worker’ı ayrıca başlatmam gerekiyor mu?",
    "Evet. Görüntüleyici (Next.js) modelleri kendi içinde çalıştırmaz. Gerçek çıkarım ayrı yerel süreçte yapılır: python ai-worker/server.py → 127.0.0.1:8787 (yalnız bu makine). Windows: windows\\Baslat.bat ikisini birden açar. Docker: docker compose --profile ai up -d. Worker kapalıysa BT analizi kural tabanlıya düşer (ekranda “worker: kapalı” uyarısı çıkar); CXR, beyin (ICH) ve diz MR derin modelleri çalışmaz."],
  ["Peki bir görüntüyü nasıl analiz ederim — otomatik algılar mı?",
    "Hayır, kendiliğinden devreye girmez; siz başlatırsınız. 1) DICOM’i açın (klasör/dosya/ZIP sürükle-bırak). 2) Sağ panel → Vision AI sekmesi. 3) Analiz protokolünü seçin (Otomatik / Tüm karelerde görüntü ölçümü / BT Beyin / BT Toraks / İncelemeyi kapat). 4) “Analizi başlat”. 5) Sonuçlar TASLAK olarak rapora girer ve “KLİNİK KARAR İÇİN KULLANILAMAZ” bandını taşır; son söz radyoloji uzmanındadır. İsterseniz “Tüm yüklenen serileri birlikte AI ile analiz et” ile birden çok seriyi sırayla işleyebilirsiniz."],
  ["Gölge mod nedir?",
    "NEXT_PUBLIC_AI_SHADOW_MODE=true ile açılır: AI adayları rapora/ekrana girmez; yalnız shadow_findings tablosuna yazılır. Doğrulanmamış modeli üretimde sessizce ölçmek içindir."],
  ["Worker'ın gerçekten çalıştığını nasıl anlarım?",
    "Terminal satırı: “ATIKVIEWER AI worker: http://127.0.0.1:8787” + “Model yüklendi.” · curl http://127.0.0.1:8787/health → {\"ok\": true} · Tarayıcıda /paketler sayfası → AI durumu kartı. Ana şeritteki “HAZIR / ANALİZ” görüntüleyicinin kendi durumudur, worker’ın değil."],
  ["Web demosunda (GitHub Pages) AI çalışır mı?",
    "Hayır. Statik demoda /api/* yoktur; AI düğmeleri çalışmaz, /ayna demo etiketlidir. Arayüzü tanımak içindir; gerçek görüntüyle çalışmak için yerel/kurum kurulumu gerekir."],
  ["GPU şart mı? Kaç GB indirme var?",
    "GPU şart değil (CPU’da çalışır, yavaştır; diz MR’da ~80 sn/hacim). CXR 28 MB (depoda) · MONAI BT toraks ≈84 MB · ICH ≈147 MB · diz MR (opsiyonel) ≈1,6 GB (windows\\Kurulum.bat -Knee)."],
  ["PostgreSQL kurmadan çalışır mı?",
    "Görüntüleyici + ölçüm + AI için evet. DB yoksa yalnız kalıcı özellikler çalışmaz: çalışma listesi, sunucuya kaydetme, kayıtlı raporlar, denetim kaydı, STOW-RS. Kurumsal kullanımda PostgreSQL 16+ önerilir (Docker’da otomatik)."],
  ["Verilerim dışarı çıkar mı?",
    "Hayır; worker yalnız 127.0.0.1’de dinler. İsteğe bağlı LLM taslak izlenim özelliği açıkken bile yalnız hekimin onayladığı bulgu metinleri (hasta kimliği OLMADAN) servise gider."],
  ["AI raporu neden TASLAK ve kırmızı uyarıyla geliyor?",
    "ATIKVIEWER tıbbi cihaz değildir ve tanı koymaz. Tüm çıktılar araştırma taslağıdır; rapor onayının sorumluluğu radyoloji uzmanındadır. Bu etiket kaldırılamaz."],
  ["Kırmızı “ConnectionResetError / WinError 10054” traceback’i",
    "Arıza değildir. Keep-alive bağlantısını istemci aniden kapatınca worker yığın izi basardı; 2026-11-26 güncellemesiyle tek satır loga indi (“istemci bağlantıyı kapattı (istek yok, yoksayıldı)”). git pull ile alın."],
  ["Kurulum adımlarını ve menülerin ne işe yaradığını nereden öğrenirim?",
    "docs/KURULUM_VE_KULLANIM.md (tüm işletim sistemleri, görsel+videolu) ve docs/MENU_KILAVUZU.md (numaralı ekran haritasıyla her düğme). Windows ayrıntı: docs/WINDOWS_KURULUM.md."],
  ["Tema seçiyordum ama renkler değişmiyordu — düzeldi mi?",
    "Düzeldi (2026-11-26). Yapısal renkler artık globals.css değişkenlerine bağlı; Koyu (eski görünüm), Klinik Mavi, Açık Tema ve Yüksek Kontrast artık gerçekten çalışır. Seçim atik-theme anahtarında saklanır. Ayrıntı: docs/GORSEL_ANLATIM.md §7.1"],
  ["Dili nasıl değiştiririm? Kaç dil destekliyorsunuz?",
    "Üst çubuktaki 🌐 Dil seç düğmesinden seçin; çevirisi hazır 83 dili arayıp bulun (tr en es fr de it pt nl pl ru uk cs sv ro hu bg ar he hi zh ja ko id th bn ur fa ta te mr gu kn ml pa or vi ms fil ceb da fi el sk sl et lv lt sr hr bs mk sq hy ka az kk ky uz mn sw ha yo ig zu af am ne si my km lo rw so mg ht ca eu gl tuk tat uig bak crh). Ayrıca ISO 639-3 canlı dillerinin tümü (7.027) 2+ harf aramasıyla listelenir — çevirisi olmayan dil arayüz İngilizce yedeğiyle açılır ve “EN UI” rozetiyle işaretlenir. Paket yalnız seçildiğinde indirilir; belgeler ve AI rapor gövdesi Türkçe kalır. Yeni dil PR + npm run test:i18n (tek komut: npm run i18n:new) ile eklenir."],
  ["Görsel anlatım nerede?",
    "Uygulama içinde: /resimlianlatim — adım adım, gerçek ekran görüntüleriyle; her adımda “nerede / ne yapılır / ne olur” ve o adımın web demosunda mı yoksa yalnız yerel kurulumda mı yapılabildiği yazar. Aynı içeriğin belge hâli docs/GORSEL_ANLATIM.md (sıkıştırılmış JPEG + SVG şemalar, ≈653 KB; sürüm etiketinde PDF). Yardım sayfasından ve Ayarlar → /tercihler ekranından bağlantı vardır."],
  ["Yönetim panelindeki «Sistem sağlığı» neyi denetler, neyi denetlemez?",
    "12 kuralı ortam yapılandırmasına bakar (kimlik modu, TLS, anahtar kaynağı, veritabanı, depo, METRICS_TOKEN, SIEM, LLM, istem alımı, HBYS, MFA zorunluluğu, sürüm) ve /api/metrics metinlerini tabloya çevirir. Sır değerleri hiçbir zaman gösterilmez — yalnız «tanımlı / tanımsız». Denetlemedikleri: gerçek PACS/HBYS bağlantısı (Entegrasyon sekmesinde test edilir), model doğruluğu, disk doluluğu, sertifika süresi. Statik web demosunda DB/TLS olmadığı için kart kırmızı görünür ve bunu «DEMO VERİSİ» notuyla yazar."],
  ["Yedek gerçekten geri yüklenebilir mi?",
    "Yönetim → Yedekleme & DR sekmesindeki tatbikat bunu kanıtlamak için var: manifestteki her dosyanın özetini yeniden hesaplar, depoyla karşılaştırır (eksik/fazla) ve isteğe bağlı geri yükleme provası yapar. Prova bellek içidir — gerçek depoya yazmaz, dosya silmez. Anahtar yoksa açık içerik doğrulanamaz ve sonuç «çözülemedi» olur; sessiz başarı yoktur. Yedek 30 günden eskiyse hazırlık kritik sayılır. Ayrıntı: docs/YEDEK_VE_DR.md §3.1"],
  ["Görüntü açılmıyor / DICOM hatası alıyorum.",
    "Sırayla: 1) Dosyanın gerçekten DICOM olduğunu doğrulayın (ilk 128 bayt boş + “DICM” imzası); desteksiz bir sıkıştırma varsa ekranda kodek adı yazılır (JPEG-XL görüntü olarak çözülmez). 2) Klasörü ZIP yerine doğrudan sürüklemeyi deneyin; çok büyük çalışmalarda önce bir seriyi açın. 3) Sunucu/PACS yolundan açıyorsanız Yönetim → Entegrasyon → “Bağlantıyı test et”. 4) Hâlâ açılmıyorsa tarayıcı konsolundaki uç ve HTTP kodunu not edip /kiyaslama sayfasındaki ilgili satıra bakın. Hasta verisi içeren dosyayı hiçbir yere yüklemeyin."],
  ["Raporu nasıl onaylarım, PDF alırım?",
    "Rapor panelinde her bulguyu «Onayla» veya «Düzenlendi» olarak işaretleyin (gerekçe zorunlu); sunucu da bu kapıyı denetler. Ardından «Onayla» → rapor `ONAYLI` rozetini alır ve imza (ad, ünvan, sicil) yazılır. PDF: rapor ekranındaki yazdır/PDF düğmesi tarayıcının yazdırma penceresini açar — altbilgide sürüm ve «tıbbi cihaz değildir» durumu yer alır. Onaylı rapor değiştirilemez; düzeltme için addendum eklenir (sürüm geçmişi korunur)."],
  ["Bu belge ile uygulama içi `/yardim` sayfası farkı?",
    "Yok — içerik aynıdır: aynı sorular ve aynı cevaplar. Uygulama sürümü yalnız düzeni sadeleştirir; bir yüzey güncellenmeden diğeri güncellenemez (`tests/help-faq.test.ts` her soruyu iki yönde eşleştirir)."],
  ["Resimli anlatımı nerede bulurum? Statik demoda da var mı?",
    "Dört yerden açılır: 1) ana ekranın üst araç çubuğunda 🖼 Resimli anlatım (Yönetim ile Tercihler arasında), 2) bu Yardım sayfasının en üstündeki kart, 3) Tercihler sayfasının altındaki «Yardım ve resimli anlatım» kutusu, 4) giriş ekranındaki bağlantı. Ayrıca araç çubuğundaki ? düğmesi doğrudan ilgili bölüme atlar. Doğrudan adres: /resimlianlatim — statik GitHub Pages demosunda da açılır (sayfa hiçbir API çağırmaz, görseller /kilavuz/ altındadır)."],
  ["Bağlamsal yardım (?) düğmesi ne yapar?",
    "Ana araç çubuğundaki ? düğmesi, resimli anlatımın ilgili bölümüne derin bağlantı verir (/resimlianlatim#bolum-…). Konular tek kaynaktan gelir: src/lib/guideStory.ts → HELP_TOPICS; her kaydın gerçekten var olan bir bölüme bağlandığı ve çapaların sayfada basıldığı testlerle denetlenir. Statik demoda da çalışır (API gerekmez)."],
  ["Yeni bir AI modülü eklenecek mi? \"BT kolon polip\", \"kalça kırığı\"?",
    "Adaylar /kiyaslama sayfasındaki “Önerilen aday modüller — henüz kod yok” listesinde (BT kolongrafi polip, DX kalça kırığı, CXR RSNA pnömoni 2. skor). Açık kaynak model + yerelde çalışma + research etiketi + kurum doğrulaması çerçevesinden geçmeden eklenmez."],
];

export default function YardimPage() {
  return (
    <div className="h-screen w-screen overflow-y-auto bg-[var(--t02)] text-[var(--sl200)]">
      <main className="mx-auto max-w-3xl px-5 py-10">
        <Link href="/" className="text-xs text-[var(--ac-cyan400)] hover:underline">← Görüntüleyiciye dön</Link>
        <h1 className="mt-3 text-2xl font-black text-[var(--sl100)]">Yardım / S.S.S.</h1>
        <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 text-xs leading-relaxed text-[var(--ac-amber200)]">
          ATIKVIEWER araştırma amaçlıdır; klinik karar için kullanılamaz. Yapay zekâ çıktılarının tamamı taslaktır, son söz radyoloji uzmanınındır.
          Bu sayfa <code className="rounded bg-black/40 px-1">docs/SSS.md</code> ile bire bir eşlenik tutulur; biri güncellenmeden diğeri güncellenemez.
        </p>
        <section className="mt-6 rounded-xl border border-cyan-400/40 bg-cyan-400/5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-black text-[var(--ac-cyan200)]">Resimli anlatım — adım adım, ekran görüntüleriyle</h2>
            <Link href="/resimlianlatim" className="rounded-md border border-cyan-400/50 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-[var(--ac-cyan200)] hover:bg-cyan-500/20">
              Resimli anlatımı aç →
            </Link>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--sl300)]">
            İlk açılış, çalışma açma, Vision AI, rapor onayı, tema/dil ve sorun giderme: her adımda nerede olduğu, ne yapılacağı ve
            sonucun ne olacağı yazar. Adımların hangilerinin statik web demosunda çalıştığı ayrıca işaretlidir.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[["ekran-menu-haritasi.jpg", "Numaralandırılmış menü haritası"], ["sema-ai-akisi.svg", "Vision AI analiz karar ağacı"]].map(([f, alt]) => (
              <Link key={f} href="/resimlianlatim" className="group block overflow-hidden rounded-lg border border-[var(--t32)]">
                {/* eslint-disable-next-line @next/next/no-img-element -- statik kılavuz görseli; Pages dışa aktarımında next/image optimizasyonu kapalı */}
                <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/kilavuz/${f}`} alt={alt} loading="lazy" className="w-full opacity-90 transition-opacity group-hover:opacity-100" />
              </Link>
            ))}
          </div>
        </section>

        <div className="mt-6 space-y-4">
          {QA.map(([q, a]) => (
            <section key={q} className="rounded-xl border border-[var(--t30)] bg-[var(--t05)] p-4">
              <h2 className="text-sm font-bold text-[var(--ac-cyan300)]">{q}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--sl300)]">{a}</p>
            </section>
          ))}
        </div>
        <p className="mt-6 text-[11px] text-[var(--sl500)]">
          Ayrıntılar için depodaki belgeler: <code className="rounded bg-black/40 px-1">docs/KURULUM_VE_KULLANIM.md</code> · <code className="rounded bg-black/40 px-1">docs/MENU_KILAVUZU.md</code> · <code className="rounded bg-black/40 px-1">docs/GORSEL_ANLATIM.md</code> ·{" "}
          <Link href="/resimlianlatim" className="text-[var(--ac-cyan400)] hover:underline">/resimlianlatim</Link>
        </p>
      </main>
    </div>
  );
}

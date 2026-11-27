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
  ["Worker’ın çalıştığını nasıl anlarım?",
    "Terminal satırı: “ATIKVIEWER AI worker: http://127.0.0.1:8787” + “Model yüklendi.” · curl http://127.0.0.1:8787/health → {\"ok\": true} · Tarayıcıda /paketler sayfası → AI durumu kartı. Ana şeritteki “HAZIR / ANALİZ” görüntüleyicinin kendi durumudur, worker’ın değil."],
  ["Web demosunda (GitHub Pages) AI çalışır mı?",
    "Hayır. Statik demoda /api/* yoktur; AI düğmeleri çalışmaz, /ayna demo etiketlidir. Arayüzü tanımak içindir; gerçek görüntüyle çalışmak için yerel/kurum kurulumu gerekir."],
  ["GPU şart mı? Kaç GB indirme var?",
    "GPU şart değil (CPU’da çalışır, yavaştır; diz MR’da ~80 sn/hacim). CXR 28 MB (depoda) · MONAI BT toraks ≈84 MB · ICH ≈147 MB · diz MR (opsiyonel) ≈1,6 GB (windows\\Kurulum.bat -Knee)."],
  ["PostgreSQL kurmadan çalışır mı?",
    "Görüntüleyici + ölçüm + AI için evet. DB yoksa yalnız kalıcı özellikler çalışmaz: çalışma listesi, sunucuya kaydetme, kayıtlı raporlar, denetim kaydı, STOW-RS. Kurumsal kullanımda PostgreSQL 16+ önerilir (Docker’da otomatik)."],
  ["Verilerim dışarı çıkar mı?",
    "Hayır; worker yalnız 127.0.0.1’de dinler. İsteğe bağlı LLM taslak izlenim özelliği açıkken bile yalnız hekimin onayladığı bulgu metinleri (hasta kimliği OLMADAN) servise gider."],
  ["Rapor neden TASLAK ve kırmızı uyarıyla geliyor?",
    "ATIKVIEWER tıbbi cihaz değildir ve tanı koymaz. Tüm çıktılar araştırma taslağıdır; rapor onayının sorumluluğu radyoloji uzmanındadır. Bu etiket kaldırılamaz."],
  ["Kırmızı “ConnectionResetError / WinError 10054” traceback’i",
    "Arıza değildir. Keep-alive bağlantısını istemci aniden kapatınca worker yığın izi basardı; 2026-11-26 güncellemesiyle tek satır loga indi (“istemci bağlantıyı kapattı (istek yok, yoksayıldı)”). git pull ile alın."],
  ["Kurulum ve menüler nereden öğrenilir?",
    "docs/KURULUM_VE_KULLANIM.md (tüm işletim sistemleri, görsel+videolu) ve docs/MENU_KILAVUZU.md (numaralı ekran haritasıyla her düğme). Windows ayrıntı: docs/WINDOWS_KURULUM.md."],
  ["Tema aldığımda neden hiçbir renk değişmiyordu?",
    "Düzeldi (2026-11-26). Yapısal renkler artık globals.css değişkenlerine bağlı; Koyu (eski görünüm), Klinik Mavi, Açık Tema ve Yüksek Kontrast artık gerçekten çalışır. Seçim atik-theme anahtarında saklanır. Ayrıntı: docs/GORSEL_ANLATIM.md §7.1"],
  ["Dili nasıl değiştiririm? Kaç dil var?",
    "Üst çubuktaki 🌐 Dil seç düğmesinden 24 kayıtlı dili arayıp seçin (tr en es fr de it pt nl pl ru uk cs sv ro hu bg ar he hi zh ja ko id th). Paket yalnız seçildiğinde indirilir; yedek İngilizce. Kapsam: arayüz kromu — belgeler ve AI rapor gövdesi Türkçe kalır. Yeni dil PR + npm run test:i18n ile eklenir."],
  ["Görsel anlatım nerede?",
    "docs/GORSEL_ANLATIM.md — uçtan uca, ekran ekran; sıkıştırılmış JPEG + SVG şemalarla (≈650 KB). Web demosu vs Windows/macOS/Linux/Docker farkları, AI analiz karar ağacı, tema ve dil mekanizması."],
  ["Yeni AI modülü gelir mi? (kolon polip, kalça kırığı)",
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
        <div className="mt-6 space-y-4">
          {QA.map(([q, a]) => (
            <section key={q} className="rounded-xl border border-[var(--t30)] bg-[var(--t05)] p-4">
              <h2 className="text-sm font-bold text-[var(--ac-cyan300)]">{q}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--sl300)]">{a}</p>
            </section>
          ))}
        </div>
        <p className="mt-6 text-[11px] text-[var(--sl500)]">
          Ayrıntılar için depodaki belgeler: <code className="rounded bg-black/40 px-1">docs/KURULUM_VE_KULLANIM.md</code> · <code className="rounded bg-black/40 px-1">docs/MENU_KILAVUZU.md</code> · <code className="rounded bg-black/40 px-1">docs/SSS.md</code>
        </p>
      </main>
    </div>
  );
}

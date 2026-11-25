import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import AiWorkerStatus from "@/components/AiWorkerStatus";
import { APP_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: "ATIKVIEWER — Kurulum Paketleri (Windows · Linux · macOS)",
  description:
    "ATIKVIEWER çapraz platform kurulum paketleri, dosya yolları, ücretsiz yerel yapay zekâ kurulumu ve doğrulama betikleri.",
};

const VERSION = APP_VERSION;
const ZIP_FILE = `ATIKVIEWER-${VERSION}-kurulum.zip`;
const ZIP = `/downloads/${ZIP_FILE}`;
// Arşiv CI/release akışında üretilip GitHub Releases'e eklenir; yerel derlemede
// public/downloads altında yoksa sayfa ölü bağlantı vermek yerine üretim komutunu gösterir.
const ZIP_EXISTS = fs.existsSync(path.join(process.cwd(), "public", "downloads", ZIP_FILE));

interface Row {
  path: string;
  desc: string;
}
interface Block {
  id: string;
  os: string;
  icon: string;
  blurb: string;
  commands: string[];
  rows: Row[];
}

const BLOCKS: Block[] = [
  {
    id: "windows",
    os: "Windows 10 / 11",
    icon: "🪟",
    blurb: "Tek komutla kurulum; sürümlü Setup.exe ve taşınabilir ZIP üretilir, kurulu sürüm açılışta otomatik güncellenir.",
    commands: [
      ":: Kurulum (önerilen — Node, Python, AI modellerini kendisi kurar)",
      "windows\\Kurulum.bat",
      "",
      ":: Çalıştır / durdur",
      "windows\\Baslat.bat",
      "windows\\Dur.bat",
      "",
      `:: Kurulum paketi üret (dist\\ATIKVIEWER-${VERSION}-Setup.exe)`,
      "powershell -ExecutionPolicy Bypass -File windows\\Paket.ps1",
    ],
    rows: [
      { path: "windows/Kurulum.bat", desc: "Tek komutla kurulum (idempotent)" },
      { path: "windows/Kurulum.ps1", desc: "Kurulumun PowerShell çekirdeği" },
      { path: "windows/Baslat.bat · Baslat.ps1", desc: "AI worker + görüntüleyici + tarayıcı" },
      { path: "windows/Guncelle.ps1", desc: "Sürüm denetimi, SHA-256 doğrulama ve otomatik güncelleme" },
      { path: "windows/Dur.bat · Dur.ps1", desc: "Süreçleri kapatır" },
      { path: "windows/Veritabani.ps1", desc: "PostgreSQL kurulumu ve veritabanı" },
      { path: "windows/atikviewer.iss", desc: "Inno Setup 6 kurulum EXE betiği" },
      { path: "windows/Paket.ps1", desc: "Setup.exe + portable.zip üretir" },
      { path: "docs/WINDOWS_KURULUM.md", desc: "Rehber + sık hataların çözümleri" },
    ],
  },
  {
    id: "linux",
    os: "Ubuntu · Debian · Mint · Fedora · Arch",
    icon: "🐧",
    blurb: "Tek komutla kurulum; .deb paketi, masaüstü girişi ve systemd birimi ile gelir.",
    commands: [
      "# Kurulum (kaynak yoksa depoyu klonlar)",
      "bash packaging/linux/install.sh",
      "",
      `# Kurulum paketi üret → dist/ATIKVIEWER-${VERSION}-amd64.deb`,
      "bash packaging/linux/build-deb.sh",
      `sudo dpkg -i dist/ATIKVIEWER-${VERSION}-amd64.deb`,
      "",
      "# Otomatik başlatma",
      "cp packaging/linux/atikviewer-user.service ~/.config/systemd/user/",
      "systemctl --user daemon-reload && systemctl --user enable --now atikviewer",
    ],
    rows: [
      { path: "packaging/linux/install.sh", desc: "Tek komutla kurulum (tüm dağıtımlar)" },
      { path: "packaging/linux/build-deb.sh", desc: ".deb + taşınabilir tar.gz üretir" },
      { path: "packaging/linux/atikviewer.desktop", desc: "Masaüstü menü girişi" },
      { path: "packaging/linux/atikviewer-user.service", desc: "systemd kullanıcı birimi" },
    ],
  },
  {
    id: "macos",
    os: "macOS (Intel · Apple Silicon)",
    icon: "🍎",
    blurb: "Homebrew ile kurulum, isteğe bağlı LaunchAgent, DMG paketi üretimi.",
    commands: [
      "# Kurulum",
      "bash packaging/macos/install.sh",
      "",
      `# DMG üret → dist/ATIKVIEWER-${VERSION}-macOS.dmg`,
      "bash packaging/macos/build-dmg.sh",
      "",
      "# DMG içindeki Install.command'a çift tıklayın",
      "xattr -dr com.apple.quarantine ATIKVIEWER   # Gatekeeper engeli ise",
    ],
    rows: [
      { path: "packaging/macos/install.sh", desc: "Kurulum + LaunchAgent" },
      { path: "packaging/macos/build-dmg.sh", desc: "DMG + tar.gz üretir" },
      { path: "packaging/macos/Info.plist", desc: "Uygulama paketi bilgi listesi" },
    ],
  },
  {
    id: "universal",
    os: "Docker · Çapraz platform · Doğrulama",
    icon: "🐳",
    blurb: "Aynı paket her işletim sisteminde; kurulum sonrası doğrulama betiği log üretir.",
    commands: [
      "# Docker (her işletim sistemi)",
      "cp .env.example .env   # POSTGRES_PASSWORD ve DATA_ENCRYPTION_KEY doldurun",
      "docker compose up --build -d",
      "curl http://localhost:3000/api/health",
      "",
      "# Tüm kurulum dosyalarını yollarıyla ZIP'e koy",
      "bash packaging/universal/build-source-zip.sh",
      "",
      "# Kurulum sonrası denetim → dist/ATIKVIEWER-dogrulama-<tarih>.log",
      "bash packaging/universal/verify.sh",
    ],
    rows: [
      { path: "packaging/universal/build-source-zip.sh", desc: "Teslim ZIP'i üretir" },
      { path: "packaging/universal/verify.sh", desc: "Sağlık + AI denetimi, log" },
      { path: "packaging/README.md", desc: "Tüm dosya yolları ve komutlar" },
      { path: "Dockerfile · docker-compose.yml", desc: "Docker dağıtımı" },
      { path: ".env.example", desc: "Ortam değişkenleri şablonu" },
    ],
  },
];

const AI_ROWS: Row[] = [
  { path: "ai-worker/server.py", desc: "Yerel çıkarım sunucusu — yalnız 127.0.0.1:8787" },
  { path: "ai-worker/setup_model.py", desc: "Modelleri indirir (akciğer ≈84 MB + beyin ≈147 MB)" },
  { path: "ai-worker/model_lib.py", desc: "MONAI lung_nodule_ct_detection (LUNA16)" },
  { path: "ai-worker/brain_lib.py · ich_inference.py", desc: "ct-head-hemorrhage-detection (MIT/RSNA)" },
  { path: "ai-worker/requirements.txt", desc: "torch · monai · opencv · safetensors (ücretsiz)" },
  { path: "docs/Klinik_Dogrulama_LUNA16.md", desc: "Akciğer modeli doğrulama raporu" },
  { path: "docs/Klinik_Dogrulama_ICH.md", desc: "Beyin kanaması doğrulama raporu" },
  { path: "docs/OLLAMA.md", desc: "Ücretsiz yerel LLM ile taslak izlenim" },
];

function Code({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-[#1a2230] bg-[#0a0e15] p-3 font-mono text-[11px] leading-relaxed text-cyan-100/90">
      {lines.join("\n")}
    </pre>
  );
}

function FileTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-[#1a2230] text-[10px] uppercase tracking-widest text-slate-500">
            <th className="py-1.5 pr-4 font-semibold">Dosya yolu</th>
            <th className="py-1.5 font-semibold">Açıklama</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} className="border-b border-[#131a25] align-top">
              <td className="whitespace-nowrap py-1.5 pr-4 font-mono text-[11px] text-cyan-300">{r.path}</td>
              <td className="py-1.5 text-[11px] text-slate-400">{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PaketlerPage() {
  return (
    <div className="min-h-dvh bg-[#070a0f] text-slate-200">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-[#1a2230] bg-[#0b0f16]/95 px-4 py-3 backdrop-blur">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-cyan-400 to-emerald-500 font-black text-[#06131a]">
          A
        </div>
        <span className="font-mono text-sm font-black tracking-[0.18em] text-slate-100">
          ATIK<span className="text-cyan-400">VIEWER</span>
        </span>
        <span className="rounded border border-slate-700 px-1 py-0.5 font-mono text-[8px] text-slate-500">v{VERSION}</span>
        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[9px] font-bold tracking-wide text-amber-300">
          ARAŞTIRMA AMAÇLIDIR · KLİNİK KARAR İÇİN KULLANILAMAZ
        </span>
        <div className="ml-auto flex gap-2">
          <Link
            href="/kiyaslama"
            className="rounded-lg border border-violet-400/50 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-200 hover:bg-violet-500/20"
          >
            📊 Kıyaslama
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-cyan-400/60 bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/25"
          >
            ← Görüntüleyici
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* İndirme */}
        <section className="mb-10 rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 to-emerald-500/5 p-6">
          <h1 className="text-2xl font-black tracking-tight text-slate-50">
            Çapraz platform kurulum paketi
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
            Windows, Linux ve macOS için gerekli <strong className="text-slate-200">tüm kurulum dosyaları</strong>,
            orijinal <strong className="text-slate-200">dosya yollarıyla</strong> tek arşivde. Arşiv yalnızca betik,
            yapılandırma ve belgeleri içerir; <span className="text-emerald-300">node_modules, .env ve hasta verisi içermez</span>.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {ZIP_EXISTS ? (
              <a
                href={ZIP}
                download
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 px-5 py-3 text-sm font-black text-[#06131a] shadow-lg shadow-cyan-500/20 transition hover:brightness-110"
              >
                ⬇ İndir — ATIKVIEWER-{VERSION}-kurulum.zip
              </a>
            ) : (
              <code className="rounded-lg border border-[#2d3b4e] bg-[#080c12] px-3 py-2 font-mono text-[11px] text-cyan-200">
                bash packaging/universal/build-source-zip.sh   # → dist/{ZIP_FILE}
              </code>
            )}
            <span className="font-mono text-[11px] text-slate-500">
              {ZIP_EXISTS ? "110 KB · SHA yok · dosya yolları korunur" : "arşiv bu derlemede yok; ürettikten sonra public/downloads/ altına koyun"}
            </span>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Windows", "windows\\Kurulum.bat"],
              ["Linux", "bash packaging/linux/install.sh"],
              ["macOS", "bash packaging/macos/install.sh"],
              ["Docker", "docker compose up --build -d"],
            ].map(([os, cmd]) => (
              <div key={os} className="rounded-lg border border-[#1a2230] bg-[#0a0e15] p-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">{os}</div>
                <code className="mt-1 block break-all font-mono text-[11px] text-slate-300">{cmd}</code>
              </div>
            ))}
          </div>
        </section>

        {/* İşletim sistemleri */}
        <div className="grid gap-6 lg:grid-cols-2">
          {BLOCKS.map((b) => (
            <section key={b.id} id={b.id} className="rounded-2xl border border-[#1a2230] bg-[#0b0f16] p-5">
              <div className="flex items-baseline gap-2">
                <span className="text-xl" aria-hidden>
                  {b.icon}
                </span>
                <h2 className="text-base font-black text-slate-100">{b.os}</h2>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{b.blurb}</p>
              <div className="mt-3">
                <Code lines={b.commands} />
              </div>
              <div className="mt-4">
                <FileTable rows={b.rows} />
              </div>
            </section>
          ))}
        </div>

        {/* Ücretsiz yerel AI */}
        <section className="mt-8 rounded-2xl border border-emerald-400/30 bg-emerald-500/5 p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-xl" aria-hidden>
              🧠
            </span>
            <h2 className="text-base font-black text-slate-100">Ücretsiz yerel yapay zekâ — gerçek çıkarım</h2>
            <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
              ÜCRET YOK · VERİ ÇIKMAZ
            </span>
          </div>
          <p className="mt-2 max-w-4xl text-[12px] leading-relaxed text-slate-400">
            Derin öğrenme çıkarımı <strong className="text-slate-200">yalnızca bu makinede</strong> çalışır: BT toraks
            serileri gerçek HU hacmi olarak MONAI <code className="text-cyan-300">lung_nodule_ct_detection</code>
            (LUNA16 eğitimli) modeline, BT beyin serileri{" "}
            <code className="text-cyan-300">ct-head-hemorrhage-detection</code> (MIT/RSNA) modeline gönderilir.
            Harici bulut servisi, API anahtarı veya ödeme <strong className="text-slate-200">yoktur</strong>.
            Worker kapalıysa kural tabanlı motor devreye girer ve bu durum ekranda açıkça yazılır —
            <strong className="text-slate-200"> sahte bulgu üretilmez</strong>.
          </p>
          <div className="mt-4">
            <AiWorkerStatus />
          </div>
          <div className="mt-3">
            <Code
              lines={[
                "python3 -m venv .venv",
                "./.venv/bin/pip install -r ai-worker/requirements.txt",
                "./.venv/bin/python ai-worker/setup_model.py    # modelleri indir (≈231 MB, ücretsiz)",
                "./.venv/bin/python ai-worker/server.py         # 127.0.0.1:8787 — ağ dışına çıkmaz",
                "",
                "curl http://127.0.0.1:8787/health              # worker durumu",
                "curl http://127.0.0.1:3000/api/deep-scan       # uygulama köprüsü",
              ]}
            />
          </div>
          <div className="mt-4">
            <FileTable rows={AI_ROWS} />
          </div>
        </section>

        {/* Klinik güvenlik */}
        <section className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-500/5 p-5">
          <h2 className="text-base font-black text-amber-200">Radyoloji uzmanı onayı — zorunlu</h2>
          <ol className="mt-3 grid gap-2 text-[12px] leading-relaxed text-slate-300 md:grid-cols-2">
            <li>
              <strong className="text-amber-200">1.</strong> Her AI bulgusu <em>“Onay Bekliyor”</em> gelir; bekleyen bulgu
              varken rapor onaylanamaz — bu kural yalnız arayüzde değil, <strong>sunucuda da</strong> zorunludur.
            </li>
            <li>
              <strong className="text-amber-200">2.</strong> Model yok / worker kapalı ise sonuç açıkça etiketlenir;
              doğrulanmamış veriyle bulgu icat edilmez.
            </li>
            <li>
              <strong className="text-amber-200">3.</strong> Skorlar <em>“kalibre değil”</em> etiketlidir; olasılık gibi
              sunulmaz. Model kartı panelde ve rapor çıktısında yer alır.
            </li>
            <li>
              <strong className="text-amber-200">4.</strong> Denetim kaydı hash zincirlidir, değiştirilemez; onay sonrası
              rapor sunucuda kilitlenir, düzeltme addendum ile yapılır.
            </li>
            <li>
              <strong className="text-amber-200">5.</strong> Hasta verisi AES-256-GCM ile şifrelenir ve bu makineden
              dışarı çıkmaz.
            </li>
            <li>
              <strong className="text-amber-200">6.</strong> Erişim kısıtı için uygulamayı yalnız yerel ağ/VPN üzerinden
              açın (varsayılan <code className="text-cyan-300">127.0.0.1</code>) — KVKK için şarttır.
            </li>
          </ol>
          <p className="mt-4 text-[11px] text-slate-500">
            Klinik doğrulama belgeleri:{" "}
            <Link href="/kiyaslama" className="text-cyan-400 underline-offset-2 hover:underline">
              Piyasa Kıyaslaması ve Eksik Analizi
            </Link>{" "}
            · <code className="text-slate-400">docs/Klinik_Dogrulama_LUNA16.md</code> ·{" "}
            <code className="text-slate-400">docs/Klinik_Dogrulama_ICH.md</code>
          </p>
        </section>
      </main>

      <footer className="border-t border-[#1a2230] px-4 py-6 text-center font-mono text-[10px] text-slate-600">
        ATIKVIEWER v{VERSION} · kurulum paketleri · ücretsiz ve açık kaynak · çıktı yok, abonelik yok
      </footer>
    </div>
  );
}

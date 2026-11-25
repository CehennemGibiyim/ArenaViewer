#!/usr/bin/env bash
# GitHub Pages için statik demo hazırlığı (yalnızca CI'da, geçici çalışma kopyasında çalıştırılır).
# Sunucu/veritabanı gerektiren kısımları çıkarır; görüntüleyici tarayıcıda çalışır.
set -euo pipefail
# Statik demo: Sunucu/veritabanı gerektiren sayfalar da çıkarılır; aksi halde
# `output: "export"` derlemesi sayfa verisi toplarken src/db/index.ts'in
# DATABASE_URL zorunluluğu yüzünden patlar (Pages işi bu yüzden kırılıyordu).
# Statik demoda olmayan sayfalar: /giris /yonetim /tercihler /paylas/*
# /ayna (ikinci ekran) sunucu oturum kapısı kullandığı için veritabanı ister;
# statik demoda oturumsuz istemci sürümü ayrıca yazılır (aşağıda).
rm -rf src/app/api src/app/yonetim src/app/giris src/proxy.ts src/app/tercihler src/app/paylas src/app/ayna
# API entegrasyon testleri silinen sunucu uçlarını içe aktarabilir. Statik
# kopyanın TypeScript denetiminden testleri çıkar; gerçek CI testleri korunur.
node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("tsconfig.json", "utf8")); p.exclude = [...new Set([...(p.exclude || []), "tests"])]; fs.writeFileSync("tsconfig.json", JSON.stringify(p, null, 2) + "\n");'
mkdir -p src/app/yonetim
cat > src/app/page.tsx <<'TSX'
import Workstation from "@/components/Workstation";
import StaticApiShim from "@/components/StaticApiShim";

// Statik demo: kimlik/veritabanı yok, sabit operatör profili.
const user = { id: 1, username: "demo", fullName: "Demo Radyolog", title: "Uzm. Dr.", regNo: "", role: "yonetici" as const };

export default function Home() {
  return (
    <>
      <StaticApiShim />
      <Workstation user={user} />
    </>
  );
}
TSX
# İkinci ekran (/ayna): sunucu sürümü oturum kapısıyla korunur; statik demoda
# kimlik doğrulama olmadığı için **demo** etiketiyle doğrudan istemci sürümü verilir.
mkdir -p src/app/ayna
cat > src/app/ayna/page.tsx <<'TSX'
import Link from "next/link";
import MirrorView from "@/components/MirrorView";

// Statik demo: oturum kapısı yok — yalnızca aynı tarayıcıdaki sekmeler arasında
// BroadcastChannel ile kesit yayını. Hasta verisi sunucuya gitmez.
export const metadata = { title: "İkinci ekran (demo) · ArenaViewer" };

export default function MirrorPage() {
  return (
    <div className="min-h-screen bg-[#070a0f] text-slate-200">
      <div className="flex items-center gap-3 border-b border-[#1a2230] bg-[#0b0f16] px-4 py-2">
        <Link href="/" className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-bold text-cyan-300">
          ← Görüntüleyiciye dön
        </Link>
        <span className="font-mono text-[11px] text-amber-300">
          STATİK DEMO — oturum doğrulaması yok; tam sürümde bu sayfa girişle korunur.
        </span>
      </div>
      <MirrorView />
    </div>
  );
}
TSX

cat > src/app/yonetim/page.tsx <<'TSX'
import Link from "next/link";

export default function Yonetim() {
  return (
    <main style={{ maxWidth: 560, margin: "15vh auto", padding: 24, color: "#cbd5e1", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ color: "#22d3ee", fontSize: 22 }}>Yönetim paneli</h1>
      <p style={{ marginTop: 12, lineHeight: 1.6 }}>
        Kullanıcılar, denetim kaydı, AI performansı ve ayarlar sunucu ve veritabanı gerektirir; bu statik demoda kapalıdır.
        Tam sürüm için Docker Compose veya Render ile dağıtın (README).
      </p>
      <Link href="/" style={{ display: "inline-block", marginTop: 16, color: "#22d3ee" }}>← Görüntüleyiciye dön</Link>
    </main>
  );
}
TSX

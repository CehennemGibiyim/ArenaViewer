#!/usr/bin/env bash
# GitHub Pages için statik demo hazırlığı (yalnızca CI'da, geçici çalışma kopyasında çalıştırılır).
# Sunucu/veritabanı gerektiren kısımları çıkarır; görüntüleyici tarayıcıda çalışır.
set -euo pipefail
# Statik demo: Sunucu/veritabanı gerektiren sayfalar da çıkarılır; aksi halde
# `output: "export"` derlemesi sayfa verisi toplarken src/db/index.ts'in
# DATABASE_URL zorunluluğu yüzünden patlar (Pages işi bu yüzden kırılıyordu).
# Statik demoda olmayan sayfalar: /giris /tercihler /paylas/*
# /ayna (ikinci ekran) sunucu oturum kapısı kullandığı için veritabanı ister;
# statik demoda oturumsuz istemci sürümü ayrıca yazılır (aşağıda).
# /yonetim TAMAMEN kaldırılmaz: statik demoda gerçek AdminPanel KURGUSAL örnek
# veriyle açılır (src/components/StaticAdminShim.tsx — modül düzeyinde bellek;
# değişiklikler sayfa yenilenince sıfırlanır, hasta verisi yoktur).
# /tercihler KALDIRILMAZ: tercihler cihaz katmanına (localStorage) da yazılır;
# statik demoda sayfa, /api/profile/preferences'ı StaticApiShim üzerinden
# karşılayan istemci sürümüyle açılır (sunucu sürümü giriş kapısında durur).
rm -rf src/app/api src/app/yonetim src/app/giris src/proxy.ts src/app/paylas src/app/ayna
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
    <div className="doc-page min-h-dvh w-full bg-[#070a0f] text-slate-200">
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

cat > src/app/tercihler/page.tsx <<'TSX'
import Link from "next/link";
import PreferencesPanel from "@/components/PreferencesPanel";
import StaticApiShim from "@/components/StaticApiShim";

// Statik demo: oturum yok, sunucu yok. Tercihler cihazda (localStorage) saklanır
// ve /api/profile/preferences StaticApiShim tarafından karşılanır; böylece tema,
// düzen ve kısayol seçimi sayfa yenilense de korunur.
export const metadata = { title: "Kullanıcı Tercihleri (demo) · ArenaViewer" };

export default function TercihlerDemo() {
  return (
    <div className="doc-page min-h-dvh w-full bg-[var(--t02)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/30 bg-amber-400/5 px-3 py-1.5">
        <Link href="/" className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
          ← Görüntüleyiciye dön
        </Link>
        <span className="font-mono text-[10.5px] leading-snug text-amber-300">
          STATİK DEMO — tercihler yalnız bu tarayıcıda saklanır (hesap katmanı yok). Seçimleriniz yenilemede korunur.
        </span>
      </div>
      <StaticApiShim />
      <PreferencesPanel />
    </div>
  );
}
TSX

cat > src/app/yonetim/page.tsx <<'TSX'
import Link from "next/link";
import AdminPanel from "@/components/AdminPanel";
import StaticAdminShim from "@/components/StaticAdminShim";

// Statik demo: kimlik/veritabanı yok, sabit operatör profili ve KURGUSAL
// örnek veri (StaticAdminShim — bellek içi, yenilemede sıfırlanır).
const demoUser = { id: 1, username: "demo", fullName: "Demo Radyolog", title: "Uzm. Dr.", regNo: "000000", role: "yonetici" as const };

export const metadata = { title: "Yönetim (demo) · ArenaViewer" };

export default function YonetimDemo() {
  return (
    <div className="doc-page min-h-dvh w-full bg-[#070a0f]">
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/30 bg-amber-400/5 px-3 py-1.5">
        <Link href="/" className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
          ← Görüntüleyiciye dön
        </Link>
        <span className="font-mono text-[10.5px] leading-snug text-amber-300">
          STATİK DEMO — tüm kayıtlar kurgusal örnek veridir; gerçek hasta verisi yoktur. Değişiklikler yalnızca bu sayfa oturumunda geçerlidir.
        </span>
      </div>
      <StaticAdminShim />
      <AdminPanel user={demoUser} />
    </div>
  );
}
TSX

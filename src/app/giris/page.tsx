import { Suspense } from "react";
import Link from "next/link";
import LoginForm from "@/components/LoginForm";
import SetupForm from "@/components/SetupForm";
import { accessEnabled } from "@/lib/server/access";
import { authRequired } from "@/lib/server/auth";
import { hasAnyActiveUser } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";
export const metadata = { title: "ATIKVIEWER — Giriş" };

/**
 * Giriş sayfası. Sunucu tarafında hangi kimlik katmanlarının etkin olduğuna bakar
 * (ACCESS_TOKEN kapısı, AUTH_MODE=hesap). Hiç etkin hesap yoksa önce kurulum formunu,
 * aksi halde giriş formunu çizer.
 */
export default async function GirisPage() {
  let needsSetup = true;
  try {
    needsSetup = !(await hasAnyActiveUser());
  } catch {
    // Veritabanı erişilemiyorsa kurulum seçeneği açık kalır; form sunucu hata verecektir.
    needsSetup = true;
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--t02)] px-4 py-8 text-[var(--sl200)]">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--t25)] bg-[var(--t05)] p-6 shadow-2xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 text-lg font-black text-[#06131a]">
          A
        </div>
        <h1 className="mt-4 text-lg font-black tracking-tight text-[var(--sl50)]">ATIKVIEWER</h1>
        <p className="mt-1 text-xs leading-relaxed text-[var(--sl400)]">
          {needsSetup ? "İlk yönetici hesabını oluşturun." : "Devam etmek için kimliğinizi doğrulayın."}
        </p>
        <Suspense fallback={<p className="mt-6 text-center text-xs text-[var(--sl500)]">Yükleniyor…</p>}>
          {needsSetup ? (
            <SetupForm accessEnabled={accessEnabled()} />
          ) : (
            <LoginForm mode={{ accessEnabled: accessEnabled(), authRequired: authRequired() }} />
          )}
        </Suspense>
        {/* Giriş yapmadan da ulaşılabilen yardım: kilitli ekranda "nasıl girerim"
            sorusunun cevabı ve görsel kılavuz buradan açılır. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 border-t border-[var(--t22)] pt-4 text-[11px]">
          <Link href="/yardim" className="rounded border border-[var(--sl500)]/40 px-2 py-1 font-bold text-[var(--sl200)] hover:bg-[var(--sl500)]/10">
            Yardım / S.S.S.
          </Link>
          <Link href="/resimlianlatim" className="rounded border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 font-bold text-[var(--ac-cyan200)] hover:bg-cyan-500/20">
            🖼 Resimli anlatım
          </Link>
          <Link href="/paketler" className="rounded border border-[var(--sl500)]/40 px-2 py-1 font-bold text-[var(--sl200)] hover:bg-[var(--sl500)]/10">
            📦 Kurulum
          </Link>
        </div>
      </div>
    </main>
  );
}

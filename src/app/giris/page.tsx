import { Suspense } from "react";
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
      </div>
    </main>
  );
}

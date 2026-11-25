import { Suspense } from "react";
import LoginForm from "@/components/LoginForm";
import SetupForm from "@/components/SetupForm";
import { accessEnabled } from "@/lib/server/access";
import { authRequired } from "@/lib/server/auth";
import { hasAnyActiveUser } from "@/lib/server/accounts";
import { lockoutPolicy } from "@/lib/server/lockout";
import { oidcConfig } from "@/lib/server/oidc";
import { ldapConfig } from "@/lib/server/ldap";
import { samlConfig } from "@/lib/server/saml";

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
    <main className="flex min-h-dvh items-center justify-center bg-[#070a0f] px-4 py-8 text-slate-200">
      <div className="w-full max-w-sm rounded-2xl border border-[#1a2230] bg-[#0b0f16] p-6 shadow-2xl">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 text-lg font-black text-[#06131a]">
          A
        </div>
        <h1 className="mt-4 text-lg font-black tracking-tight text-slate-50">ATIKVIEWER</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          {needsSetup ? "İlk yönetici hesabını oluşturun." : "Devam etmek için kimliğinizi doğrulayın."}
        </p>
        <Suspense fallback={<p className="mt-6 text-center text-xs text-slate-500">Yükleniyor…</p>}>
          {needsSetup ? (
            <SetupForm accessEnabled={accessEnabled()} />
          ) : (
            <LoginForm
              mode={{
                accessEnabled: accessEnabled(),
                authRequired: authRequired(),
                lockout: lockoutPolicy(),
                oidc: (() => {
                  const c = oidcConfig();
                  return c ? { enabled: true, label: c.label } : { enabled: false };
                })(),
                ldap: { enabled: ldapConfig() !== null },
                saml: (() => {
                  const c = samlConfig();
                  return c ? { enabled: true, label: c.label } : { enabled: false };
                })(),
              }}
            />
          )}
        </Suspense>
      </div>
    </main>
  );
}

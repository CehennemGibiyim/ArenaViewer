import { redirect } from "next/navigation";
import PreferencesPanel from "@/components/PreferencesPanel";
import { getCurrentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "ATIKVIEWER — Kullanıcı Tercihleri" };

export default async function TercihlerPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/giris?next=%2Ftercihler");
  return <PreferencesPanel />;
}

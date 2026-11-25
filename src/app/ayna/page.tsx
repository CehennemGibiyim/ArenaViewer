import { redirect } from "next/navigation";
import MirrorView from "@/components/MirrorView";
import { getCurrentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "İkinci ekran · ArenaViewer" };

export default async function MirrorPage() {
  // Oturum kapısı ana sayfayla aynı: yetkisiz istemci yayını dinleyemez.
  const user = await getCurrentUser();
  if (!user) redirect("/giris?next=%2Fayna");
  return <MirrorView />;
}

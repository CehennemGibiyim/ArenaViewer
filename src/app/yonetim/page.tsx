import { redirect } from "next/navigation";
import AdminPanel from "@/components/AdminPanel";
import { getCurrentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "ATIKVIEWER — Yönetim" };

export default async function YonetimPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/giris?next=%2Fyonetim");
  return <AdminPanel user={user} />;
}

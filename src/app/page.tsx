import { redirect } from "next/navigation";
import Workstation from "@/components/Workstation";
import { authRequired, getCurrentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Demo modunda oturum gerekmez; AUTH_MODE=hesap ise oturum zorunludur ve
  // oturumsuz istek /giris sayfasına düşer.
  const user = await getCurrentUser();
  if (!user) redirect("/giris?next=%2F");
  return <Workstation user={user} sessionIdentity={authRequired()} />;
}

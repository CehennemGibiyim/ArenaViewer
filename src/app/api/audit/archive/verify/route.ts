import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { verifyArchiveDir } from "@/lib/server/auditArchive";

export const dynamic = "force-dynamic";

/**
 * Arşiv doğrulama (g-audit-export).
 *
 * Neden AYRI uç: doğrulama, depodaki dosyaları okuyup şifre çözen duyarlı bir
 * işlemdir. Aynı uçta `?verify=1` gibi **kullanıcı denetimli bir koşulla**
 * çalıştırmak, yetki kontrolünü parametreye bağlı hâle getirirdi (CodeQL
 * `java/script-engine-injection` benzeri "user-controlled sensitive action").
 * Burada yol sabittir: yetki → doğrulama. Parametre yok.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  return NextResponse.json(await verifyArchiveDir());
}

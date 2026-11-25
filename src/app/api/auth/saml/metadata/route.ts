import { NextRequest, NextResponse } from "next/server";
import { samlConfig, spMetadata } from "@/lib/server/saml";

export const dynamic = "force-dynamic";

/** SP meta verisi: IdP yapılandırmasına yüklenir (entityID + ACS adresi). */
export async function GET(req: NextRequest) {
  const cfg = samlConfig();
  if (!cfg) return NextResponse.json({ error: "SAML yapılandırılmamış" }, { status: 404 });
  const acsUrl = cfg.acsUrl || new URL("/api/auth/saml/callback", req.nextUrl.origin).toString();
  return new NextResponse(spMetadata(cfg, acsUrl), {
    status: 200,
    headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" },
  });
}

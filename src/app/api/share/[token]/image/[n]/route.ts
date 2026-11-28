import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { readShareImages } from "@/lib/server/shareRepo";
import { packageFrame } from "@/lib/shareImage";

export const dynamic = "force-dynamic";

/**
 * Paylaşılan görüntü karesi (kimlik doğrulamasız, yalnız geçerli token ile).
 *
 * Kurallar:
 *  - Bağlantı kapatıldı/süresi doldu → 410 ve gövde yok (paket sunucuda silinir).
 *  - Kare numarası 1 tabanlıdır ve sınır dışıysa 404.
 *  - Yanıt **`image/jpeg`** olarak sabitlenir; `Content-Type` istemciden/DB'den gelmez
 *    (base64 metni tarayıcıda HTML olarak yorumlanamaz).
 *  - Önbellek kapalı (`no-store`) — iptal edilen bağlantı tarayıcı önbelleğinden okunamaz.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string; n: string }> }) {
  const { token, n } = await params;
  if (!/^[0-9a-f]{48}$/.test(token)) return NextResponse.json({ error: "Geçersiz bağlantı" }, { status: 400 });

  const pkg = await readShareImages(token);
  if (!pkg) {
    // Kapatılmış / süresi dolmuş / silinmiş paket: 410. Bu yolda sayaç ARTMAZ
    // (okunamayan içerik "erişim" sayılmaz) ve gövde tek tip tutulur.
    return NextResponse.json(
      { error: "Paylaşılan görüntüler artık erişilebilir değil (bağlantı kapatılmış, süresi dolmuş ya da görüntüler silinmiş)." },
      { status: 410 },
    );
  }
  const frame = packageFrame(pkg, Number(n));
  if (!frame) return NextResponse.json({ error: "Kare bulunamadı" }, { status: 404 });

  const bytes = Buffer.from(frame.b64, "base64");
  // Denetim kaydı kare başına değil **görüntüleme oturumu** başına yazılır (ilk kare):
  // 24 kareyi tek tek kaydetmek hash zincirini gereksiz şişirir. Sayfa açılışı ayrıca
  // `share.access` üretir; sayaç (`accessCount`) her açılışta artar.
  if (Number(n) === 1) {
    await audit(null, "share.image_access", "share", token.slice(0, 8), { frame: 1, bytes: bytes.length, frames: pkg.frames.length });
  }
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Disposition": `inline; filename="kesit-${Number(n)}.jpg"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { loadNotifyChannels, sendToChannels, summarizeSend } from "@/lib/server/notifyDispatch";
import { TEST_EVENT } from "@/lib/notifyChannels";

export const dynamic = "force-dynamic";

/**
 * Bildirim kanallarına test mesajı gönderir (a-notify).
 * Yalnız yönetici; gövde kimliksiz sabit örnek olaydır, hasta verisi taşımaz.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const { channels, errors } = await loadNotifyChannels();
  if (!channels.length) {
    return NextResponse.json({ error: "Tanımlı bildirim kanalı yok", channelErrors: errors }, { status: 400 });
  }
  const results = await sendToChannels(channels, TEST_EVENT);
  await audit(a.user, "notify.test", "notification", "", summarizeSend(results));
  return NextResponse.json({ ok: results.every((r) => r.ok), results, channelErrors: errors });
}

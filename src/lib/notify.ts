/**
 * Masaüstü/tarayıcı bildirimi köprüsü (a-notify).
 *
 * SINIR: Bu modül yalnızca tarayıcının yerel bildirimini (Notification API)
 * kullanır; SMS/e-posta/çağrı sistemi sağlayıcısı YOKTUR (bunlar kurum süreci/
 * dış servis). Sunucu tarafındaki kritik-bulgu webhook'una ek olarak çalışır.
 */

export type NotifySupport = NotificationPermission | "desteklenmiyor";

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function notifyPermission(): NotifySupport {
  return notificationsSupported() ? Notification.permission : "desteklenmiyor";
}

/** Kullanıcıdan izin ister (yalnızca mevcut değer "default" olduğunda anlamlıdır). */
export async function requestNotifyPermission(): Promise<NotifySupport> {
  if (!notificationsSupported()) return "desteklenmiyor";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface LocalNotification {
  title: string;
  body?: string;
  /** Aynı etiket önceki bildirimin yerine geçer (üst üste yığılmayı önler). */
  tag?: string;
}

/** Bildirimi gönderir; izin yoksa veya destek yoksa sessizce false döner. */
export function sendLocalNotification(n: LocalNotification): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    const icon = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/icon-192.png`;
    new Notification(n.title, {
      body: n.body ?? "",
      tag: n.tag ?? `atik-${Date.now()}`,
      icon,
      lang: "tr",
      dir: "ltr",
    });
    return true;
  } catch {
    return false;
  }
}

export interface CriticalFindingNotice {
  label: string;
  location?: string;
  detail?: string;
  studyUid?: string;
}

/**
 * Kritik/yüksek aday bulgu için tek tekçil masaüstü bildirimi.
 * İzin henüz sorulmadıysa önce sorar; sonucu çağıranın bilgisine bırakır.
 */
export async function notifyCriticalFinding(f: CriticalFindingNotice): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "default") await requestNotifyPermission();
  if (Notification.permission !== "granted") return false;
  const body = [f.location, f.detail].filter(Boolean).join(" · ");
  return sendLocalNotification({
    title: `Kritik/Yüksek aday: ${f.label}`,
    body,
    tag: "atik-kritik-bulgu",
  });
}

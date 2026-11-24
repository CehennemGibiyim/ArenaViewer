/**
 * Denetim olaylarını CEF (Common Event Format) satırına çevirir.
 * Saf fonksiyondur; veritabanı gerektirmez ve dışa aktarım/testler tarafından
 * doğrudan kullanılır.
 */

export interface CefEvent {
  ts: Date | string;
  username: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
}

export function cefLine(r: CefEvent): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
  const ts = new Date(r.ts).getTime();
  const severity = r.action.includes("delete") || r.action.includes("approve") ? 7 : 4;
  return [
    `CEF:0|ArenaViewer|ATIK|1.0|${esc(r.action)}|${esc(r.entityType || "event")}|${severity}|`,
    `rt=${ts}`,
    `suser=${esc(r.username || "sistem")}`,
    `cs1=${esc(r.entityType)} cs1Label=entityType`,
    `cs2=${esc(r.entityId)} cs2Label=entityId`,
    `cs3=${esc((r.details ?? "").slice(0, 500))} cs3Label=details`,
  ].join("");
}

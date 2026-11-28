/**
 * MPPS köprüsü — DIMSE ↔ ArenaViewer (e-hl7-mwl).
 *
 * Node süreci DIMSE (TCP/PDU) konuşmaz; bu köprü, kurum ağ geçidinden (dcm4che
 * `mpps-scu`, Orthanc, Mirth) gelen **DICOM JSON** olayını alır, doğrular ve
 * `/api/his/mpps` ucuna iletir. Böylece:
 *  - MPPS doğrulama/eşleştirme tek yerde (TypeScript, test edilebilir) kalır,
 *  - ağ geçidi değişse bile uç sözleşmesi sabit kalır.
 *
 * Kullanım (ağ geçidi olayı stdin'den ya da dosyadan):
 *   HIS_API_KEY=<anahtar> npm run mpps:bridge -- olay.json
 *   cat olay.json | HIS_API_KEY=<anahtar> npm run mpps:bridge
 *
 * Olay: { "mppsUid": "1.2.3...", "tags": { "00400252": { "vr": "CS", "Value": ["COMPLETED"] }, ... } }
 *
 * Çıkış kodu: 0 = uygulandı, 1 = reddedildi (422), 2 = bağlantı/yapılandırma hatası.
 */
import { readFileSync } from "node:fs";
import { buildMppsCreate, buildMppsSet, readMppsResponse, type MppsCreateInput, type MppsSetInput } from "../src/lib/mpps";

const BASE = (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = process.env.HIS_API_KEY || "";

type Event = { mppsUid: string; tags: Record<string, unknown> };
type Mode = "create" | "set";

/** Olay üretimi (ağ geçidi yükü yoksa): `--create` / `--set` JSON'undan DICOM JSON üretir. */
export function eventFromCreate(input: MppsCreateInput): Event {
  return { mppsUid: input.performedProcedureStepId, tags: buildMppsCreate(input) };
}

export function eventFromSet(input: MppsSetInput): Event {
  return { mppsUid: input.mppsUid, tags: buildMppsSet(input) };
}

export function validateEvent(e: unknown): { ok: true; event: Event } | { ok: false; error: string } {
  const ev = e as Partial<Event> | null;
  if (!ev || typeof ev !== "object") return { ok: false, error: "Olay JSON nesnesi değil" };
  if (!ev.mppsUid || typeof ev.mppsUid !== "string") return { ok: false, error: "mppsUid eksik" };
  if (!ev.tags || typeof ev.tags !== "object") return { ok: false, error: "tags (DICOM JSON) eksik" };
  const r = readMppsResponse(ev.tags as Record<string, unknown>, ev.mppsUid);
  if (!r.status) return { ok: false, error: "Durum etiketi (0040,0252) yok" };
  return { ok: true, event: { mppsUid: ev.mppsUid, tags: ev.tags as Record<string, unknown> } };
}

async function main(): Promise<number> {
  if (!KEY) {
    console.error("[mpps] HIS_API_KEY tanımlı değil.");
    return 2;
  }
  const args = process.argv.slice(2);
  let raw = "";
  try {
    raw = args[0] ? readFileSync(args[0], "utf8") : readFileSync(0, "utf8");
  } catch (e) {
    console.error(`[mpps] Olay okunamadı: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[mpps] Olay geçerli JSON değil.");
    return 2;
  }
  // İki giriş biçimi: hazır MPPS olayı ya da N-CREATE/N-SET yükü.
  let event: Event;
  if (parsed && typeof parsed === "object" && "mode" in (parsed as Record<string, unknown>)) {
    const p = parsed as { mode: Mode } & Record<string, unknown>;
    try {
      event = p.mode === "create" ? eventFromCreate(p as unknown as MppsCreateInput) : eventFromSet(p as unknown as MppsSetInput);
    } catch (e) {
      console.error(`[mpps] Yük üretilemedi: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  } else {
    const v = validateEvent(parsed);
    if (!v.ok) {
      console.error(`[mpps] Geçersiz olay: ${v.error}`);
      return 2;
    }
    event = v.event;
  }

  try {
    const r = await fetch(`${BASE}/api/his/mpps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(event),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; workStatus?: string; warnings?: string[] };
    if (r.ok && body.ok) {
      console.log(`[mpps] uygulandı: ${body.workStatus ?? "?"}`);
      return 0;
    }
    console.error(`[mpps] reddedildi (HTTP ${r.status}): ${body.reason ?? "?"}`);
    for (const w of body.warnings ?? []) console.error(`[mpps] uyarı: ${w}`);
    return 1;
  } catch (e) {
    console.error(`[mpps] ArenaViewer'a ulaşılamadı: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

// Test için `main` dışa açılır; doğrudan çalıştırıldığında çıkış kodunu uygular.
export { main };
if (process.argv[1] && /mpps-bridge\.(ts|js)$/.test(process.argv[1])) {
  main().then((code) => process.exit(code));
}

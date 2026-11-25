/**
 * C-STORE (DIMSE) köprüsü istemcisi — e-stow.
 *
 * DICOMweb STOW-RS zaten var (`pacs.ts stowInstance`). Kurumda DICOMweb kapalı,
 * yalnız klasik DIMSE (C-STORE SCU) açık olan PACS'ler için ince bir HTTP köprüsü
 * tanımlıyoruz: `scripts/cstore-bridge.ts` süreci Node'da soket işini bir
 * yardımcıya (`storescu`, dcm4che) devreder, ArenaViewer yalnızca JSON konuşur.
 *
 * Bu modül **saf**tır (ağ yok): gövde doğrulama, çoklu nesne partisi, yanıt
 * birleştirme ve yeniden deneme kararı burada test edilir.
 */

export interface CStoreTarget {
  host: string;
  port: number;
  /** Hedef AE Title */
  calledAe: string;
  /** Çağıran AE Title */
  callingAe?: string;
  /** TLS (DIMSE TLS, genelde 2762) */
  tls?: boolean;
}

export interface CStoreItem {
  /** İstemcide görünen ad (dosya adı) */
  name: string;
  /** base64 DICOM baytları */
  data: string;
  /** SOP Class UID (biliniyorsa) */
  sopClassUid?: string;
  /** SOP Instance UID (biliniyorsa) */
  sopInstanceUid?: string;
}

export interface CStoreBody {
  target?: Partial<CStoreTarget>;
  items?: CStoreItem[];
  /** Aynı nesneyi kaç kez deneyeceğiz (1–4) */
  retries?: number;
  /** Toplam istek zaman aşımı (ms) */
  timeoutMs?: number;
}

export const MAX_ITEMS_PER_CALL = 20;
export const MAX_ITEM_BYTES = 12 * 1024 * 1024;
export const DIMSE_TLS_PORT = 2762;

const AE_RE = /^[A-Z0-9 _-]{1,16}$/;
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

/** Hedefi doğrular. Boş/geçersiz alan **uydurulmaz**, hata döner. */
export function validateTarget(t: Partial<CStoreTarget> | undefined): { ok: true; target: CStoreTarget } | { ok: false; error: string } {
  const host = (t?.host ?? "").trim();
  if (!HOST_RE.test(host)) return { ok: false, error: "DIMSE hedef adresi geçersiz (host)." };
  const port = Number(t?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "DIMSE portu 1–65535 aralığında olmalı." };
  const calledAe = (t?.calledAe ?? "").trim().toUpperCase();
  if (!AE_RE.test(calledAe)) return { ok: false, error: "Hedef AE Title geçersiz (1–16 karakter, A-Z 0-9 _ -)." };
  const callingAe = ((t?.callingAe ?? "ARENAVIEWER").trim().toUpperCase() || "ARENAVIEWER").slice(0, 16);
  if (!AE_RE.test(callingAe)) return { ok: false, error: "Çağıran AE Title geçersiz." };
  return { ok: true, target: { host, port, calledAe, callingAe, tls: t?.tls === true } };
}

/** DICOM Part 10 imzası (DICM, 128 baytlık önsözden sonra). */
export function hasDicomPreamble(bytes: Uint8Array): boolean {
  if (bytes.length < 132) return false;
  return bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

export interface PreparedItem {
  name: string;
  bytes: number;
  sopClassUid?: string;
  sopInstanceUid?: string;
}

/** Gövde doğrulaması + base64 çözümü. Hatalı tek nesne **tüm isteği** reddettirir. */
export function prepareItems(items: CStoreItem[] | undefined): { ok: true; prepared: PreparedItem[]; buffers: Buffer[] } | { ok: false; error: string; index: number } {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "Gönderilecek DICOM nesnesi yok.", index: -1 };
  if (items.length > MAX_ITEMS_PER_CALL) return { ok: false, error: `Tek çağrıda en çok ${MAX_ITEMS_PER_CALL} nesne gönderilebilir.`, index: -1 };
  const prepared: PreparedItem[] = [];
  const buffers: Buffer[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const name = (it?.name ?? `nesne-${i + 1}.dcm`).slice(0, 120);
    const b64 = typeof it?.data === "string" ? it.data.replace(/^data:[^;]+;base64,/, "") : "";
    if (!b64) return { ok: false, error: `${name}: veri boş.`, index: i };
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return { ok: false, error: `${name}: base64 çözülemedi.`, index: i };
    }
    if (buf.length === 0) return { ok: false, error: `${name}: base64 çözülemedi.`, index: i };
    if (buf.length > MAX_ITEM_BYTES) return { ok: false, error: `${name}: ${Math.round(buf.length / 1048576)} MB — sınır ${MAX_ITEM_BYTES / 1048576} MB.`, index: i };
    if (!hasDicomPreamble(buf)) return { ok: false, error: `${name}: DICOM Part 10 imzası (DICM) yok; ham veri gönderilmez.`, index: i };
    const uidOk = (u?: string) => (u ? /^[0-9]+(\.[0-9]+)*$/.test(u) && u.length <= 64 : true);
    if (!uidOk(it.sopClassUid) || !uidOk(it.sopInstanceUid)) return { ok: false, error: `${name}: SOP UID biçimi geçersiz.`, index: i };
    prepared.push({ name, bytes: buf.length, sopClassUid: it.sopClassUid, sopInstanceUid: it.sopInstanceUid });
    buffers.push(buf);
  }
  return { ok: true, prepared, buffers };
}

export interface CStoreOutcomeItem {
  name: string;
  ok: boolean;
  /** DIMSE C-STORE durum kodu (0x0000 başarı) */
  status?: string;
  error?: string;
  attempts: number;
}

export interface CStoreOutcome {
  ok: boolean;
  sent: number;
  failed: number;
  items: CStoreOutcomeItem[];
  target: CStoreTarget;
  message: string;
}

/**
 * Yeniden deneme kararı: yalnız **geçici** hatalarda (bağlantı/timeout) tekrar
 * denenir. DIMSE durum kodu kalıcı reddi bildirir (ör. 0xA700 out of resources),
 * bu durumda tekrar denemek PACS'i boşuna yorar → denenmez.
 */
export function shouldRetry(item: CStoreOutcomeItem, retries: number): boolean {
  return !item.ok && item.attempts <= retries;
}

export function clampRetries(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n)) return 1;
  return Math.max(0, Math.min(4, n));
}

/** Köprü yanıtını birleştirir; PACS'in döndürdüğü durum kodları korunur. */
export function mergeBridgeResponse(raw: unknown, target: CStoreTarget, prepared: PreparedItem[]): CStoreOutcome {
  const o = (raw ?? {}) as { results?: { name?: string; status?: string; error?: string }[]; error?: string };
  const byName = new Map<string, { status?: string; error?: string }>();
  for (const r of o.results ?? []) {
    if (r?.name) byName.set(r.name, { status: r.status, error: r.error });
  }
  const items: CStoreOutcomeItem[] = prepared.map((p) => {
    const hit = byName.get(p.name);
    const status = hit?.status;
    const ok = status !== undefined ? /^0x0{4}$/i.test(status) : !hit?.error && !o.error;
    return { name: p.name, ok, status, error: hit?.error, attempts: 1 };
  });
  const sent = items.filter((i) => i.ok).length;
  const failed = items.length - sent;
  return {
    ok: failed === 0,
    sent,
    failed,
    items,
    target,
    message: failed === 0
      ? `${sent} nesne C-STORE ile ${target.calledAe}@${target.host}:${target.port} adresine gönderildi.`
      : `${sent}/${items.length} nesne gönderildi; ${failed} nesne reddedildi.`,
  };
}

/** Köprü isteği için gövde (JSON) — köprü sürecinin beklediği biçim. */
export function bridgeRequestBody(target: CStoreTarget, prepared: PreparedItem[], buffers: Buffer[]): string {
  return JSON.stringify({
    target,
    items: prepared.map((p, i) => ({ name: p.name, data: buffers[i].toString("base64"), sopClassUid: p.sopClassUid, sopInstanceUid: p.sopInstanceUid })),
  });
}

/**
 * Köprü adresi: yalnız yerel süreç (`127.0.0.1`/`localhost`) veya açıkça
 * yapılandırılmış iç adres kabul edilir. Dış adres **reddedilir** — köprü
 * kimlik doğrulaması taşımaz, internete açılmamalıdır.
 */
export function bridgeUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, error: "C-STORE köprüsü yapılandırılmamış (Ayarlar → PACS → DIMSE köprüsü)." };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: `Köprü adresi geçersiz: ${s.slice(0, 80)}` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Köprü adresi http/https olmalı." };
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"];
  const privateNet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  if (!local.includes(u.hostname) && !privateNet) {
    return { ok: false, error: "Köprü yalnız yerel/iç ağ adresinde çalıştırılmalı (kimlik doğrulaması yok)." };
  }
  if (!u.pathname || u.pathname === "/") u.pathname = "/cstore";
  return { ok: true, url: u.toString() };
}

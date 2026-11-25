/**
 * C-STORE gönderimi — köprüye HTTP (e-stow). Yeniden deneme ve sonuç birleştirme
 * `cstoreBridge.ts` (saf) içinde; burada yalnız ağ ve ayar okuma var.
 */
import { loadPacsConfig } from "./pacsConfig";
import { bridgeRequestBody, bridgeUrl, clampRetries, mergeBridgeResponse, prepareItems, validateTarget, type CStoreBody, type CStoreOutcome } from "@/lib/cstoreBridge";

export async function sendCStore(body: CStoreBody): Promise<{ ok: boolean; status: number; outcome?: CStoreOutcome; error?: string }> {
  const t = validateTarget(body.target);
  if (!t.ok) return { ok: false, status: 400, error: t.error };
  const prep = prepareItems(body.items);
  if (!prep.ok) return { ok: false, status: 400, error: prep.error };

  const cfg = await loadPacsConfig();
  const b = bridgeUrl(cfg?.cstoreBridgeUrl ?? process.env.CSTORE_BRIDGE_URL ?? "");
  if (!b.ok) return { ok: false, status: 503, error: b.error };

  const retries = clampRetries(body.retries);
  const timeoutMs = Math.min(120000, Math.max(5000, Number(body.timeoutMs) || 60000));
  const payload = bridgeRequestBody(t.target, prep.prepared, prep.buffers);

  let last: { ok: boolean; outcome?: CStoreOutcome; error?: string } = { ok: false, error: "Köprü yanıt vermedi" };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(b.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: ctl.signal, cache: "no-store" });
      clearTimeout(timer);
      const raw = (await res.json().catch(() => ({}))) as unknown;
      const outcome = mergeBridgeResponse(raw, t.target, prep.prepared);
      outcome.items = outcome.items.map((i) => ({ ...i, attempts: attempt }));
      if (outcome.ok) return { ok: true, status: 200, outcome };
      last = { ok: false, outcome, error: outcome.message };
      // Kalıcı redde tekrar denemek anlamsız (DIMSE durum kodu geldiyse).
      if (outcome.items.every((i) => i.status !== undefined)) return { ok: false, status: 502, outcome, error: outcome.message };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      last = { ok: false, error: aborted ? `Köprü ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi` : `Köprüye ulaşılamadı: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return { ok: false, status: 502, outcome: last.outcome, error: last.error };
}

/**
 * HL7 v2 (MLLP) alıcısı — HBYS/RIS köprüsü.
 *
 * Kurum içi HBYS, ORM^O01 gibi sipariş mesajlarını TCP/MLLP ile gönderir. Bu süreç
 * mesajı ayrıştırır ve ArenaViewer'ın `/api/his/orders` ucuna (HIS_API_KEY ile)
 * çevirir; gönderene ACK döner. MWL/C-FIND (DICOM DIMSE) burada değildir.
 *
 * Çalıştırma:
 *   HL7_PORT=2575 HIS_API_KEY=<anahtar> npm run hl7:mllp
 *
 * Ortam değişkenleri:
 *   HL7_HOST        dinlenecek adres (varsayılan 127.0.0.1; kurum içi HBYS'e açıkken 0.0.0.0)
 *   HL7_PORT        dinlenecek port (varsayılan 2575)
 *   HIS_BASE_URL    ArenaViewer adresi (varsayılan http://127.0.0.1:3000)
 *   HIS_API_KEY     /api/his/orders anahtarı (zorunlu)
 */
import net from "node:net";
import { buildAck, orderFromHl7, parseHl7 } from "../src/lib/hl7";
import { adtEvent } from "../src/lib/hl7Adt";

const HOST = process.env.HL7_HOST || "127.0.0.1";
const PORT = Number(process.env.HL7_PORT || 2575);
const BASE = (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = process.env.HIS_API_KEY || "";

if (!KEY) {
  console.error("[hl7] HIS_API_KEY tanımlı değil — köprüyi başlatmadan çıkılıyor.");
  process.exit(1);
}

const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", async (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    // MLLP karesi FS (0x1C) + CR ile biter; kare tam gelene kadar bekle.
    let idx: number;
    while ((idx = buf.indexOf("\x1c")) !== -1) {
      const raw = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 2); // FS + CR
      let msg;
      try {
        msg = parseHl7(raw);
      } catch {
        continue;
      }
      if (!msg) { sock.write(buildAck({ segments: [], sendingApp: "", sendingFacility: "", type: "", trigger: "", messageControlId: "" }, "AE", "Geçersiz HL7 mesajı")); continue; }

      // ADT (A08/A31/A40/A41): hasta güncelleme ve birleştirme → /api/his/adt.
      // Sipariş ucuyla karıştırılmaz; ADT mesajı çalışma **oluşturmaz**.
      const event = adtEvent(msg);
      if (event !== "other") {
        try {
          const r = await fetch(`${BASE}/api/his/adt`, {
            method: "POST",
            headers: { "Content-Type": "text/plain", "x-api-key": KEY },
            body: raw,
          });
          const body = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; applied?: { details?: string } };
          if (r.ok && body.ok) sock.write(buildAck(msg, "AA", `ADT ${event}: ${body.applied?.details ?? "uygulandı"}`));
          else sock.write(buildAck(msg, r.status === 422 ? "AR" : "AE", body.reason ?? `HTTP ${r.status}`));
        } catch (e) {
          sock.write(buildAck(msg, "AE", `ArenaViewer yanit vermedi: ${e instanceof Error ? e.message : String(e)}`));
        }
        continue;
      }

      const order = orderFromHl7(msg);
      if (!order) {
        sock.write(buildAck(msg, "AR", "Sipariş alanları eksik (hasta/istek/modality)."));
        continue;
      }
      try {
        const r = await fetch(`${BASE}/api/his/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": KEY },
          body: JSON.stringify(order),
        });
        if (r.ok) {
          const body = (await r.json().catch(() => ({}))) as { id?: number };
          sock.write(buildAck(msg, "AA", `Istem alindi (kayit #${body.id ?? "?"}).`));
        } else {
          const text = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
          sock.write(buildAck(msg, "AR", text));
        }
      } catch (e) {
        sock.write(buildAck(msg, "AE", `ArenaViewer yanit vermedi: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  });
  sock.on("error", () => { /* istemci koparsa sessizce geç */ });
});

server.listen(PORT, HOST, () => {
  console.log(`[hl7] MLLP dinleniyor: ${HOST}:${PORT} → ${BASE}/api/his/orders`);
});

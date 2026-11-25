/**
 * Kaynak adreslerini yeniden doğrulama betiği (ağ erişimi gerekir).
 *
 *   npm run verify:sources            # tüm dış kaynaklar
 *   npm run verify:sources -- --only radiant,ohif
 *
 * Tablodaki her dış iddia `src/lib/gapSources.ts` kayıt defterindedir. Bu betik
 * adreslere gerçek istek atar; ulaşılamayan kaynak varsa çıkış kodu 1 olur.
 * CI'da ağ erişimi olmadığı için `npm test` zincirine DAHİL DEĞİLDİR; kaynak
 * tarihleri `SOURCES_UPDATED` alanıyla elle güncellenir.
 */
import { GAP_SOURCES, SOURCES_UPDATED } from "../src/lib/gapSources";

const onlyArg = process.argv.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? new Set((onlyArg.split("=")[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  : null;

type Row = { key: string; label: string; url: string; status: string; ok: boolean };
const rows: Row[] = [];

async function probe(url: string): Promise<{ ok: boolean; status: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    let res = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow", headers: { "user-agent": "ArenaViewer-source-check/1.0" } });
    if (!res.ok || res.status === 405) {
      res = await fetch(url, { method: "GET", signal: ctl.signal, redirect: "follow", headers: { "user-agent": "ArenaViewer-source-check/1.0", range: "bytes=0-2048" } });
    }
    return { ok: res.status < 400, status: `${res.status} ${res.url !== url ? `→ ${res.url}` : ""}`.trim() };
  } catch (e) {
    return { ok: false, status: e instanceof Error ? (e.name === "AbortError" ? "zaman aşımı" : e.message) : "hata" };
  } finally {
    clearTimeout(t);
  }
}

const targets = Object.values(GAP_SOURCES).filter((s) => s.url && (!only || only.has(s.key)));
console.log(`Kaynak doğrulama · ${targets.length} adres · gözden geçirme tarihi ${SOURCES_UPDATED}\n`);

for (const s of targets) {
  const r = await probe(s.url!);
  rows.push({ key: s.key, label: s.label, url: s.url!, status: r.status, ok: r.ok });
  console.log(`${r.ok ? "✓" : "✗"} ${s.key.padEnd(16)} ${r.status.padEnd(28)} ${s.url}`);
}

const failed = rows.filter((r) => !r.ok);
const unverified = Object.values(GAP_SOURCES).filter((s) => !s.checkedAt).map((s) => s.key);
console.log(`\nÖzet: ${rows.length - failed.length}/${rows.length} erişilebilir.`);
if (unverified.length) console.log(`Doğrulanmamış kayıt (tabloda ⚠): ${unverified.join(", ")}`);
if (failed.length) {
  console.error(`\nErişilemeyen ${failed.length} kaynak: ${failed.map((r) => r.key).join(", ")}`);
  console.error("Bu adresleri güncelleyin veya kaydı 'doğrulanmadı' olarak işaretleyin (checkedAt: null + note).");
  process.exit(1);
}
console.log("Tüm kaynak adresleri yanıt verdi.");

/**
 * Süreç açılış kancası (Next.js `instrumentation`).
 *
 * g-webhard: paylaşılan hız sınırı deposunu **açılışta** kurar. Edge çalışma
 * zamanında `node:net` yok; orada kurulum atlanır ve proxy bellek yolunu
 * kullanır (bkz. `src/lib/webSecurity.ts` → `rateHit`).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installRateStore } = await import("./lib/rateStoreRuntime");
  const result = installRateStore();
  if (result.warning) console.warn(`[rate-store] ${result.warning}`);
  console.log(`[rate-store] ${result.kind}: ${result.detail}`);
}

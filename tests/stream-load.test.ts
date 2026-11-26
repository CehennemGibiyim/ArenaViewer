/**
 * Kademeli yükleme zamanlayıcısı testleri (v-perf).
 *
 * Doğrulanan sözleşmeler: dalga planı (geometrik, kesin artan, total'ı aşmaz),
 * her dizinin bir kez istenmesi, eşzamanlılık tavanı, tek kesit hatasının
 * yüklemeyi düşürmemesi, iptalde yeni istek başlatılmaması, `onWave`'in artan
 * `loaded` ile ve son dalgada tam sayıyla çağrılması.
 */
import assert from "node:assert/strict";
import { loadInWaves, planWaves } from "../src/lib/streamLoad";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

async function main() {
// ─────────── planWaves ───────────
ok(planWaves(0).length === 0, "boş çalışma: dalga yok");
ok(JSON.stringify(planWaves(10, { first: 12 })) === "[10]", "küçük çalışma: tek dalga (bölmenin faydası yok)");
const p300 = planWaves(300, { first: 12, factor: 4, maxWaves: 4 });
ok(p300[p300.length - 1] === 300, "son dalga total'a eşit (tam yükleme)");
ok(p300.length <= 4, `dalga sayısı maxWaves ile sınırlı (${p300.join(",")})`);
ok(p300.every((v, i) => i === 0 || v > p300[i - 1]), "dalga eşikleri kesin artan");
ok(p300.every((v) => v <= 300), "hiçbir eşik total'ı aşmaz");
ok(p300[0] === 12, "ilk dalga `first` kadar (erken önizleme)");
const p1000 = planWaves(1000, { first: 12, factor: 4, maxWaves: 4 });
ok(p1000[p1000.length - 1] === 1000, "1000 kesitte de son dalga tamamlar");
ok(new Set(p1000).size === p1000.length, "yuvarlama çakışması yok (tekil eşikler)");

// ─────────── loadInWaves: temel akış ───────────
{
  const calls: number[] = [];
  let inFlight = 0, peak = 0;
  const res = await loadInWaves<number>({
    total: 100,
    concurrency: 4,
    first: 10,
    factor: 3,
    maxWaves: 4,
    fetchOne: async (i) => {
      calls.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return i * 2;
    },
  });
  ok(res.ordered.length === 100 && res.failed.length === 0, "100 öğe eksiksiz geldi");
  ok(res.ordered.every((v, i) => v === i * 2), "dizin sırası korunur (sıra karışsa da)");
  ok(calls.length === 100 && new Set(calls).size === 100, "her dizin tam bir kez istendi");
  ok(peak <= 4, `eşzamanlılık tavanı aşılmadı (tepe ${peak})`);
  ok(res.aborted === false, "iptal yok");
}

// ─────────── onWave: kademeli görünürlük ───────────
{
  const seen: { wave: number; loaded: number }[] = [];
  const res = await loadInWaves<number>({
    total: 60,
    concurrency: 3,
    first: 6,
    factor: 3,
    maxWaves: 4,
    fetchOne: async (i) => i,
    onWave: ({ wave, loaded, items }) => {
      seen.push({ wave, loaded });
      // Erken dalgada yalnız o dalga kadarı hazır olmalı (kademeli his).
      if (wave === 1) assert.ok(items.slice(0, 6).every((v) => v !== undefined));
    },
  });
  ok(seen.length >= 2, "birden çok dalga bildirildi");
  ok(seen.every((s, i) => i === 0 || s.loaded >= seen[i - 1].loaded), "loaded monoton artıyor");
  ok(seen[0].loaded === 6, "ilk dalgada ilk 6 kesit hazır (erken önizleme)");
  ok(seen[seen.length - 1].loaded === 60, "son dalgada tümü hazır");
  ok(res.waves[res.waves.length - 1] === 60, "dalga eşikleri sonuçla uyumlu");
}

// ─────────── hata muhasebesi ───────────
{
  const bad = new Set([3, 17, 59]);
  const res = await loadInWaves<number>({
    total: 60,
    concurrency: 4,
    first: 6,
    factor: 3,
    maxWaves: 4,
    fetchOne: async (i) => {
      if (bad.has(i)) throw new Error(`kesit ${i} alınamadı`);
      return i;
    },
  });
  ok(res.failed.length === 3 && res.failed.join(",") === "3,17,59", "başarısız dizinler raporlandı (" + res.failed.join(",") + ")");
  ok(res.ordered.length === 57, "kalan 57 kesit yine de geldi (tek hata yüklemeyi düşürmez)");
  ok(res.items[3] === undefined && res.items[4] === 4, "başarısız yuva boş, komşusu dolu");
  ok(res.aborted === false, "hatalar iptal sayılmaz");
}

// ─────────── iptal ───────────
{
  const ctrl = new AbortController();
  let calls = 0;
  const res = await loadInWaves<number>({
    total: 500,
    concurrency: 2,
    first: 5,
    factor: 2,
    maxWaves: 4,
    signal: ctrl.signal,
    fetchOne: async (i) => {
      calls++;
      if (i === 4) ctrl.abort(); // ilk dalga içinde iptal
      await new Promise((r) => setTimeout(r, 2));
      return i;
    },
    onWave: () => { throw new Error("iptalden sonra onWave çağrılmamalı"); },
  });
  ok(res.aborted === true, "iptal bildirildi");
  ok(calls < 500, `iptalden sonra yeni istek başlatılmadı (${calls} istek)`);
  ok(calls <= 5, "ilk dalga sınırında durdu");
  ok(res.ordered.length <= 5, "kısmi sonuç döndü (fırlatmadı)");
}

// ─────────── iptal: onWave dalga sonunda tekrar kontrol ───────────
{
  const ctrl = new AbortController();
  const waves: number[] = [];
  const res = await loadInWaves<number>({
    total: 200,
    concurrency: 2,
    first: 4,
    factor: 4,
    maxWaves: 4,
    signal: ctrl.signal,
    fetchOne: async (i) => i,
    onWave: ({ wave }) => { waves.push(wave); if (wave === 1) ctrl.abort(); },
  });
  ok(waves.length === 1, "onWave iptali sonrası başka dalga çalışmadı");
  ok(res.aborted === true, "ikinci iptal yolu da raporlanıyor");
}

// ─────────── eşzamanlı başlangıç: yavaş ilk öğe diğerlerini bloklamaz ───────────
{
  const started: number[] = [];
  let releaseSlow: (() => void) | null = null;
  const slow = new Promise<void>((r) => { releaseSlow = r; });
  const p = loadInWaves<number>({
    total: 8,
    concurrency: 4,
    first: 8,
    fetchOne: async (i) => {
      started.push(i);
      if (i === 0) await slow;
      return i;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  ok(started.length === 8, `yavaş ilk kesit diğerlerini bloklamadı (başlayan ${started.length})`);
  releaseSlow!();
  const res = await p;
  ok(res.ordered.length === 8, "yavaş öğe tamamlanınca tümü geldi");
}

// ─────────── boş çalışma ───────────
{
  let waveCalled = false;
  const res = await loadInWaves<number>({ total: 0, fetchOne: async () => 1, onWave: () => { waveCalled = true; } });
  ok(res.ordered.length === 0 && !waveCalled, "0 öğede istek/onWave yok");
}



}

main().then(() => {
  if (failed) { console.error(`${failed} kademeli yükleme testi başarısız`); process.exit(1); }
  console.log("Tüm kademeli yükleme testleri geçti.");
}).catch((e) => { console.error(e); process.exit(1); });

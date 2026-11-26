/**
 * PET SUV pencere ön ayarları testleri.
 *
 * Sözleşme: SUV = piksel × factor olduğundan SUV aralığı factor'e bölünerek
 * modality penceresine çevrilir; factor geçersizse hiçbir ön ayar üretilmez.
 */
import {
  PET_SUV_PRESETS, modalityToSuv, modalityWindowToSuv, suvPresetsForSeries, suvWindowToModality,
} from "../src/lib/petWindows";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── 1. dönüşüm ──
const f = 0.5; // 1 modality birimi = 0,5 SUV
const w = suvWindowToModality(0, 5, f)!;
ok(w.wl === 5 && w.ww === 10, `SUV 0–5, factor 0,5 → WL 5 / WW 10 (${w.wl}/${w.ww})`);
ok(suvWindowToModality(2.5, 0, f)!.wl === 2.5, "ters verilen aralık normalize edilir (wl)");
ok(suvWindowToModality(0, 5, f)!.ww === suvWindowToModality(5, 0, f)!.ww, "ters verilen aralık normalize edilir (ww)");
ok(suvWindowToModality(0, 5, null) === null, "factor yok → null");
ok(suvWindowToModality(0, 5, 0) === null, "factor 0 → null");
ok(suvWindowToModality(0, 5, -2) === null, "negatif factor → null");
ok(suvWindowToModality(0, 5, NaN) === null, "NaN factor → null");
ok(suvWindowToModality(3, 3, f) === null, "sıfır genişlikli aralık → null");
ok(suvWindowToModality(NaN, 5, f) === null, "NaN aralık → null");
const big = suvWindowToModality(0, 5, 10_000)!;
ok(big.ww === 1, `çok küçük pencerede WW en az 1 (${big.ww})`);

// ── 2. hazır liste ──
ok(PET_SUV_PRESETS.length === 4, "4 hazır SUV ön ayarı");
ok(PET_SUV_PRESETS.every((p) => p.suvMin === 0 && p.suvMax > p.suvMin), "tüm ön ayarlar 0 tabanlı ve pozitif genişlikte");
const list = suvPresetsForSeries(0.2);
ok(list.length === 4, `factor 0,2 ile 4 ön ayar (${list.length})`);
const eq5 = list.find((p) => p.name.includes("0–5"))!;
ok(eq5.wl === 12.5 && eq5.ww === 25, `SUV 0–5 / factor 0,2 → WL 12,5 WW 25 (${eq5.wl}/${eq5.ww})`);
ok(suvPresetsForSeries(null).length === 0, "factor yoksa liste boş (UI ön ayar göstermez)");
ok(suvPresetsForSeries(undefined).length === 0, "undefined factor → boş liste");
ok(list.every((p) => Number.isFinite(p.wl) && p.ww > 0), "liste değerleri geçerli");

// ── 3. ters yön (bilgi amaçlı) ──
ok(modalityToSuv(20, f) === 10, "modality 20, factor 0,5 → SUV 10");
ok(modalityToSuv(20, null) === null, "factor yoksa SUV hesaplanmaz");
ok(modalityToSuv(NaN, f) === null, "NaN değer → null");
const back = modalityWindowToSuv(5, 10, f)!;
ok(back.suvMin === 0 && back.suvMax === 5, `WL 5 / WW 10 → SUV 0–5 (${back.suvMin}–${back.suvMax})`);
const clipped = modalityWindowToSuv(1, 4, f)!;
ok(clipped.suvMin === 0, "negatif alt sınır 0'a kırpılır (SUV negatif gösterilmez)");
ok(modalityWindowToSuv(5, 10, null) === null, "factor yoksa pencere→SUV null");

if (failed) { console.error(`${failed} PET pencere testi başarısız`); process.exit(1); }
console.log("PET SUV pencere testleri geçti.");

/**
 * a-stroke: CTP cSVD dekonvolüsyonu + otomatik AIF testleri.
 *
 * Sentetik veri: AIF = gama benzeri bolus; doku = AIF ∗ CBF·e^(−t/MTT) (Konvolüsyon
 * modeli). Beklenen: CBF gömülen CBF ile orantılı, MTT gömülen MTT'ye yakın.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ctpSvdSummary, ctpSvdText, deconvolve, jacobiEigen, parseCtpCurves, selectAif } from "../src/lib/ctp";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const t = Array.from({ length: 80 }, (_, i) => i);
const aifv = t.map((x) => (x < 5 ? 0 : (x - 4) * 50 * Math.exp(-(x - 4) / 3)));
const aif = { t, v: aifv };
const tissue = (cbf: number, mtt: number, delay = 0) =>
  t.map((x) => {
    let s = 0;
    const xd = x - delay;
    for (let k = 0; k <= Math.max(-1, xd); k++) s += aifv[xd - k] * Math.exp(-k / mtt);
    return s * cbf * 0.02;
  });

// ── doğrusal cebir temeli ──
const A = [[4, 1, 2], [1, 3, 0], [2, 0, 5]];
const { values, vectors } = jacobiEigen(A);
let maxRes = 0;
for (let m = 0; m < 3; m++) {
  const v = vectors.map((r) => r[m]);
  const Av = A.map((r) => r.reduce((s, x, i) => s + x * v[i], 0));
  maxRes = Math.max(maxRes, ...Av.map((x, i) => Math.abs(x - values[m] * v[i])));
}
ok(maxRes < 1e-9, "Jacobi özayrışımı: Av = λv (artık < 1e-9)");
ok(Math.abs(values.slice().sort((a, b) => a - b)[1] - 3.476) < 0.01, "özdeğerler bilinen değerlerle uyumlu");

// ── dekonvolüsyon doğruluğu ──
const d4 = deconvolve({ t, v: tissue(1, 4) }, aif);
ok(d4.mttSec > 3 && d4.mttSec < 5.5, `MTT ~4 sn geri kazanıldı (${d4.mttSec.toFixed(2)})`);
const d8 = deconvolve({ t, v: tissue(1, 8) }, aif);
ok(d8.mttSec > d4.mttSec, "uzun geçiş süresi daha yüksek MTT verir");
const half = deconvolve({ t, v: tissue(0.5, 4) }, aif);
ok(Math.abs(half.cbf / d4.cbf - 0.5) < 0.06, `CBF doğrusal ölçeklenir (oran ${(half.cbf / d4.cbf).toFixed(3)})`);
const noFlow = deconvolve({ t, v: t.map(() => 0) }, aif);
ok(noFlow.cbf === 0 && noFlow.cbv === 0 && noFlow.mttSec === 0, "sinyalsiz eğri güvenli (0/0 → 0)");

// ── Tmax = bolus gecikmesi ──
const delayed = deconvolve({ t, v: tissue(0.95, 12, 8) }, aif);
ok(delayed.tmaxSec >= 6 && delayed.tmaxSec <= 10, `gecikmeli doku Tmax ~8 sn (${delayed.tmaxSec})`);
ok(deconvolve({ t, v: tissue(1, 4) }, aif).tmaxSec <= 1, "normal doku Tmax ~0");

// ── kesme (truncation) etkisi belgelenmiş ──
const tr0 = deconvolve({ t, v: tissue(1, 6) }, aif, { truncation: 0 });
const tr2 = deconvolve({ t, v: tissue(1, 6) }, aif, { truncation: 0.2 });
ok(tr2.mttSec > tr0.mttSec, "kesme MTT'yi yukarı yanlı yapar (dokümante edilmiş davranış)");
ok(tr2.truncated !== tr0.truncated, "kesilen bileşen sayısı raporlanır");

// ── AIF seçimi ──
const candidates = [aif, { t, v: tissue(1, 5) }, { t, v: tissue(0.15, 5) }];
ok(selectAif(candidates) === 0, "AIF doğru seçildi (en erken/dar/yüksek)");
ok(selectAif([{ t: [], v: [] }]) === -1, "boş aday kümesi -1");
const noisyAif = { t, v: aifv.map((x) => x + 3) };
ok(selectAif([{ t, v: tissue(0.2, 5) }, noisyAif]) === 1, "geniş/düşük eğri yerine AIF seçilir");

// ── çoklu bölge özeti ──
const s = ctpSvdSummary([aif, { t, v: tissue(1, 5) }, { t, v: tissue(0.15, 5) }, { t, v: tissue(0.95, 12, 8) }]);
ok(s !== null && s.aifIndex === 0, "özet: AIF seçildi");
ok(s!.coreIndices.length === 1 && s!.coreIndices[0] === 2, "core: rCBF < %30 olan bölge");
ok(s!.penumbraIndices.length === 1 && s!.penumbraIndices[0] === 3, "penumbra: Tmax ≥ 6 sn ve core olmayan bölge");
ok(s!.mismatchRatio === 1, "mismatch oranı penumbra/core = 1");
ok(ctpSvdText(s!).includes("rCBF") && ctpSvdText(s!).includes("hekim"), "rapor metni rölatif değer + hekim uyarısı içerir");
ok(ctpSvdSummary([aif]) === null, "tek eğri yeterli değil");

// ── yapıştırılan eğrilerin çözümlenmesi ──
const parsed = parseCtpCurves("# bölge | t | v\nAIF | 0,1,2,3,4 | 100,120,300,900,700\nbozuk\nKesit 2 | 0 1 2 3 4 | 10 20 40 30 20\nx | 0,1 | 5,6");
ok(parsed.length === 2, "geçerli iki eğri ayrıştırıldı, bozuk satırlar atlandı");
ok(parsed[0].t.length === 5 && parsed[1].v[2] === 40, "virgül ve boşluk ayırıcıları desteklenir");

// ── iddia: stroke.ts geriye dönük uyumlu, yeni modül bağımsız ──
const root = path.resolve(__dirname, "..");
const stroke = readFileSync(path.join(root, "src/lib/stroke.ts"), "utf8");
ok(stroke.includes("ctpSummary") && stroke.includes("dekonvolüsyon"), "stroke.ts basit özet + sınır notunu koruyor");

if (failed) { console.error(`${failed} CTP dekonvolüsyon testi başarısız`); process.exit(1); }
console.log("Tüm a-stroke (cSVD dekonvolüsyon + AIF) testleri geçti.");

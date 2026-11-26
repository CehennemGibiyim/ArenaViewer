/**
 * SUVlbm / SUVbsa testleri (m-calib).
 *
 * Sözleşme: formüller bilinen referans değerleri tutturur; eksik boy/cinsiyette
 * hesaplanmaz ve nedeni yazılır; (0010,1020) hasta boyu metre/cm olarak açıkça
 * yorumlanır (tahmin gizlenmez).
 */
import {
  bodySurfaceAreaM2, heightFromPatientSize, leanBodyMassKg, parseSex, suvBsaFactor, suvLbmFactor, suvVariants,
} from "../src/lib/suvVariants";
import { suvFactor } from "../src/lib/suv";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const near = (a: number | null, b: number, tol = 0.05) => a !== null && Math.abs(a - b) <= tol;

// ── 1. cinsiyet ve boy yorumu ──
ok(parseSex("M") === "M" && parseSex("E") === "M", "M ve E erkek sayılır");
ok(parseSex("F") === "F" && parseSex("K") === "F", "F ve K kadın sayılır");
ok(parseSex("") === "unknown" && parseSex("O") === "unknown", "bilinmeyen cinsiyet 'unknown'");
const m = heightFromPatientSize(1.75);
ok(m.heightCm === 175 && m.assumed === "m", `1.75 → 175 cm (metre varsayımı)`);
const c = heightFromPatientSize(175);
ok(c.heightCm === 175 && c.assumed === "cm", "175 → 175 cm (cm varsayımı)");
ok(heightFromPatientSize(5).heightCm === null, "anlamsız boy (5) reddedilir");
ok(heightFromPatientSize(undefined).heightCm === null, "boy yoksa null");

// ── 2. yağsız kütle (Janmahasatian) ──
ok(near(leanBodyMassKg(70, 175, "M"), 55.9, 0.3), `erkek 70 kg/175 cm LBM ≈ 55,9 kg (${leanBodyMassKg(70, 175, "M")?.toFixed(2)})`);
ok(near(leanBodyMassKg(70, 175, "F"), 45.2, 0.3), `kadın 70 kg/175 cm LBM ≈ 45,2 kg (${leanBodyMassKg(70, 175, "F")?.toFixed(2)})`);
ok(leanBodyMassKg(70, 175, "unknown") === null, "cinsiyet yoksa LBM hesaplanmaz");
ok(leanBodyMassKg(0, 175, "M") === null && leanBodyMassKg(70, 0, "M") === null, "sıfır kilo/boy → null");
ok((leanBodyMassKg(120, 175, "M") ?? 0) > (leanBodyMassKg(70, 175, "M") ?? 0), "kilo artınca LBM artar");

// ── 3. vücut yüzey alanı (Du Bois) ──
ok(near(bodySurfaceAreaM2(70, 175), 1.85, 0.02), `BSA 70 kg/175 cm ≈ 1,85 m² (${bodySurfaceAreaM2(70, 175)?.toFixed(3)})`);
ok(near(bodySurfaceAreaM2(50, 150), 1.43, 0.03), `BSA 50 kg/150 cm ≈ 1,43 m² (${bodySurfaceAreaM2(50, 150)?.toFixed(3)})`);
ok(bodySurfaceAreaM2(70, 0) === null, "boy yoksa BSA null");

// ── 4. çarpanlar ──
const base = { weightKg: 70, heightCm: 175, doseBq: 370e6, halfLifeS: 6586.2, deltaS: 3600 };
const bw = suvFactor({ weightKg: 70, doseBq: 370e6, halfLifeS: 6586.2, deltaS: 3600 });
const lbm = suvLbmFactor({ ...base, sex: "M" })!;
const bsa = suvBsaFactor(base)!;
ok(lbm > 0 && bsa > 0, "iki çarpan da pozitif");
// Yağsız kütle < vücut ağırlığı olduğundan SUVlbm çarpanı SUVbw'den küçüktür (obezitede SUVbw şişmesini azaltır).
ok(lbm < bw && bsa < lbm, `çarpan sırası SUVbsa < SUVlbm < SUVbw (${bsa.toExponential(2)} < ${lbm.toExponential(2)} < ${bw.toExponential(2)})`);
ok(Math.abs(lbm / bw - 55.9 / 70) < 0.01, "SUVlbm/SUVbw oranı = LBM/ağırlık");
ok(Math.abs(bsa / bw - 1.85 / 70) < 0.01, "SUVbsa/SUVbw oranı = BSA/ağırlık");
ok(suvLbmFactor({ ...base, sex: "unknown" }) === null, "cinsiyet yoksa SUVlbm çarpanı null");
ok(suvBsaFactor({ ...base, heightCm: null }) === null, "boy yoksa SUVbsa çarpanı null");
ok(suvLbmFactor({ ...base, sex: "M", doseBq: 0 }) === null, "doz yoksa çarpan null");

// ── 5. varyant özeti ──
const v = suvVariants({ ...base, sex: "F" });
ok(v.lbm.factor !== null && v.lbm.lbmKg !== null && v.lbm.note.includes("kadın"), `SUVlbm notu cinsiyeti yazar (${v.lbm.note})`);
ok(v.bsa.factor !== null && v.bsa.bsaM2 !== null && v.bsa.note.includes("Du Bois"), "SUVbsa notu formülü yazar");
const noHeight = suvVariants({ ...base, heightCm: null, sex: "M" });
ok(noHeight.lbm.factor === null && noHeight.lbm.note.includes("boy"), "boy yoksa SUVlbm notu nedeni söyler");
ok(noHeight.bsa.factor === null && noHeight.bsa.note.includes("boy"), "boy yoksa SUVbsa notu nedeni söyler");
const noSex = suvVariants({ ...base, sex: "unknown" });
ok(noSex.lbm.factor === null && noSex.lbm.note.includes("Cinsiyet"), "cinsiyet yoksa SUVlbm notu nedeni söyler");
ok(noSex.bsa.factor !== null, "cinsiyet gerekmez: SUVbsa yine hesaplanır");

if (failed) { console.error(`${failed} SUV varyantı testi başarısız`); process.exit(1); }
console.log("SUV varyantı testleri geçti.");

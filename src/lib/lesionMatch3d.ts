/**
 * 3B lezyon eşleştirme (registration tabanlı) — c-recist-full.
 *
 * `lesionTracking.ts` eşleştirmeyi **anatomi adı + konum metni** üzerinden
 * yapıyor; bu, farklı çalışmalarda farklı segmentasyon/etiketleme olduğunda
 * kırılır ("segment 8" ↔ "sağ lob posterior" gibi). Bu modül hacimsel
 * koordinatlarla çalışır:
 *
 *   1. **Rijit hizalama** (Kabsch): bazal ve izlem lezyon merkez kümeleri
 *      arasında en küçük kareler dönme+ötelenme bulunur (Jacobi özdeğer ile
 *      SVD'siz çözüm). Hasta koordinatları aynı çerçevedeyse genellikle
 *      özdeşlik çıkar; farklı çerçeveler/personel hatası düzeltilir.
 *   2. **Eşleştirme**: hizalama sonrası en yakın komşu + karşılıklı (mutual)
 *      kabul ve mesafe eşiği. Tek taraflı eşleşme kabul edilmez.
 *   3. **Boyut/şekil değişimi**: her eşleşme için uzun çap ve hacim oranı.
 *   4. **Belirsiz durumlar**: eşik yakınındaki eşleşmeler "belirsiz" olarak
 *      işaretlenir (sessizce eşleştirilmez, hekim doğrular).
 *
 * Klinik karar aracı değildir; RECIST hedef seçimi ve ölçüm hekime aittir.
 */

export interface Lesion3D {
  id: string;
  /** Hasta koordinatı (mm) — DICOM LPS */
  x: number;
  y: number;
  z: number;
  /** En uzun çap (mm); yoksa null */
  longMm?: number | null;
  /** Hacim (mm³); yoksa null */
  volumeMm3?: number | null;
  /** Anatomi etiketi (yalnız doğrulama/uyarı için) */
  anatomy?: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Ağırlık merkezi. */
export function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  const s = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / points.length, y: s.y / points.length, z: s.z / points.length };
}

/**
 * Jacobi özayrışımı (simetrik 3×3). Dönen `values` azalan sırada, `vectors`
 * sütunları özvektörlerdir. Dönme matrisi Kabsch için kullanılır.
 */
export function jacobiEigen3(m: number[][], sweeps = 40): { values: number[]; vectors: number[][] } {
  const a = m.map((r) => [...r]);
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let s = 0; s < sweeps; s++) {
    // En büyük köşegen dışı öğeyi bul.
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > max) { max = Math.abs(a[i][j]); p = i; q = j; }
    if (max < 1e-12) break;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const sn = t * c;
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = c * akp - sn * akq;
      a[k][q] = sn * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = c * apk - sn * aqk;
      a[q][k] = sn * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - sn * vkq;
      v[k][q] = sn * vkp + c * vkq;
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: idx.map((i) => a[i][i]),
    vectors: [[0, 1, 2].map((r) => v[r][idx[0]]), [0, 1, 2].map((r) => v[r][idx[1]]), [0, 1, 2].map((r) => v[r][idx[2]])],
  };
}

export interface RigidTransform {
  /** 3×3 dönme (satır major) */
  rotation: number[][];
  translation: Vec3;
  /** Hizalama sonrası ortalama artık (mm) */
  rmsMm: number;
  /** Ölçek: 1'e çok yakınsa rijit hizalama güvenilir */
  scale: number;
  note: string;
}

const mul = (r: number[][], p: Vec3): Vec3 => ({
  x: r[0][0] * p.x + r[0][1] * p.y + r[0][2] * p.z,
  y: r[1][0] * p.x + r[1][1] * p.y + r[1][2] * p.z,
  z: r[2][0] * p.x + r[2][1] * p.y + r[2][2] * p.z,
});

/** Nokta kümesine rijit dönüşümü uygular. */
export function applyRigid(t: RigidTransform, p: Vec3): Vec3 {
  const r = mul(t.rotation, p);
  return { x: r.x + t.translation.x, y: r.y + t.translation.y, z: r.z + t.translation.z };
}

/**
 * Genel simetrik matris için Jacobi özayrışımı (n×n, küçük n).
 * Özdeğerler azalan sırada; `vectors[k]` k. özvektördür.
 */
export function jacobiEigenSymmetric(input: number[][], sweeps = 100): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  const order = [...Array(n).keys()].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => [...Array(n).keys()].map((r) => v[r][i])),
  };
}

/** Kuaterniyon → 3×3 dönme matrisi (Horn). */
export function quaternionToRotation(w: number, x: number, y: number, z: number): number[][] {
  const n = Math.hypot(w, x, y, z) || 1;
  const [qw, qx, qy, qz] = [w / n, x / n, y / n, z / n];
  return [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
}

/**
 * Rijit hizalama (Horn'un kuaterniyon yöntemi): kaynak noktaları hedefe
 * eşleyen dönme + ötelenme. Kapalı form çözüm olduğu için yineleme yoktur ve
 * yansıma (determinant −1) üretmez.
 *
 * 1–2 noktada dönme belirsizdir; yalnız ötelenme hesaplanır ve `note` bunu yazar.
 */
export function rigidAlign(source: Vec3[], target: Vec3[]): RigidTransform | null {
  const n = Math.min(source.length, target.length);
  if (n === 0) return null;
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const cs = centroid(source.slice(0, n));
  const ct = centroid(target.slice(0, n));
  if (n < 3) {
    const translation = { x: ct.x - cs.x, y: ct.y - cs.y, z: ct.z - cs.z };
    const t: RigidTransform = { rotation: identity, translation, rmsMm: 0, scale: 1, note: "" };
    const ss = source.slice(0, n).reduce((acc, p, i) => acc + dist(applyRigid(t, p), target[i]) ** 2, 0);
    t.rmsMm = Math.round(Math.sqrt(ss / n) * 100) / 100;
    t.note = `${n} nokta ile yalnız ötelenme hesaplandı; dönme belirsiz (en az 3 nokta gerekir).`;
    return t;
  }

  // Çapraz kovaryans S = Σ (a−ā)(b−b̄)ᵀ
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const av = [source[i].x - cs.x, source[i].y - cs.y, source[i].z - cs.z];
    const bv = [target[i].x - ct.x, target[i].y - ct.y, target[i].z - ct.z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += av[r] * bv[c];
  }
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const { vectors } = jacobiEigenSymmetric(N);
  const [qw, qx, qy, qz] = vectors[0];
  const R = quaternionToRotation(qw, qx, qy, qz);

  const rotCs = mul(R, cs);
  const translation = { x: ct.x - rotCs.x, y: ct.y - rotCs.y, z: ct.z - rotCs.z };
  const transform: RigidTransform = { rotation: R, translation, rmsMm: 0, scale: 1, note: "" };
  let ss = 0;
  for (let i = 0; i < n; i++) ss += dist(applyRigid(transform, source[i]), target[i]) ** 2;
  transform.rmsMm = Math.round(Math.sqrt(ss / n) * 100) / 100;

  const spread = (pts: Vec3[], c: Vec3) => Math.sqrt(pts.reduce((acc, p) => acc + dist(p, c) ** 2, 0) / Math.max(1, pts.length));
  const sSpread = spread(source.slice(0, n), cs);
  const tSpread = spread(target.slice(0, n), ct);
  transform.scale = sSpread > 1e-9 ? Math.round((tSpread / sSpread) * 1000) / 1000 : 1;
  transform.note =
    Math.abs(transform.scale - 1) > 0.1
      ? `Ölçek farkı ${transform.scale} — hacim/kalibrasyon farkı olabilir; rijit hizalama yanıltıcı (artık ${transform.rmsMm} mm).`
      : n < 5
        ? `${n} nokta ile hizalandı (az sayıda nokta; artık ${transform.rmsMm} mm).`
        : `Rijit hizalama: ${n} nokta, artık ${transform.rmsMm} mm.`;
  return transform;
}

export type MatchStatus = "eslesti" | "belirsiz" | "yeni" | "kayboldu";

export interface Match3D {
  baseline: Lesion3D | null;
  followUp: Lesion3D | null;
  /** Hizalama sonrası merkez mesafesi (mm) */
  distanceMm: number | null;
  status: MatchStatus;
  /** Uzun çap oranı (izlem/bazal); ikisi de varsa */
  sizeRatio: number | null;
  volumeRatio: number | null;
  note: string;
}

export interface MatchOptions {
  /** Kesin eşleşme mesafesi (mm) */
  maxMm?: number;
  /** Bu mesafeye kadar "belirsiz" (mm) */
  ambiguousMm?: number;
  /** Anatomi etiketi uyuşmazsa belirsiz say */
  requireAnatomy?: boolean;
}

export const MATCH_DEFAULTS = { maxMm: 15, ambiguousMm: 25 } as const;

/**
 * Hizalama kapısı: lezyon merkezlerinden tahmin edilen rijit dönüşüm, artık
 * hata ve ölçek açısından kabul edilebilir mi?
 *
 * Lezyon kümeleri karşılıklı değilse (bazı lezyonlar kaybolmuş/yeni çıkmışsa)
 * en küçük kareler hizalaması **yanıltıcı** olur: tüm noktaları yanlış yere
 * taşır. Böyle bir dönüşüm uygulanmaz; eşleştirme ham koordinatlarla yapılır ve
 * gerekçe raporlanır. Görüntü tabanlı registrasyon (kayıt) bu modülün kapsamı
 * dışındadır; buradaki hizalama yalnız küçük çerçeve/konum farkları içindir.
 */
export const ALIGN_GATE = { maxRmsMm: 10, maxScaleDrift: 0.15 } as const;

export function alignmentAcceptable(t: RigidTransform | null): { ok: boolean; reason: string } {
  if (!t) return { ok: false, reason: "Hizalama hesaplanamadı." };
  if (t.rmsMm > ALIGN_GATE.maxRmsMm) {
    return { ok: false, reason: `Hizalama reddedildi: artık hata ${t.rmsMm} mm (eşik ${ALIGN_GATE.maxRmsMm} mm) — lezyon kümeleri karşılıklı değil.` };
  }
  if (Math.abs(t.scale - 1) > ALIGN_GATE.maxScaleDrift) {
    return { ok: false, reason: `Hizalama reddedildi: ölçek farkı ${t.scale} — farklı kalibrasyon/hacim; ham koordinatlar kullanıldı.` };
  }
  return { ok: true, reason: t.note };
}

const normAnatomy = (s: string | undefined) => (s ?? "").trim().toLocaleLowerCase("tr-TR");

/**
 * Hizalama + karşılıklı en yakın komşu eşleştirme.
 *
 * Karşılıklılık: A→B en yakın olan, B→A'da da en yakın olmalı; aksi halde
 * eşleşme "belirsiz" sayılır (tek taraflı eşleşme sessizce kabul edilmez).
 */
export function matchLesions3d(
  baseline: Lesion3D[],
  followUp: Lesion3D[],
  opts: MatchOptions = {},
): { transform: RigidTransform | null; matches: Match3D[]; ambiguous: number; note: string; /** Hizalama reddedildiyse gerekçe */ rejected: string } {
  const maxMm = opts.maxMm ?? MATCH_DEFAULTS.maxMm;
  const ambiguousMm = Math.max(maxMm, opts.ambiguousMm ?? MATCH_DEFAULTS.ambiguousMm);
  // Hizalama için her iki tarafta en az 3 lezyon gerekir: 1–2 noktalı çözüm
  // yalnız ötelenmedir ve iki noktayı zorla üst üste getirir (sahte eşleşme).
  const MIN_ALIGN_POINTS = 3;
  const raw =
    baseline.length >= MIN_ALIGN_POINTS && followUp.length >= MIN_ALIGN_POINTS
      ? rigidAlign(baseline.map((l) => ({ x: l.x, y: l.y, z: l.z })), followUp.map((l) => ({ x: l.x, y: l.y, z: l.z })))
      : null;
  // Kapıdan geçmeyen hizalama UYGULANMAZ (yanlış eşleştirme üretmemek için).
  const gate = raw
    ? alignmentAcceptable(raw)
    : {
        ok: false,
        reason:
          baseline.length && followUp.length
            ? `Hizalama yapılmadı: her iki tarafta en az ${MIN_ALIGN_POINTS} lezyon gerekir (bazal ${baseline.length}, izlem ${followUp.length}); eşleştirme ham koordinatlarla yapıldı.`
            : "Hizalama yapılamadı (bir tarafta lezyon yok).",
      };
  const transform = gate.ok ? raw : null;
  const rejectedReason = transform ? "" : gate.reason;

  const aligned = baseline.map((b) => (transform ? applyRigid(transform, b) : { x: b.x, y: b.y, z: b.z }));
  const d: number[][] = aligned.map((a) => followUp.map((f) => dist(a, f)));

  // Karşılıklı en yakınlar
  const bestForBase = aligned.map((_, i) => (followUp.length ? d[i].reduce((bi, v, j) => (v < d[i][bi] ? j : bi), 0) : -1));
  const bestForFollow = followUp.map((_, j) => (baseline.length ? aligned.reduce((bi, _, i) => (d[i][j] < d[bi][j] ? i : bi), 0) : -1));

  const matches: Match3D[] = [];
  const usedBase = new Set<number>();
  const usedFollow = new Set<number>();

  aligned.forEach((_, i) => {
    const j = bestForBase[i];
    if (j < 0) return;
    const b = baseline[i], f = followUp[j];
    const dd = d[i][j];
    const anatomyOk = !opts.requireAnatomy || normAnatomy(b.anatomy) === normAnatomy(f.anatomy);
    const mutual = bestForFollow[j] === i;
    const sizeRatio = b.longMm && f.longMm ? Math.round((f.longMm / b.longMm) * 1000) / 1000 : null;
    const volumeRatio = b.volumeMm3 && f.volumeMm3 ? Math.round((f.volumeMm3 / b.volumeMm3) * 1000) / 1000 : null;
    let status: MatchStatus;
    let note: string;
    if (dd <= maxMm && mutual && anatomyOk) {
      status = "eslesti";
      note = `Merkez mesafesi ${Math.round(dd * 10) / 10} mm.`;
    } else if (dd <= ambiguousMm) {
      status = "belirsiz";
      const why = !mutual ? "en yakın değil (karşılıklı değil)" : !anatomyOk ? "anatomi etiketi uyuşmuyor" : "mesafe eşik üstü";
      note = `Belirsiz: ${why} (${Math.round(dd * 10) / 10} mm). Hekim doğrulaması gerekir.`;
    } else {
      status = "kayboldu";
      note = `İzlemde ${Math.round(dd * 10) / 10} mm uzakta en yakın lezyon; eşleşme kabul edilmedi.`;
    }
    if (status !== "kayboldu") { usedBase.add(i); usedFollow.add(j); }
    matches.push({ baseline: b, followUp: status === "kayboldu" ? null : f, distanceMm: Math.round(dd * 10) / 10, status, sizeRatio, volumeRatio, note });
  });

  followUp.forEach((f, j) => {
    if (usedFollow.has(j)) return;
    matches.push({ baseline: null, followUp: f, distanceMm: null, status: "yeni", sizeRatio: null, volumeRatio: null, note: "İzlemde yeni lezyon (bazalde karşılığı yok)." });
  });
  baseline.forEach((b, i) => {
    if (usedBase.has(i)) return;
    if (matches.some((m) => m.baseline?.id === b.id)) return;
    matches.push({ baseline: b, followUp: null, distanceMm: null, status: "kayboldu", sizeRatio: null, volumeRatio: null, note: "Bazal lezyon izlemde eşleşmedi." });
  });

  const ambiguous = matches.filter((m) => m.status === "belirsiz").length;
  const note = [
    transform ? transform.note : rejectedReason,
    `Eşleşme: ${matches.filter((m) => m.status === "eslesti").length} kesin, ${ambiguous} belirsiz, ${matches.filter((m) => m.status === "yeni").length} yeni, ${matches.filter((m) => m.status === "kayboldu").length} kayboldu.`,
    ambiguous > 0 ? "Belirsiz eşleşmeler otomatik kabul edilmez; RECIST değerlendirmesinde hekim kararı gerekir." : "",
  ].filter(Boolean).join(" ");
  return { transform, matches, ambiguous, note, rejected: transform ? "" : rejectedReason };
}

/** Eşleşme tablosu (CSV). */
export function matchCsv(matches: Match3D[]): string {
  const head = ["Bazal", "İzlem", "Durum", "Mesafe (mm)", "Çap oranı", "Hacim oranı", "Not"];
  const rows = matches.map((m) => [
    m.baseline?.id ?? "",
    m.followUp?.id ?? "",
    m.status,
    m.distanceMm === null ? "" : String(m.distanceMm),
    m.sizeRatio === null ? "" : String(m.sizeRatio),
    m.volumeRatio === null ? "" : String(m.volumeRatio),
    m.note.replace(/;/g, ","),
  ]);
  return [head, ...rows].map((r) => r.join(";")).join("\n");
}

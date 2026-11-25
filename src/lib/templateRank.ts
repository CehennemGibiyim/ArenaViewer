/**
 * Şablon kütüphanesi akıllı sıralama + RadReport eşlemesi (r-template).
 *
 * Neden gerekli: 40+ şablonluk kütüphanede hekimin aradığı şablonu her seferinde
 * araması iş akışını yavaşlatır. Sıralama **kişiseldir** ve üç sinyali birleştirir:
 *
 *  1. **Favori** (açık kullanıcı işareti) — her zaman önde.
 *  2. **Son kullanım** (kullanıcı başına sayaç, en fazla 30 gün) — günlük iş
 *     akışındaki şablon kendiliğinden yukarı çıkar.
 *  3. **Bağlam** (modalite + bölge eşleşmesi) — yanlış modalitedeki şablon
 *     (ör. BT şablonu MR raporunda) önerilmez, yalnız arama sonucunda görünür.
 *
 * Ayrıca izlenebilirlik: her şablon opsiyonel **RadReport kodu** taşır
 * (`RPTxxxx`), böylece kurum şablonları RSNA RadReport/ACR paketleriyle
 * eşleştirilebilir. Kod yoksa şablon "kuruma özgü" işaretlenir — dış standarda
 * uyduğu iddia edilmez.
 */

export interface TemplateLike {
  id: number;
  name: string;
  modality: string;
  bodyPart: string;
  indication: string;
  protocol: string;
  /** RadReport/kurum katalog kodu (opsiyonel). */
  radreportCode?: string;
}

export interface TemplateUsage {
  /** Şablon kimliği → kullanım sayısı. */
  counts: Record<string, number>;
  /** Şablon kimliği → son kullanım (ISO). */
  lastUsed: Record<string, string>;
}

export const EMPTY_USAGE: TemplateUsage = { counts: {}, lastUsed: {} };

/** Kullanım verisini 30 günden eski kayıtlardan arındırır (bellek/sır tutarlılığı). */
export function pruneUsage(u: TemplateUsage, now = Date.now(), maxAgeDays = 30): TemplateUsage {
  const limit = now - maxAgeDays * 86_400_000;
  const counts: Record<string, number> = {};
  const lastUsed: Record<string, string> = {};
  for (const [id, iso] of Object.entries(u.lastUsed)) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < limit) continue;
    lastUsed[id] = iso;
    counts[id] = Math.max(0, u.counts[id] ?? 0);
  }
  return { counts, lastUsed };
}

/** Bir şablonun kullanımını kaydeder (sayaç + zaman). */
export function recordUsage(u: TemplateUsage, id: number, now = new Date()): TemplateUsage {
  const key = String(id);
  return {
    counts: { ...u.counts, [key]: (u.counts[key] ?? 0) + 1 },
    lastUsed: { ...u.lastUsed, [key]: now.toISOString() },
  };
}

const norm = (s: string) => (s ?? "").toLocaleLowerCase("tr-TR").trim();

/** Bölge eşleşmesi: biri diğerini içeriyorsa ya da kelime örtüşmesi varsa. */
export function bodyPartMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(/\s+/).filter((w) => w.length >= 3);
  const wb = nb.split(/\s+/).filter((w) => w.length >= 3);
  return wa.some((w) => wb.includes(w));
}

export interface RankContext {
  /** Raporun modalitesi (boş = modalite filtresi yok). */
  modality: string;
  bodyPart?: string;
  favorites?: number[];
  usage?: TemplateUsage;
  /** Arama metni (boş = tüm kütüphane). */
  query?: string;
  now?: number;
}

export interface RankedTemplate {
  t: TemplateLike;
  favorite: boolean;
  uses: number;
  score: number;
  /** Neden önerildi (arayüzde rozet). */
  reason: "favori" | "sik-kullanilan" | "bolge" | "modalite" | "kurum";
}

/**
 * Şablonları kişisel önceliğe göre sıralar.
 *
 * Puanlama: favori = 1000, kullanım sayısı × 10 (en fazla 200), bölge eşleşmesi
 * = 50, modalite eşleşmesi = 20, son kullanım tazeliği = en fazla 15. Eşitlikte
 * ad alfabetik — sıralama deterministik (test edilebilir).
 *
 * Filtreler: arama metni varsa ad/bölge/endikasyon/protokol içinde arar
 * (Türkçe küçük harf). Modalite uyuşmayan şablonlar **yalnız** arama varsa
 * listelenir ve sona düşer (hekim bilinçli arıyorsa erişebilmeli).
 */
export function rankTemplates(list: TemplateLike[], ctx: RankContext): RankedTemplate[] {
  const fav = new Set(ctx.favorites ?? []);
  const usage = ctx.usage ?? EMPTY_USAGE;
  const q = norm(ctx.query ?? "");
  const now = ctx.now ?? Date.now();
  const out: RankedTemplate[] = [];

  for (const t of list) {
    const modalityOk = !ctx.modality || norm(t.modality) === norm(ctx.modality);
    const hay = norm([t.name, t.bodyPart, t.indication, t.protocol].join(" "));
    if (q && !hay.includes(q)) continue;
    if (!modalityOk && !q) continue;

    const isFav = fav.has(t.id);
    const uses = usage.counts[String(t.id)] ?? 0;
    const last = usage.lastUsed[String(t.id)];
    const sonGun = last ? Math.max(0, (now - Date.parse(last)) / 86_400_000) : null;
    const tazelik = sonGun === null ? 0 : Math.max(0, 15 - sonGun / 2);
    const bolge = ctx.bodyPart && bodyPartMatch(t.bodyPart, ctx.bodyPart) ? 50 : 0;
    const score = (isFav ? 1000 : 0) + Math.min(200, uses * 10) + bolge + (modalityOk ? 20 : -30) + tazelik;

    const reason: RankedTemplate["reason"] = isFav
      ? "favori"
      : uses >= 3
        ? "sik-kullanilan"
        : bolge > 0
          ? "bolge"
          : modalityOk
            ? "modalite"
            : "kurum";

    out.push({ t, favorite: isFav, uses, score, reason });
  }

  return out.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name, "tr"));
}

/** Favorileri değiştirir (id var ise çıkar, yok ise ekle); en fazla `max`. */
export function toggleFavorite(favorites: number[], id: number, max = 40): number[] {
  if (!Number.isFinite(id)) return favorites;
  if (favorites.includes(id)) return favorites.filter((x) => x !== id);
  return [id, ...favorites].slice(0, max);
}

/** RadReport kimliği biçimi (RSNA RPTxxx / kurum kodu). */
export const RADREPORT_RE = /^RPT[A-Z0-9]{2,10}$/;

/** RadReport kodu geçerli mi (boş = kuruma özgü, kabul). */
export function isStandardCode(code: string): boolean {
  const c = (code ?? "").trim().toUpperCase();
  return c !== "" && RADREPORT_RE.test(c);
}

/** Şablonun standarda uygunluk etiketi. */
export function standardLabel(code: string | null | undefined): { standard: boolean; label: string } {
  const c = (code ?? "").trim();
  if (!c) return { standard: false, label: "Kuruma özgü (RadReport kodu yok)" };
  if (isStandardCode(c)) return { standard: true, label: `RadReport ${c.toUpperCase()}` };
  return { standard: false, label: `Geçersiz kod: ${c}` };
}

/** Kütüphane sağlığı: kaç şablon kodlu, kaç endikasyonlu (yönetim kartı). */
export function libraryStats(list: (TemplateLike & { radreportCode?: string | null })[]) {
  const withCode = list.filter((t) => isStandardCode(t.radreportCode ?? ""));
  const withIndication = list.filter((t) => (t.indication ?? "").trim().length > 0);
  const byModality: Record<string, number> = {};
  for (const t of list) byModality[t.modality || "—"] = (byModality[t.modality || "—"] ?? 0) + 1;
  return {
    total: list.length,
    withCode: withCode.length,
    withIndication: withIndication.length,
    coverage: list.length ? Math.round((withCode.length / list.length) * 100) : 0,
    byModality,
  };
}

/**
 * Tohum şablonlara RadReport kodları (RSNA RPT biçiminde, kurum içi kimlikler).
 *
 * Not: kodlar **yerel katalog kimliğidir**; RSNA RadReport şablonlarına
 * birebir eşleme lisans/doğrulama gerektirir. Burada amaç izlenebilirlik:
 * aynı şablonun kurumlar arasında kodla anılabilmesi.
 */
export const RADREPORT_SEED: Record<string, string> = {
  "BT Beyin — Normal": "RPTCT01",
  "BT Beyin — Hiperdens odak (şablon)": "RPTCT02",
  "BT Beyin — İskemi (şablon)": "RPTCT03",
  "BT Toraks — Normal": "RPTCT10",
  "BT Toraks — Pulmoner nodül (şablon)": "RPTCT11",
  "BT Toraks — Pnömoni/İnfiltrat (şablon)": "RPTCT12",
  "BT Abdomen — Karaciğer lezyon (şablon)": "RPTCT20",
  "BT Anjiyo (PE protokolü) — Şablon": "RPTCT30",
  "MR Beyin — Normal": "RPTMR01",
  "MR Beyin — Difüzyon (DWI/ADC) (şablon)": "RPTMR02",
  "MR Beyin — Kontrastlı (şablon)": "RPTMR03",
  "MR Lomber Bel — Normal": "RPTMR10",
  "MR Lomber Bel — Disk/Stenoz (şablon)": "RPTMR11",
  "MR Diz — Normal": "RPTMR20",
  "MR Prostat — PI-RADS (şablon)": "RPTMR30",
  "Ultrason — Karaciğer Normal": "RPTUS01",
  "Ultrason — Tiroid (şablon)": "RPTUS10",
  "Ultrason — Ekokardiyografi (şablon)": "RPTUS20",
  "Mamografi (4 standart pozisyon) — Normal": "RPTMG01",
  "Mamografi — Bulgu (şablon)": "RPTMG02",
  "PET-CT / Sintigrafi — Teknik": "RPTNM01",
  "Akciğer Grafisi PA — Normal": "RPTCR01",
  "Akciğer Grafisi Lateral — Normal": "RPTCR02",
  "Ekstremite Grafisi — Kırık (şablon)": "RPTCR10",
};

/** Tohum adından kod (yoksa null → kuruma özgü). */
export function seedCode(name: string): string | null {
  return RADREPORT_SEED[name] ?? null;
}

/** Tohum listesini kodlarla eşler (tanınmayan adlar kodsuz kalır). */
export function withSeedCodes<T extends { name: string }>(list: T[]): (T & { radreportCode: string | null })[] {
  return list.map((t) => ({ ...t, radreportCode: seedCode(t.name) }));
}

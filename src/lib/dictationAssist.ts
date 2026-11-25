/**
 * Dikte sonrası hekim onaylı öğrenme + sesli komut motoru (r-dictate).
 *
 * Neden gerekli: tarayıcı konuşma tanıması Türkçe tıbbi terimlerde sistematik
 * hata yapar ("pnömotoraks" → "pnomotoraks"). Kurum sözlüğü elle bakım
 * istemeden iyileşebilir: hekim bir düzeltmeyi kabul ettiğinde bu **öneri**
 * olarak kaydedilir; ikinci kez aynı düzeltme kabul edilirse otomatik uygulanır.
 * Hiçbir düzeltme hekim onayı olmadan rapora yazılmaz.
 *
 * Ayrıca mikrofon düğmesinin ötesinde **sesli komutlar** (kesit ilerlet,
 * zoom, ölçüm, kontrast, pencere) tanımlanır; eşleşmeyen cümle metin olarak
 * akar — komut motoru asla metni yutmaz.
 */

import { normalizeDictation, processDictation, type DictationCommand, type DictationResult } from "./dictate";

// ───────────── Kurum sözlüğü (öğrenilen düzeltmeler) ─────────────

/** Öneri: yanlış yazım → doğru yazım. */
export interface LearnedCorrection {
  from: string;
  to: string;
  /** Kaç kez hekim tarafından kabul edildi. */
  accepts: number;
  /** Kaç kez reddedildi (art arda reddedilirse öneri düşer). */
  rejects: number;
  /** Son kabul zamanı (ISO). */
  lastAccepted: string;
}

export const AUTO_APPLY_AT = 2;
export const MAX_CORRECTIONS = 300;

const normKey = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();

/**
 * Hekim bir düzeltmeyi kabul ettiğinde sözlüğü günceller (saf; saklama çağıranda).
 * Ret, `accepts` sayacını düşürür; sayaç 0'a inerse öneri silinir.
 */
export function recordCorrection(
  list: LearnedCorrection[],
  from: string,
  to: string,
  accepted: boolean,
  now = new Date().toISOString(),
): LearnedCorrection[] {
  const f = normKey(from);
  const t = normKey(to);
  // Ret isteğinde hedef kelime boş gelir; yalnız kabulde hedef zorunludur.
  if (!f || f.length > 60) return list;
  if (accepted && (!t || t === f || t.length > 60)) return list;
  const existing = list.find((c) => c.from === f);
  if (!accepted) {
    // Hiç kabul edilmemiş bir kelimeye ret gelirse kayıt oluşturma; var olan
    // kaydın sayacı düşer ve 0'a inince öneri tamamen silinir.
    if (!existing) return list;
    const accepts = Math.max(0, existing.accepts - 1);
    const next = list
      .map((c) => (c.from === f ? { ...c, accepts, rejects: c.rejects + 1 } : c))
      .filter((c) => c.accepts > 0);
    return next;
  }
  const next = existing
    ? list.map((c) => (c.from === f && c.to === t ? { ...c, accepts: c.accepts + 1, lastAccepted: now } : c))
    : [...list, { from: f, to: t, accepts: 1, rejects: 0, lastAccepted: now }];
  // Aynı kelime için tek kayıt: farklı hedefe yapılan kabul eski hedefi ezer.
  const dedup = new Map<string, LearnedCorrection>();
  for (const c of next) {
    const cur = dedup.get(c.from);
    if (!cur || c.accepts >= cur.accepts) dedup.set(c.from, c);
  }
  return [...dedup.values()]
    .sort((a, b) => b.accepts - a.accepts || b.lastAccepted.localeCompare(a.lastAccepted))
    .slice(0, MAX_CORRECTIONS);
}

/** Otomatik uygulanacak (≥ AUTO_APPLY_AT kabul) eşleşmeler. */
export function autoApplyMap(list: LearnedCorrection[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of list) if (c.accepts >= AUTO_APPLY_AT) m.set(c.from, c.to);
  return m;
}

/**
 * Metne kurum sözlüğünü uygular. Tam kelime/ifade eşleşmesi (Türkçe harf
 * sınırlarıyla) — kök içinde değiştirme yapmaz ("kan" → "kanama" olmaz).
 */
export function applyLearned(text: string, list: LearnedCorrection[]): { text: string; applied: string[] } {
  const map = autoApplyMap(list);
  if (!map.size) return { text, applied: [] };
  const applied: string[] = [];
  const letters = "a-zçğıöşüâîûA-ZÇĞİÖŞÜÂÎÛ";
  let out = text;
  for (const [from, to] of map) {
    const re = new RegExp(`(?<![${letters}])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![${letters}])`, "gi");
    out = out.replace(re, () => { applied.push(`${from}→${to}`); return to; });
  }
  return { text: out, applied: [...new Set(applied)] };
}

// ───────────── Sesli komutlar ─────────────

export const VIEW_COMMANDS = [
  "ileri", "geri", "ilk kesit", "son kesit",
  "yakınlaştır", "uzaklaştır", "sığdır",
  "kontrast artır", "kontrast azalt", "ters çevir",
  "pencere daralt", "pencere genişlet", "menü", "kapat",
] as const;
export type ViewCommand = (typeof VIEW_COMMANDS)[number];

/** Metin yazımı/rapor komutları. */
export type ReportCommand = "temizle" | "yeniSatir" | "yeniParagraf" | "geri al" | "kaydet";

/** Tek bir dikte parçasının yorumu. */
export type DictationAction =
  | { kind: "text"; text: string; commands: DictationCommand[] }
  | { kind: "view"; command: ViewCommand }
  | { kind: "report"; command: ReportCommand };

const norm = (s: string) =>
  s.toLocaleLowerCase("tr-TR").replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();

/**
 * Bir konuşma parçasını yorumlar.
 *
 * Kural: parça **tamamen** bir komutsa komut sayılır; cümle içinde geçen
 * "ileri" gibi sözcükler metin olarak kalır (komut motoru metni yutmaz).
 */
export function interpretDictation(raw: string): DictationAction {
  const n = norm(raw);
  if (!n) return { kind: "text", text: "", commands: [] };

  // Rapor komutları
  if (n === "geri al" || n === "son işlemi geri al") return { kind: "report", command: "geri al" };
  if (n === "kaydet" || n === "raporu kaydet") return { kind: "report", command: "kaydet" };

  // Görüntüleme komutları (eşanlamlılar)
  const view: Array<[RegExp, ViewCommand]> = [
    [/^(sonraki|ileri|ilerle|sonraki kesit)$/, "ileri"],
    [/^(önceki|geri|geri git|önceki kesit)$/, "geri"],
    [/^(ilk kesit|başa dön|başa git)$/, "ilk kesit"],
    [/^(son kesit|sona git)$/, "son kesit"],
    [/^(yakınlaştır|zoom in|büyüt)$/, "yakınlaştır"],
    [/^(uzaklaştır|zoom out|küçült)$/, "uzaklaştır"],
    [/^(sığdır|ekrana sığdır|fit)$/, "sığdır"],
    [/^(kontrast artır|kontrastı artır)$/, "kontrast artır"],
    [/^(kontrast azalt|kontrastı azalt)$/, "kontrast azalt"],
    [/^(ters çevir|invert|negatif)$/, "ters çevir"],
    [/^(pencere daralt|dar pencere)$/, "pencere daralt"],
    [/^(pencere genişlet|geniş pencere)$/, "pencere genişlet"],
    [/^(menü|menüyü aç)$/, "menü"],
    [/^(kapat|menüyü kapat)$/, "kapat"],
  ];
  for (const [re, command] of view) if (re.test(n)) return { kind: "view", command };

  // "kesit 42" gibi sayısal hedefler `parseSliceJump` ile ayrıştırılır; burada
  // metin olarak akar ki çağıran hedefi bilemezse veri kaybı olmasın.
  const text = processDictation(raw);
  return { kind: "text", text: text.text, commands: text.commands };
}

/**
 * "kesit N" gibi sayısal hedefleri ayıklar. `interpretDictation`'dan ayrı
 * tutulur çünkü `ViewCommand` birleşimine sayı taşımak gerekmez; çağıran
 * `jumpSlice` uygular.
 */
export function parseSliceJump(raw: string): number | null {
  const n = norm(raw).replace(/^(kesit|kırk|kest)\s+/, "kesit ");
  const m = /^kesit (\d{1,4})(?:\s*(?:e|a|ye|ya|'?ye|'?ya))?$/.exec(n);
  if (m) return Number(m[1]);
  // Söylenen sayı sözcükleri: "kırk iki" → 42
  const digit = normalizeDictation(n.replace(/^kesit\s+/, "")).trim();
  return /^\d{1,4}$/.test(digit) ? Number(digit) : null;
}

// ───────────── Düzeltme önerisi (dikte → hekim metni) ─────────────

const TOKEN = /[A-Za-zÇĞİÖŞÜÂÎÛçğıöşüâîû]+/g;

/** Metni kelimelere ve aralara ayırır (noktalama korunur). */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * Dikte edilen metin ile hekimin düzelttiği metni karşılaştırıp **kelime
 * düzeltmeleri** önerir.
 *
 * Yöntem: baştan ve sondan ortak kelimeleri at; kalan ortada tek kelime
 * değişmişse (1↔1) bu bir düzeltmedir. Sayı ve çok kısa kelimeler önerilmez
 * (ölçü değişikliği sözlük işi değildir).
 */
export function suggestCorrections(before: string, after: string, limit = 5): { from: string; to: string }[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length || !b.length) return [];
  let p = 0;
  while (p < a.length && p < b.length && normKey(a[p]) === normKey(b[p])) p++;
  let sa = a.length - 1;
  let sb = b.length - 1;
  while (sa >= p && sb >= p && normKey(a[sa]) === normKey(b[sb])) { sa--; sb--; }
  const oldMid = a.slice(p, sa + 1);
  const newMid = b.slice(p, sb + 1);
  if (oldMid.length !== 1 || newMid.length !== 1) return [];
  const from = oldMid[0];
  const to = newMid[0];
  if (normKey(from) === normKey(to)) return [];
  if (from.length < 3 || to.length < 3) return [];
  // Rakam ve sayı sözcükleri sözlük işi değildir: ölçü/yıl değişikliği olabilir.
  const sayiSozcugu = /^(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|elli|altmış|yetmiş|seksen|doksan|yüz|bin)$/i;
  if (/\d/.test(from) || /\d/.test(to)) return [];
  if (sayiSozcugu.test(from) || sayiSozcugu.test(to)) return [];
  return [{ from: normKey(from), to: normKey(to) }].slice(0, limit);
}

/** Eşleşmeyen komut önerileri (arayüzde ipucu olarak gösterilir). */
export const COMMAND_HINTS = [
  "nokta", "virgül", "iki nokta üst üste", "yeni satır", "yeni paragraf", "temizle",
  "ileri", "geri", "ilk kesit", "son kesit", "kesit 42", "yakınlaştır", "uzaklaştır", "sığdır",
  "kontrast artır", "ters çevir", "pencere daralt", "geri al", "kaydet",
] as const;

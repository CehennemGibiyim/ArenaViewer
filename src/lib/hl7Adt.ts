/**
 * HL7 v2 ADT — hasta yönetimi (e-hl7-mwl / w-his).
 *
 * Kapsam ve gerekçe:
 *  - **A08 (Update patient)** ve **A31 (Update person)**: HBYS'te hasta adı/doğum
 *    tarihi düzeltildiğinde RIS'e yeni kayıt açılmaz, mevcut hasta güncellenir.
 *    ArenaViewer bunu uygulamazsa çalışma listesinde **eski yazım** kalır ve iki
 *    farklı hasta adı aynı MRK'de görünür (klinik kimlik karışması).
 *  - **A40 (Merge patient – identifier list)**: mükerrer kayıt birleştirmede
 *    "eski MRK → yeni MRK" eşlemesi gelir; eski MRK ile gelen çalışmalar yeni
 *    hastaya taşınmalıdır.
 *
 * Bu modül **saf**tır (soket/DB yok): plan üretir, uygulama katmanı (`studyRepo`)
 * planı uygular. Böylece "hangi çalışma taşınacak, hangi alan değişecek" kararı
 * test edilebilir kalır.
 */

import { unescape, type ParsedHl7 } from "./hl7";

export type AdtEvent = "A08" | "A31" | "A40" | "A39" | "A41" | "other";

/** A40/A39 gibi birleştirme olayları: eski → yeni kimlik. */
export interface AdtMerge {
  /** (0016) eski hasta kimliği listesi (MRK). */
  fromIds: string[];
  /** (0017) yeni hasta kimliği listesi. */
  toId: string;
  /** (0018) eski alternatif kimlik listesi (varsa). */
  fromAltIds: string[];
}

export interface AdtPatientUpdate {
  patientId: string;
  /** Boş string = alan gelmedi (mevcut değer korunur). */
  patientName: string;
  patientSex: string;
  patientBirthDate: string;
  /** Türkçe ad + doğum tarihi ile çelişki uyarıları (üretimde denetim kaydı). */
  warnings: string[];
}

export interface AdtPlan {
  ok: boolean;
  event: AdtEvent;
  /** Neden işlenmedi (ok=false ise). */
  reason: string;
  patient: AdtPatientUpdate | null;
  merge: AdtMerge | null;
}

/** PID alanı: `PID|1||MRK^^^ISSUER^MR||AD^SOYAD^...` biçiminden bileşen seçer. */
export function pidComponent(seg: { fields: string[] } | undefined, fieldIndex: number, componentIndex = 0): string {
  if (!seg) return "";
  const f = seg.fields[fieldIndex] ?? "";
  if (!f) return "";
  const comps = f.split("^");
  return unescape(comps[componentIndex] ?? "").trim();
}

/** `A08` gibi tetikleyiciyi olay türüne çevirir. */
export function adtEvent(msg: ParsedHl7 | null): AdtEvent {
  if (!msg) return "other";
  if (msg.type && !/^ADT\^/i.test(msg.type)) return "other";
  const t = (msg.trigger || "").toUpperCase();
  if (t === "A08") return "A08";
  if (t === "A31") return "A31";
  if (t === "A40") return "A40";
  if (t === "A39") return "A39";
  if (t === "A41") return "A41";
  return "other";
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/**
 * Ad + doğum tarihi tutarlılığı: HL7'de (PID-5) ad `SOYAD^AD` sırasındadır.
 * Türkçe klinik pratikte ters yazım sık görülür; burada **uyarı** üretilir,
 * veri sessizce "düzeltilmez" (yanlış otomatik düzeltme kimlik karışması yapar).
 */
export function patientWarnings(p: AdtPatientUpdate): string[] {
  const out: string[] = [];
  if (!p.patientId) out.push("PID-3 (hasta kimliği) boş");
  if (!p.patientName) out.push("PID-5 (ad) boş — mevcut ad korunur");
  const parts = p.patientName.split("^").filter(Boolean);
  if (parts.length === 1 && p.patientName) out.push("PID-5 tek bileşen: soyad/ad ayrımı yok");
  if (p.patientBirthDate && !/^\d{8}$/.test(p.patientBirthDate)) out.push(`PID-7 geçersiz tarih (${p.patientBirthDate})`);
  if (p.patientBirthDate && /^\d{8}$/.test(p.patientBirthDate)) {
    const y = Number(p.patientBirthDate.slice(0, 4));
    if (y < 1900 || y > new Date().getFullYear()) out.push(`PID-7 yıl aralık dışı (${y})`);
  }
  if (p.patientSex && !/^[MFOUT]$/i.test(p.patientSex)) out.push(`PID-8 beklenmeyen cinsiyet kodu (${p.patientSex})`);
  return out;
}

/**
 * A08/A31 yamasını üretir — **boş alan yazılmaz** (HL7'de alan gelmemesi
 * "değiştirme" demektir; boş yazmak hastanın adını siler). Ad, HL7 sırasından
 * (`SOYAD^AD`) ekran biçimine (`SOYAD AD`) çevrilir.
 */
export function patientPatch(p: AdtPatientUpdate): { patientName?: string; patientSex?: string } {
  const out: { patientName?: string; patientSex?: string } = {};
  const name = p.patientName.replace(/\^/g, " ").replace(/\s+/g, " ").trim();
  if (name) out.patientName = name;
  const sex = p.patientSex.trim().toUpperCase();
  if (/^[MFOUT]$/.test(sex)) out.patientSex = sex; // geçersiz kod yazılmaz
  return out;
}

/** PID segmentinden hasta güncellemesi çıkarır (A08/A31). */
export function patientFromAdt(msg: ParsedHl7): AdtPatientUpdate | null {
  const pid = msg.segments.find((s) => s.name === "PID");
  if (!pid) return null;
  const id = pidComponent(pid, 3, 0) || pidComponent(pid, 2, 0);
  const family = pidComponent(pid, 5, 0);
  const given = pidComponent(pid, 5, 1);
  const middle = pidComponent(pid, 5, 2);
  const name = [family, given, middle].filter(Boolean).join("^");
  const p: AdtPatientUpdate = {
    patientId: id,
    patientName: name,
    patientSex: pidComponent(pid, 8, 0),
    patientBirthDate: pidComponent(pid, 7, 0).replace(/-/g, ""),
    warnings: [],
  };
  p.warnings = patientWarnings(p);
  return p;
}

/**
 * A40 birleştirme: MRG segmenti.
 *
 * HL7 v2 MRG alanları: MRG-1 = eski hasta kimliği (tekrarlı), MRG-2 = eski
 * alternatif kimlik, MRG-3 = **önceki hasta hesap numarası** (prior patient
 * account number — *kimlik değildir*, birleştirmede hedef olarak kullanılamaz).
 * Hedef (yeni) kimlik her zaman **PID-3**'tür. MRG-3 gelirse yalnızca bilgi
 * olarak raporlanır; kimlik yerine konması yanlış hastaya taşımaya yol açar.
 */
export function mergeFromAdt(msg: ParsedHl7): { merge: AdtMerge | null; warnings: string[] } {
  const mrg = msg.segments.find((s) => s.name === "MRG");
  const warnings: string[] = [];
  if (!mrg) return { merge: null, warnings: ["MRG segmenti yok — birleştirme uygulanamaz"] };
  const fromIds = (mrg.fields[1] ?? "")
    .split("~")
    .map((x) => unescape(x.split("^")[0] ?? "").trim())
    .filter(Boolean);
  const fromAltIds = (mrg.fields[2] ?? "")
    .split("~")
    .map((x) => unescape(x.split("^")[0] ?? "").trim())
    .filter(Boolean);
  const pid = msg.segments.find((s) => s.name === "PID");
  const pidId = pidComponent(pid, 3, 0);
  // Hedef kimlik yalnız PID-3'tür. MRG-3 hesap numarasıdır; kimlik sanılırsa
  // çalışmalar yanlış hastaya taşınır → bilgi olarak raporlanır, kullanılmaz.
  const toId = pidId;
  const priorAccount = (mrg.fields[3] ?? "").trim();
  if (priorAccount) warnings.push(`MRG-3 hesap numarası (${priorAccount}) bilgi amaçlı — hedef PID-3 (${pidId || "yok"})`);
  if (!toId) warnings.push("Hedef kimlik yok (MRG-3/PID-3)");
  if (fromIds.length === 0) warnings.push("Kaynak kimlik yok (MRG-1)");
  if (fromIds.some((f) => norm(f) === norm(toId))) {
    warnings.push("Kaynak ve hedef kimlik aynı — birleştirme atlanmalı");
  }
  const merge: AdtMerge = { fromIds, toId, fromAltIds };
  return { merge, warnings };
}

/** ADT mesajından uygulanabilir plan üretir (DB'ye dokunmaz). */
export function adtPlan(msg: ParsedHl7): AdtPlan {
  const event = adtEvent(msg);
  if (event === "other") {
    return { ok: false, event, reason: `Desteklenmeyen ADT olayı (${msg.type || "?"})`, patient: null, merge: null };
  }
  if (event === "A08" || event === "A31") {
    const patient = patientFromAdt(msg);
    if (!patient) return { ok: false, event, reason: "PID segmenti yok", patient: null, merge: null };
    if (!patient.patientId) return { ok: false, event, reason: "PID-3 hasta kimliği yok", patient, merge: null };
    return { ok: true, event, reason: "", patient, merge: null };
  }
  // A40 / A39 / A41: birleştirme ailesi (A41 = A40'ın iptali → ters yön desteği)
  const { merge, warnings } = mergeFromAdt(msg);
  if (!merge) return { ok: false, event, reason: warnings[0] ?? "Birleştirme bilgisi yok", patient: null, merge: null };
  if (!merge.toId || merge.fromIds.length === 0) {
    return { ok: false, event, reason: warnings.join("; ") || "Eksik birleştirme alanları", patient: null, merge };
  }
  // Kaynak = hedef → birleştirme anlamsız ve tehlikeli (kayıt kendine taşınır).
  if (merge.fromIds.some((f) => norm(f) === norm(merge.toId))) {
    return { ok: false, event, reason: "Kaynak ve hedef kimlik aynı — birleştirme atlandı", patient: null, merge };
  }
  if (event === "A41") {
    // A41 = birleştirmenin geri alınması: yön tersine çevrilir (kaynak ↔ hedef).
    const back: AdtMerge = { fromIds: [merge.toId], toId: merge.fromIds[0], fromAltIds: [] };
    if (back.fromIds[0] === back.toId) return { ok: false, event, reason: "A41 geri alma aynı kimliğe işaret ediyor", patient: null, merge };
    return { ok: true, event, reason: "A41 geri alma: yön ters çevrildi", patient: null, merge: back };
  }
  return { ok: true, event, reason: warnings.join("; "), patient: null, merge };
}

/**
 * Çoklu AET yönlendirme: gelen AE başlığına (Calling AE Title) göre hangi
 * PACS/öncelik kullanılacağını seçer.
 *
 * Gerekçe: kurumda tek PACS, tek AET varsayımı çok modality/AET ortamında
 * yanlış hedefe gönderim yapar (ör. mamografi cihazının görüntüsü toraks
 * arşivine gider). Eşleme **açık** tanımlanır; eşleşme yoksa varsayılan kullanılır
 * ve bu durum görünür (`matched:false`).
 */
export interface AetRoute {
  /** Çağıran AE başlığı (büyük/küçük harf duyarsız, tam eşleşme). */
  aet: string;
  /** Bu AE için kullanılacak PACS kökü (boş = varsayılan). */
  pacsUrl?: string;
  /** Bu AE için zorunlu modality kısıtı (boş = kısıt yok). */
  modality?: string;
  /** Açıklama (yönetim ekranında görünür). */
  note?: string;
}

export interface AetRouteResult {
  matched: boolean;
  route: AetRoute | null;
  /** Hangi kural eşleşti (tanılama) */
  reason: string;
}

/** `AET1=url1,MOD;AET2=url2` biçimindeki kısa tanımı ayrıştırır. */
export function parseAetRoutes(raw: string | undefined): AetRoute[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((entry) => entry.includes("=")) // "bozuk" gibi tanımlar kural sayılmaz
    .map((entry) => {
      const [aet, rest = ""] = entry.split("=");
      const [url = "", modality = ""] = rest.split(",");
      return {
        aet: aet.trim().toUpperCase(),
        pacsUrl: url.trim() || undefined,
        modality: modality.trim().toUpperCase() || undefined,
        note: entry.trim(),
      };
    })
    // AE başlığı ya da PACS kökü olmayan giriş işe yaramaz: sessizce yutmak yerine atla.
    .filter((r) => r.aet.length > 0 && (!!r.pacsUrl || !!r.modality));
}

/**
 * Gelen AE başlığı + modality için yönlendirme seçer.
 * Sıra: (1) AE + modality tam eşleşme, (2) yalnız AE eşleşmesi, (3) varsayılan.
 */
export function routeAet(callingAet: string | undefined, modality: string | undefined, routes: AetRoute[]): AetRouteResult {
  const aet = (callingAet ?? "").trim().toUpperCase();
  const mod = (modality ?? "").trim().toUpperCase();
  if (!aet) return { matched: false, route: null, reason: "Çağıran AE başlığı yok — varsayılan PACS kullanılır" };
  const exact = routes.find((r) => r.aet === aet && !!r.modality && r.modality === mod);
  if (exact) return { matched: true, route: exact, reason: `AE+modality eşleşti (${aet}/${mod})` };
  const byAet = routes.find((r) => r.aet === aet && !r.modality);
  if (byAet) return { matched: true, route: byAet, reason: `AE eşleşti (${aet})` };
  const modOnly = routes.find((r) => r.aet === "*" && !!r.modality && r.modality === mod);
  if (modOnly) return { matched: true, route: modOnly, reason: `modality eşleşti (*/${mod})` };
  return { matched: false, route: null, reason: `AE ${aet} için kural yok — varsayılan PACS kullanılır` };
}

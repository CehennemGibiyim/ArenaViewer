/**
 * Kıyaslama tablosunun **kaynak kayıt defteri**.
 *
 * Kural (sahte veri yok):
 *  - Dış iddia (piyasa/rakip) mutlaka bir kaynağa bağlanır: üretici sitesi,
 *    dokümantasyon, standart ya da ikincil analiz. Kaynak doğrudan erişilerek
 *    doğrulandıysa `checkedAt` dolu ve `checkMethod: "get"` olur; yalnız arama
 *    sonucuyla görüldüyse `"search"`; hiç doğrulanamadıysa `checkedAt: null`
 *    ve `note` alanında açık uyarı bulunur — tabloda ⚠ ile görünür.
 *  - İç iddia (bizde ne var) depodaki dosya yollarına bağlanır; `gapCodePaths`
 *    ile çıkarılan yolların gerçekten var olduğu `tests/gap-sources.test.ts`
 *    içinde dosya sisteminden doğrulanır.
 *  - Rakip/ürün adları `PRODUCT_SOURCES` üzerinden kaynağa eşlenir; kaynağı
 *    olmayan bir ürün adı tabloda yer alamaz (test bunu zorunlu kılar).
 */

export type SourceKind = "uretici" | "dokumantasyon" | "standart" | "ikincil" | "kod";

import { COMPETITOR_SITES } from "./gapAnalysis";

export interface GapSource {
  key: string;
  label: string;
  kind: SourceKind;
  /** Dış kaynak adresi (https). Doğrulanamayan kayıtlarda boş bırakılır. */
  url?: string;
  publisher?: string;
  /** Bu kaynağın desteklediği iddia (kısa, tabloda gösterilir). */
  basis: string;
  /** Doğrulandığı tarih (ISO) — doğrulanmadıysa null. */
  checkedAt: string | null;
  checkMethod: "get" | "search" | "repo" | "yok";
  /** Doğrulanamayan/koşullu kayıtlar için zorunlu açıklama. */
  note?: string;
  /** Depo içi kayıt (kind "kod") için dosya yolu. */
  path?: string;
}

/** Kaynak kayıtlarının son gözden geçirildiği tarih. */
export const SOURCES_UPDATED = "2026-11-26";

const s = (src: GapSource): GapSource => src;

export const GAP_SOURCES: Record<string, GapSource> = {
  radiant: s({
    key: "radiant", label: "RadiAnt DICOM Viewer", kind: "uretici", publisher: "Medixant",
    url: "https://www.radiantviewer.com/", basis: "Masaüstü PACS görüntüleyici; sürüm notları ve DICOM format desteği",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  weasis: s({
    key: "weasis", label: "Weasis", kind: "uretici", publisher: "Weasis Team",
    url: "https://weasis.org/", basis: "Açık kaynak web/masaüstü görüntüleyici dokümantasyonu (CC BY-SA 4.0)",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  ohif: s({
    key: "ohif", label: "OHIF Viewer", kind: "dokumantasyon", publisher: "Open Health Imaging Foundation",
    url: "https://docs.ohif.org/", basis: "DICOMweb tabanlı görüntüleyici; MPR, ölçüm izleme, uzantı mimarisi",
    checkedAt: "2026-11-25", checkMethod: "search",
  }),
  slicer: s({
    key: "slicer", label: "3D Slicer", kind: "dokumantasyon", publisher: "Slicer Community",
    url: "https://slicer.readthedocs.io/", basis: "Segmentasyon, kayıt (registration), DICOM-SEG/RTSTRUCT modülleri",
    checkedAt: "2026-11-25", checkMethod: "search",
  }),
  horos: s({
    key: "horos", label: "Horos", kind: "uretici", publisher: "Horos Project",
    url: "https://github.com/horosproject/horos", basis: "LGPL-3.0 açık kaynak OsiriX türevi; son commit Şubat 2026",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "horosproject.org bu derlemede yanıt vermedi (HTTP 5xx); kaynak olarak canlı GitHub deposu kullanıldı.",
  }),
  meddream: s({
    key: "meddream", label: "MedDream", kind: "uretici", publisher: "MedDream",
    url: "https://meddream.com/products/meddream-dicom-viewer/", basis: "HTML5 sıfır kurulum web görüntüleyici; FDA/CE IIb beyanları üretici sayfasında",
    checkedAt: "2026-11-25", checkMethod: "search",
  }),
  microdicom: s({
    key: "microdicom", label: "MicroDicom", kind: "uretici", publisher: "MicroDicom",
    url: "https://www.microdicom.com/", basis: "Windows masaüstü DICOM görüntüleyici",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  osirix: s({
    key: "osirix", label: "OsiriX MD", kind: "uretici", publisher: "Pixmeo",
    url: "https://www.osirix-viewer.com/", basis: "macOS görüntüleyici; MD sürümü FDA/CE onaylı",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "Depoda kayıtlı eski adres (osirixviewer.com) yerine doğrulanan adres kullanılır.",
  }),
  aidoc: s({
    key: "aidoc", label: "Aidoc", kind: "uretici", publisher: "Aidoc",
    url: "https://www.aidoc.com/", basis: "Triyaj/tespit AI modülleri (ICH, PE, C-spine vb.) üretici beyanı",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  vizai: s({
    key: "vizai", label: "Viz.ai", kind: "uretici", publisher: "Viz.ai",
    url: "https://www.viz.ai/", basis: "İnme büyük damar oklüzyonu tespiti ve sevk iş akışı",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  lunit: s({
    key: "lunit", label: "Lunit INSIGHT", kind: "uretici", publisher: "Lunit",
    url: "https://www.lunit.io/en/ai-radiology-software/insight-mmg/", basis: "Mamografi/tomosentez AI ürün sayfası ve üretici performans beyanları",
    checkedAt: "2026-11-25", checkMethod: "search",
  }),
  annalise: s({
    key: "annalise", label: "Annalise.ai", kind: "uretici", publisher: "Harrison.ai",
    url: "https://annalise.ai/", basis: "Akciğer grafisi ve BT AI modül ailesi",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "annalise.ai robots/sitemap harrison.ai'ye yönleniyor (kurumsal çatı).",
  }),
  gleamer: s({
    key: "gleamer", label: "Gleamer", kind: "uretici", publisher: "Gleamer",
    url: "https://www.gleamer.ai/", basis: "Kemik/MSK radyografi AI (BoneView) üretici beyanı",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  radai: s({
    key: "radai", label: "Rad AI", kind: "uretici", publisher: "Rad AI",
    url: "https://www.radai.com/", basis: "Raporlama otomasyonu (Omni/Impressions) üretici beyanı",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "rad.ai ve www.radai.com ayrı alan adları; her ikisi de yanıt veriyor, kaynak olarak www.radai.com kullanıldı.",
  }),
  icad: s({
    key: "icad", label: "iCAD", kind: "uretici", publisher: "iCAD",
    url: "https://www.icadmed.com/", basis: "Mamografi meme yoğunluğu ve lezyon tespiti ürünleri",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  qure: s({
    key: "qure", label: "qure.ai", kind: "uretici", publisher: "Qure.ai",
    url: "https://www.qure.ai/", basis: "Akciğer grafisi/BT triyaj AI ürünleri",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  therapixel: s({
    key: "therapixel", label: "Therapixel", kind: "uretici", publisher: "Therapixel",
    url: "https://www.therapixel.com/", basis: "Mamografi AI (Mammo-CAD) üretici beyanı",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  hermes: s({
    key: "hermes", label: "Hermes Medical Solutions", kind: "uretici", publisher: "Hermes Medical Solutions",
    url: "https://www.hermesmedical.com/", basis: "Nükleer tıp/PET iş istasyonu ve kantifikasyon ürünleri",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  monai: s({
    key: "monai", label: "MONAI / MONAI Label", kind: "dokumantasyon", publisher: "Project MONAI",
    url: "https://monai.io/", basis: "Açık kaynak tıbbi görüntüleme AI çerçevesi; Label ile etkileşimli segmentasyon",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  acrRadpeer: s({
    key: "acrRadpeer", label: "ACR RADPEER", kind: "standart", publisher: "American College of Radiology",
    url: "https://www.acr.org/Clinical-Resources/RADPEER", basis: "İkinci okuma uyum puanlama ölçeği (1–3/1–4) ve uyuşmazlık sınıfları",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "Puan eşlemesi bu projede 3'lü basitleştirilmiş ölçektir; resmî 4'lü ölçek validasyonu yapılmamıştır.",
  }),
  dicomStandard: s({
    key: "dicomStandard", label: "DICOM Standard (NEMA)", kind: "standart", publisher: "NEMA",
    url: "https://www.dicomstandard.org/", basis: "DICOM servisleri (C-STORE/C-FIND/C-MOVE, WADO-RS, STOW-RS, SR, SEG, RTSTRUCT)",
    checkedAt: "2026-11-25", checkMethod: "get",
  }),
  powerscribe: s({
    key: "powerscribe", label: "Microsoft Nuance PowerScribe One", kind: "ikincil", publisher: "Microsoft (Nuance)",
    url: "https://www.dictationdaddy.com/blog/nuance-powerscribe", basis: "Konuşma tanıma tabanlı raporlama; RSNA RadReport şablon desteği (ikincil analiz)",
    checkedAt: "2026-11-25", checkMethod: "search",
    note: "Nuance 2022'de Microsoft'a geçti; üretici ürün sayfası bu derlemede doğrulanmadı, ikincil analizler kullanıldı.",
  }),
  peervue: s({
    key: "peervue", label: "Nuance PeerVue (ikinci okuma)", kind: "ikincil", publisher: "Microsoft (Nuance)",
    url: "https://radiological.ai/blog/who-owns-radiology-reporting-software", basis: "İkinci okuma/gözetim iş akışı ürün ailesi (ikincil pazar analizi)",
    checkedAt: "2026-11-25", checkMethod: "search",
    note: "Ürünün resmî sayfası bulunamadı; yalnız ikincil kaynakla anılıyor — ayrıntılı iddia kurulmadı.",
  }),
  fabric: s({
    key: "fabric", label: "Microsoft Fabric", kind: "uretici", publisher: "Microsoft",
    url: "https://www.microsoft.com/en-us/microsoft-fabric", basis: "Kurumsal veri platformu (raporlama analitiği entegrasyonu bağlamında)",
    checkedAt: null, checkMethod: "yok",
    note: "Adres bu derlemede erişilerek doğrulanmadı; tabloda ⚠ ile işaretlenir.",
  }),
  radpal: s({
    key: "radpal", label: "RadPal", kind: "uretici", publisher: "RadPal",
    url: "https://www.radpal.ai/", basis: "AI destekli radyoloji raporlama ürün sitesi",
    checkedAt: "2026-11-25", checkMethod: "get",
    note: "Ürünün ayrıntılı özellik iddiaları doğrulanmadı; yalnız ürün kategorisi için kaynak.",
  }),
  keros: s({
    key: "keros", label: "Incepto KEROS", kind: "uretici", publisher: "Incepto Medical",
    url: "https://www.incepto-medical.com/", basis: "Diz MR AI (meniskal yırtık + lezyon tespiti dahil); CE MDR; üretici performans ve düzenleme beyanları",
    checkedAt: "2026-11-26", checkMethod: "search",
    note: "Klinik kanıt (dış geçerleme; artroskopi bağıntılı çalışma) Physica Medica 2021 ve International Orthopaedics 2025'te yayımlandı; adres bu derlemede yalnız arama sonucuyla görüldü — ücret/entegrasyon koşulları üreticiyle görüşülmeden doğrulanamaz.",
  }),
  marketGeneral: s({
    key: "marketGeneral", label: "Genel pazar ifadesi", kind: "ikincil",
    basis: "Tek bir ürüne bağlanmayan toplulaştırılmış ifade (\"tüm kurumsal ürünler\" vb.)",
    checkedAt: null, checkMethod: "yok",
    note: "Toplulaştırılmış ifadeler tek tek ürün kaynağına bağlanamaz; satır bazında iddia üretilmez.",
  }),
};

/** Pazarda geçen ürün adı → kaynak anahtarı. Kaynağı olmayan ürün kabul edilmez. */
export const PRODUCT_SOURCES: Record<string, string> = {
  RadiAnt: "radiant",
  Weasis: "weasis",
  OHIF: "ohif",
  "3D Slicer": "slicer",
  Horos: "horos",
  MedDream: "meddream",
  MicroDicom: "microdicom",
  OsiriX: "osirix",
  Aidoc: "aidoc",
  "Viz.ai": "vizai",
  Lunit: "lunit",
  Annalise: "annalise",
  Gleamer: "gleamer",
  "Rad AI": "radai",
  iCAD: "icad",
  "qure.ai": "qure",
  Therapixel: "therapixel",
  Hermes: "hermes",
  MONAI: "monai",
  "MONAI Label": "monai",
  PowerScribe: "powerscribe",
  Nuance: "powerscribe",
  PeerVue: "peervue",
  "RADPEER (ACR)": "acrRadpeer",
  RadPeer: "acrRadpeer",
  "Microsoft Fabric": "fabric",
  RadPal: "radpal",
  "Tüm kurumsal ürünler": "marketGeneral",
  "Tüm üreticiler": "marketGeneral",
  "Incepto (KEROS)": "keros",
  "Kurumsal standart": "dicomStandard",
};

/** Depo içi dosya yolu çıkarımı: yalnız uzantılı, gerçek görünen yollar. */
const CODE_PATH_RE =
  /\b((?:src|tests|scripts|ai-worker|docs|public|packaging|windows)\/[A-Za-z0-9_@./-]+\.(?:ts|tsx|mjs|cjs|js|json|py|md|yml|yaml|sh|onnx|txt))\b/g;

export interface ItemSources {
  itemId: string;
  external: GapSource[];
  code: string[];
  /** Kaynağı olmayan ürün adları (testte hata, tabloda ⚠). */
  unmapped: string[];
}

/** Bir maddenin dış kaynakları + depo içi dosya referansları. */
export function itemSources(item: { id: string; market?: string[]; ours?: string; action?: string }): ItemSources {
  const external: GapSource[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const product of item.market ?? []) {
    const key = PRODUCT_SOURCES[product];
    const src = key ? GAP_SOURCES[key] : undefined;
    if (!src) { unmapped.push(product); continue; }
    if (!seen.has(src.key)) { seen.add(src.key); external.push(src); }
  }
  const text = `${item.ours ?? ""} ${item.action ?? ""}`;
  const code: string[] = [];
  for (const m of text.matchAll(CODE_PATH_RE)) {
    const p = m[1].replace(/[.,;:]+$/, "");
    if (!code.includes(p)) code.push(p);
  }
  return { itemId: item.id, external, code, unmapped };
}

/** Tüm tablo için kaynak özeti (panoda gösterilir). */
export function sourceSummary(items: readonly { id: string; market?: string[]; ours?: string; action?: string }[]) {
  let externalLinks = 0;
  let unverified = 0;
  let codeRefs = 0;
  const used = new Set<string>();
  const unmapped = new Set<string>();
  for (const it of items) {
    const r = itemSources(it);
    externalLinks += r.external.filter((x) => !!x.url).length;
    unverified += r.external.filter((x) => !x.checkedAt).length;
    codeRefs += r.code.length;
    r.external.forEach((x) => used.add(x.key));
    r.unmapped.forEach((p) => unmapped.add(p));
  }
  return {
    registrySize: Object.keys(GAP_SOURCES).length,
    usedSources: used.size,
    externalLinks,
    unverified,
    codeRefs,
    unmapped: [...unmapped],
    updatedAt: SOURCES_UPDATED,
  };
}

export interface CompetitorLink {
  url: string;
  /** true = üreticinin kendi sitesi; false = doğrulanmış ikincil kaynak. */
  official: boolean;
  label: string;
  checkedAt: string | null;
}

/**
 * Rakip kartındaki bağlantı: önce üreticinin resmî sitesi, yoksa kayıt
 * defterindeki doğrulanmış kaynak. Hiçbiri yoksa null (bağlantı gösterilmez).
 * Böylece ölü/uydurma adres gösterilmez.
 */
export function competitorLink(name: string): CompetitorLink | null {
  const official = COMPETITOR_SITES[name];
  const registry = GAP_SOURCES[PRODUCT_SOURCES[name] ?? ""];
  if (official) return { url: official, official: true, label: registry?.label ?? name, checkedAt: registry?.checkedAt ?? null };
  if (registry?.url) return { url: registry.url, official: registry.kind !== "ikincil", label: registry.label, checkedAt: registry.checkedAt };
  return null;
}

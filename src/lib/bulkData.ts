/**
 * DICOMweb **BulkDataURI** ve metadata-içi piksel erişimi — e-wado-frame.
 *
 * WADO-RS kare getirme (`wadoFrames`) zaten var. Eksik olan, DICOMweb'in
 * `metadata` yanıtında piksel verisinin yerine dönen **BulkDataURI**
 * (`{"BulkDataURI": "https://pacs/.../bulk/...", "vr": "OW"}`) yoluyla veri
 * çekmekti — OHIF'in varsayılan davranışı budur; bazı PACS'ler karelerini yalnız
 * bu yoldan sunar.
 *
 * Bu modül saf/test edilebilir: güvenlik kapısı (`resolveBulkUrl`), metadata
 * içinden bulk referanslarını toplama (`collectBulkUris`), çok parçalı yanıtı
 * ayırma, sıkıştırılmış aktarım tespiti ve istemci codec köprüsü kararı
 * (`transferSyntaxHint`).
 *
 * Güvenlik: bulk adresi PACS köküyle **aynı origin** olmalıdır ve farklı bir
 * host'a yönlendirme (SSRF) reddedilir. Sorgu parametreleri korunur.
 */

export interface BulkRef {
  /** DICOM JSON etiketi (ör. "7FE00010") */
  tag: string;
  /** Kare içi indeks (BulkDataURI'de #frame N varsa) */
  frame?: number;
  /** Sunucunun verdiği adres (göreli olabilir) */
  uri: string;
  vr: string;
}

const PIXEL_TAGS = new Set(["7FE00010", "7FE00008", "7FE00009"]);

/**
 * bulkdata adresini PACS köküne göre çözer.
 *  - Göreli adres (`/studies/.../bulk/...`) kökün origin'ine eklenir.
 *  - Mutlak adres yalnız kökle **aynı origin** ise kabul edilir.
 */
export function resolveBulkUrl(root: string, uri: string): { ok: true; url: string } | { ok: false; error: string } {
  const u = (uri ?? "").trim();
  if (!u) return { ok: false, error: "Boş bulk adresi." };
  let base: URL;
  try {
    base = new URL(root);
  } catch {
    return { ok: false, error: "PACS kökü geçersiz." };
  }
  let target: URL;
  try {
    target = new URL(u, base);
  } catch {
    return { ok: false, error: `Bulk adresi geçersiz: ${u.slice(0, 80)}` };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return { ok: false, error: "Bulk adresi http/https olmalı." };
  if (target.origin !== base.origin) {
    return { ok: false, error: `Bulk adresi PACS dışına çıkıyor (${target.origin}) — SSRF koruması gereği reddedildi.` };
  }
  return { ok: true, url: target.toString() };
}

/**
 * DICOM JSON metadata içindeki BulkDataURI referanslarını toplar.
 * `frame` bilgisi `#frame N` (1 tabanlı) parçasından ya da URL'deki
 * `frames/1,2` yolundan çıkarılır.
 */
export function collectBulkUris(metadata: unknown, opts: { pixelOnly?: boolean } = {}): BulkRef[] {
  const out: BulkRef[] = [];
  const walk = (v: unknown, parentTag: string) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, parentTag));
      return;
    }
    const o = v as Record<string, unknown>;
    const uri = typeof o.BulkDataURI === "string" ? o.BulkDataURI : typeof o.BulkDataUri === "string" ? (o.BulkDataUri as string) : "";
    if (uri) {
      const tag = (o.tag as string) || parentTag;
      if (opts.pixelOnly && !PIXEL_TAGS.has(tag)) return;
      out.push({ tag, uri, vr: String(o.vr ?? ""), frame: frameFromUri(uri) });
      return;
    }
    for (const [k, child] of Object.entries(o)) {
      walk(child, /^[0-9A-Fa-f]{8}$/.test(k) ? k.toUpperCase() : parentTag);
    }
  };
  walk(metadata, "");
  return out;
}

/** `...#frame 3` → 3; `frames/1,2,3` → 2 (istenen kare) */
export function frameFromUri(uri: string): number | undefined {
  const hash = /#frame\s*(\d+)/i.exec(uri);
  const single = /frames\/(\d+)$/.exec(uri);
  if (single) return Number(single[1]);
  const hashFrame = hash ? Number(hash[1]) : undefined;
  return hashFrame && hashFrame > 0 ? hashFrame : undefined;
}

/**
 * Aktarım sözdiziminden istemci tarafı codec ihtiyacını çıkarır.
 * Sıkıştırılmış (JPEG/JPEG 2000/RLE) kareler tarayıcıda doğrudan çözülemez;
 * bu durumda "codec köprüsü gerekir" dürüstçe raporlanır.
 */
export interface TransferHint {
  transferSyntaxUid: string;
  compressed: boolean;
  /** Tarayıcıda doğrudan çözülebilir mi (8-bit native/JPEG baseline) */
  browserDecodable: boolean;
  codec: string;
  note: string;
}

const SYNTAXES: Record<string, { compressed: boolean; decodable: boolean; codec: string; label: string }> = {
  "1.2.840.10008.1.2": { compressed: false, decodable: true, codec: "yok", label: "Implicit VR Little Endian" },
  "1.2.840.10008.1.2.1": { compressed: false, decodable: true, codec: "yok", label: "Explicit VR Little Endian" },
  "1.2.840.10008.1.2.2": { compressed: false, decodable: true, codec: "yok", label: "Explicit VR Big Endian" },
  "1.2.840.10008.1.2.4.50": { compressed: true, decodable: true, codec: "JPEG (tarayıcı)", label: "JPEG Baseline (8-bit)" },
  "1.2.840.10008.1.2.4.51": { compressed: true, decodable: true, codec: "JPEG (tarayıcı)", label: "JPEG Extended (12-bit)" },
  "1.2.840.10008.1.2.4.57": { compressed: true, decodable: true, codec: "JPEG-LS (tarayıcı)", label: "JPEG-LS Lossless" },
  "1.2.840.10008.1.2.4.70": { compressed: true, decodable: true, codec: "JPEG-LS (tarayıcı)", label: "JPEG-LS Lossless (SV1)" },
  "1.2.840.10008.1.2.4.80": { compressed: true, decodable: false, codec: "JPEG-LS köprüsü", label: "JPEG-LS Lossless" },
  "1.2.840.10008.1.2.4.90": { compressed: true, decodable: false, codec: "JPEG 2000 köprüsü", label: "JPEG 2000 Lossless" },
  "1.2.840.10008.1.2.4.91": { compressed: true, decodable: false, codec: "JPEG 2000 köprüsü", label: "JPEG 2000 Lossy" },
  "1.2.840.10008.1.2.5": { compressed: true, decodable: false, codec: "RLE çözücü", label: "RLE Lossless" },
};

export function transferSyntaxHint(uid: string | undefined): TransferHint {
  const u = (uid ?? "").trim();
  const hit = SYNTAXES[u];
  if (!hit) {
    return {
      transferSyntaxUid: u,
      compressed: false,
      browserDecodable: false,
      codec: "bilinmiyor",
      note: u ? `Aktarım sözdizimi tanınmadı (${u}); piksel çözümü denenmez.` : "Aktarım sözdizimi metadata'da yok.",
    };
  }
  return {
    transferSyntaxUid: u,
    compressed: hit.compressed,
    browserDecodable: hit.decodable,
    codec: hit.codec,
    note: hit.compressed
      ? hit.decodable
        ? `${hit.label}: tarayıcı çözebilir.`
        : `${hit.label}: tarayıcı çözemez — istemci codec köprüsü gerekir (sunucu tarafı dönüşüm).`
      : `${hit.label}: sıkıştırma yok.`,
  };
}

/** Kare verisinin beklenen boyutu (satır × sütun × örnek başına bayt). */
export function expectedFrameBytes(cols: number, rows: number, samples: number, bitsAllocated: number): number {
  const c = Math.max(0, Math.floor(cols)), r = Math.max(0, Math.floor(rows));
  const s = Math.max(1, Math.floor(samples || 1));
  // DICOM'da BitsAllocated=1 bit **paketlidir** (SEG/binary maskeler); diğer
  // durumlarda örnek başına bayt tam sayıya yuvarlanır (12-bit → 2 bayt).
  if (Math.floor(bitsAllocated) === 1) return Math.ceil((c * r * s) / 8);
  const bits = Math.max(8, Math.floor(bitsAllocated || 8));
  const bytesPerSample = Math.ceil(bits / 8);
  return c * r * s * bytesPerSample;
}

export interface FrameFetchPlan {
  /** İndirilecek bulk adresleri (sıralı, tekil) */
  urls: { url: string; frame?: number }[];
  /** Atlanan referanslar ve gerekçesi */
  skipped: { uri: string; reason: string }[];
  hint: TransferHint;
  /** Tümü aynı aktarım sözdiziminde mi */
  mixedSyntax: boolean;
  note: string;
}

/**
 * Metadata'dan kare indirme planı üretir: her bulk referansı güvenlik kapısından
 * geçirilir, çağıranın istediği kare numaraları süzülür, tekrarlar atılır.
 */
export function planFrameFetch(
  metadata: unknown,
  root: string,
  opts: { frames?: number[]; transferSyntaxUid?: string } = {},
): FrameFetchPlan {
  const refs = collectBulkUris(metadata, { pixelOnly: true });
  const want = opts.frames?.length ? new Set(opts.frames.filter((f) => Number.isInteger(f) && f > 0)) : null;
  const urls: { url: string; frame?: number }[] = [];
  const skipped: { uri: string; reason: string }[] = [];
  const seen = new Set<string>();
  const hints = new Set<string>();
  for (const r of refs) {
    if (want && r.frame !== undefined && !want.has(r.frame)) {
      skipped.push({ uri: r.uri, reason: `kare ${r.frame} istenmedi` });
      continue;
    }
    const res = resolveBulkUrl(root, r.uri);
    if (!res.ok) {
      skipped.push({ uri: r.uri, reason: res.error });
      continue;
    }
    if (seen.has(res.url)) continue;
    seen.add(res.url);
    urls.push({ url: res.url, frame: r.frame });
    if (r.vr) hints.add(r.vr);
  }
  const hint = transferSyntaxHint(opts.transferSyntaxUid);
  const mixed = hints.size > 1;
  return {
    urls,
    skipped,
    hint,
    mixedSyntax: mixed,
    note: urls.length === 0
      ? "Metadata'da kullanılabilir bulk piksel adresi yok (PACS kareleri yalnız WADO-RS frames ucundan sunuyor olabilir)."
      : `${urls.length} bulk adresi planlandı${skipped.length ? `, ${skipped.length} atlandı` : ""}. ${hint.note}`,
  };
}

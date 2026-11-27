/**
 * Yönetim → **Sistem sağlığı** ve **Yedekleme** sekmelerinin saf hesaplama katmanı.
 *
 * Neden ayrı dosya: bu mantık tarayıcıda (React) ve Node testlerinde aynı şekilde
 * çalışmalı. Sır değeri asla döndürülmez; yalnız \"tanımlı / tanımsız\" bilgisi ve
 * öneri metni üretilir. Sahte değer üretilmez: okunamayan metrik `null` olarak
 * işaretlenir, tahmin edilmez.
 */

// ───────────────────────── Ortam (env) denetimi ─────────────────────────

export type CheckLevel = "ok" | "uyari" | "kritik" | "bilgi";

export interface EnvCheck {
  id: string;
  label: string;
  level: CheckLevel;
  /** Kısa durum metni (değer değil, \"tanımlı\" gibi). */
  value: string;
  /** Ne yapmalı / neden önemli. */
  hint: string;
  /** Depoda karşılık gelen belge (varsa). */
  doc?: string;
}

/** Yönetim ekranının gördüğü ortam özeti (sunucuda `process.env`ten üretilir). */
export interface EnvSnapshot {
  authMode: string;
  requireTls: string;
  hstsMaxAge: string;
  keySource: string;
  keyCount: number;
  databaseUrl: boolean;
  llmConfigured: boolean;
  metricsToken: boolean;
  auditSiemUrl: boolean;
  auditSyslogHost: boolean;
  storage: string;
  nodeEnv: string;
  appVersion: string;
  ingestApiKey: boolean;
  hisApiKey: boolean;
  requireTotpRoles: string;
}

const yes = (v: boolean) => (v ? "tanımlı" : "tanımsız");

/**
 * Ortamı kural tabanlı değerlendirir. Hiçbir sır değeri okunmaz/yazılmaz.
 * `uyari` = çalışır ama üretimde açık; `kritik` = üretimde veri/kimlik riski.
 */
export function evaluateEnv(env: EnvSnapshot): EnvCheck[] {
  const prod = env.nodeEnv === "production";
  const authAccount = env.authMode.trim().toLowerCase() === "hesap";
  const tls = env.requireTls.trim().toLowerCase();
  const tlsOn = tls === "1" || tls === "true" || tls === "forward" || tls === "direct";
  const out: EnvCheck[] = [];

  out.push({
    id: "auth-mode",
    label: "Kimlik modu (AUTH_MODE)",
    level: authAccount ? "ok" : prod ? "kritik" : "uyari",
    value: authAccount ? "hesap (oturum zorunlu)" : `${env.authMode || "demo"} (kimlik sorulmaz)`,
    hint: authAccount
      ? "Her istek imzalı oturum çerezi ve etkin hesap ister; roller sunucuda denetlenir."
      : "Demo modunda erişimi olan herkes yönetici işlemi yapabilir. Üretimde AUTH_MODE=hesap verin.",
    doc: "docs/KURULUM_VE_KULLANIM.md",
  });

  out.push({
    id: "tls",
    label: "TLS zorunluluğu (REQUIRE_TLS)",
    level: tlsOn ? "ok" : prod ? "kritik" : "uyari",
    value: tlsOn ? `${tls} (HSTS ${env.hstsMaxAge || "varsayılan"} sn)` : "kapalı",
    hint: tlsOn
      ? "TLS'siz API istekleri 426 ile reddedilir; HSTS başlığı yazılır."
      : "Kurumda TLS sonlandırıp REQUIRE_TLS=1 verin; aksi hâlde oturum çerezi açık ağda taşınır.",
  });

  out.push({
    id: "key-source",
    label: "Şifreleme anahtarı kaynağı",
    level: env.keySource === "env" ? "ok" : prod ? "kritik" : "uyari",
    value: env.keySource === "env" ? `ortam değişkeni (${env.keyCount} anahtar)` : "sunucu dosyası (.data/enc.key)",
    hint: env.keySource === "env"
      ? "Anahtar halkası ortamdan okunuyor; rotasyon Yönetim → Güvenlik sekmesinden yapılır."
      : "Üretimde anahtarı KMS/gizli yönetimden DATA_ENCRYPTION_KEYS ile verin. Anahtar kaybolursa veri açılamaz.",
    doc: "docs/YEDEK_VE_DR.md",
  });

  out.push({
    id: "database",
    label: "Veritabanı (DATABASE_URL)",
    level: env.databaseUrl ? "ok" : "kritik",
    value: yes(env.databaseUrl),
    hint: env.databaseUrl
      ? "Çalışma listesi, rapor, denetim zinciri ve paylaşım bağlantıları kalıcı."
      : "DB olmadan yalnız tarayıcı içi görüntüleme çalışır; kalıcı özellikler kapalı.",
  });

  out.push({
    id: "storage",
    label: "Görüntü deposu",
    level: env.storage.startsWith("S3") ? "ok" : prod ? "uyari" : "bilgi",
    value: env.storage || "bilinmiyor",
    hint: env.storage.startsWith("S3")
      ? "Nesne depolama etkin: yedek manifesti bu depodan üretilir."
      : "Yerel disk. Çok örnekli/ölçekli kurulumda S3/MinIO adaptörü önerilir.",
    doc: "docs/YEDEK_VE_DR.md",
  });

  out.push({
    id: "metrics-token",
    label: "Metrik ucu koruması (METRICS_TOKEN)",
    level: env.metricsToken ? "ok" : "uyari",
    value: yes(env.metricsToken),
    hint: env.metricsToken
      ? "/api/metrics Bearer jetonu ister."
      : "/api/metrics kimlik sormaz (yalnız toplu sayımlar). Ağ güvenlik duvarıyla sınırlayın veya jeton tanımlayın.",
  });

  out.push({
    id: "audit-export",
    label: "Denetim dışa aktarımı (SIEM / syslog)",
    level: env.auditSiemUrl || env.auditSyslogHost ? "ok" : "uyari",
    value: [
      env.auditSiemUrl ? "imzalı HTTP (AUDIT_SIEM_URL)" : "",
      env.auditSyslogHost ? "UDP CEF (AUDIT_SYSLOG_HOST)" : "",
    ].filter(Boolean).join(" · ") || "yapılandırılmadı",
    hint: env.auditSiemUrl || env.auditSyslogHost
      ? "Olaylar kuyruğa yazılır ve hedefe iletilir; kuyruk durumu Denetim sekmesinde."
      : "Olaylar yalnız yerel zincirde. Kurumsal SIEM için AUDIT_SIEM_URL tanımlayın.",
    doc: "docs/YEDEK_VE_DR.md",
  });

  out.push({
    id: "llm",
    label: "Üretken AI (taslak izlenim)",
    level: env.llmConfigured ? "ok" : "bilgi",
    value: yes(env.llmConfigured),
    hint: env.llmConfigured
      ? "Yalnız hekimin doğruladığı bulgu metni gönderilir; hasta kimliği gönderilmez."
      : "Tanımsızken kural tabanlı yedek çalışır (özellik kapanmaz).",
  });

  out.push({
    id: "ingest",
    label: "DICOM kabul anahtarı (INGEST_API_KEY)",
    level: env.ingestApiKey ? "ok" : "uyari",
    value: yes(env.ingestApiKey),
    hint: env.ingestApiKey
      ? "Modalite/geçit STOW-RS ile görüntü gönderebilir (x-api-key)."
      : "Canlı XA/US akışı ve STOW-RS kabulü kapalı.",
  });

  out.push({
    id: "his",
    label: "HBYS/RIS istem alımı (HIS_API_KEY)",
    level: env.hisApiKey ? "ok" : "bilgi",
    value: yes(env.hisApiKey),
    hint: env.hisApiKey ? "POST /api/his/orders açık." : "Kurum entegrasyonu açılınca tanımlanır.",
  });

  out.push({
    id: "totp",
    label: "MFA zorunluluğu (REQUIRE_TOTP_FOR_ROLES)",
    level: env.requireTotpRoles.includes("yonetici") ? "ok" : "uyari",
    value: env.requireTotpRoles || "tanımsız",
    hint: "Yönetici rolü için TOTP zorunlu olmalı; aksi hâlde hesap çalınmasında yetki devralınır.",
  });

  out.push({
    id: "version",
    label: "Sürüm / derleme",
    level: "bilgi",
    value: `${env.appVersion}${prod ? " · production" : ` · ${env.nodeEnv || "development"}`}`,
    hint: "Sürüm üç yerde aynı olmalı: src/lib/version.ts, package.json, git etiketi.",
  });

  return out;
}

export function summarizeChecks(checks: readonly EnvCheck[]) {
  const counts = { ok: 0, uyari: 0, kritik: 0, bilgi: 0 };
  for (const c of checks) counts[c.level]++;
  return { ...counts, total: checks.length };
}

// ───────────────────────── Prometheus metni (görüntüleme) ─────────────────────────

export interface ParsedMetricPoint { labels: Record<string, string>; value: number }
export interface ParsedMetric { name: string; help: string; type: string; points: ParsedMetricPoint[] }

/** `key="value"` çiftlerini ayırır (kaçışları çözer). */
function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/**
 * Prometheus metin formatını (0.0.4) ayrıştırır. Bozuk satır atlanır — ekran
 * metrik ucu bozulduğunda çökmemeli. Aynı ad+etiket tekrarında son değer geçerlidir.
 */
export function parsePrometheus(text: string): ParsedMetric[] {
  const byName = new Map<string, ParsedMetric>();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      const help = /^#\s*HELP\s+(\S+)\s+(.*)$/.exec(t);
      if (help) {
        const cur = byName.get(help[1]) ?? { name: help[1], help: "", type: "gauge", points: [] };
        cur.help = help[2];
        byName.set(help[1], cur);
      }
      const type = /^#\s*TYPE\s+(\S+)\s+(\S+)$/.exec(t);
      if (type) {
        const cur = byName.get(type[1]) ?? { name: type[1], help: "", type: type[2], points: [] };
        cur.type = type[2];
        byName.set(type[1], cur);
      }
      continue;
    }
    // ad{etiketler} değer [zaman]
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[^}]|\\.)*\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|NaN|[+-]Inf)\s*(?:\d+)?$/.exec(t);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value) && m[3] !== "NaN") continue;
    const cur = byName.get(m[1]) ?? { name: m[1], help: "", type: "gauge", points: [] };
    cur.points.push({ labels: m[2] ? parseLabels(m[2]) : {}, value });
    byName.set(m[1], cur);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ekranda gösterilecek kısa değer: 1234 → "1.234", büyük sayılar kısaltılır. */
export function formatMetricValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return v.toLocaleString("tr-TR");
  return v.toLocaleString("tr-TR", { maximumFractionDigits: 3 });
}

// ───────────────────────── Yedek manifesti görünümü ─────────────────────────

export interface BackupManifestLike {
  createdAt: string;
  appVersion: string;
  source: string;
  totalBytes: number;
  entries: { key: string; size: number; sha256: string; shaScope: "plain" | "cipher" }[];
}

export interface VerifyLike { ok: boolean; checked: number; errors: string[]; warnings: string[] }

/** İnsan okunur boyut (bytes). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Yedeğin yaşı. DR tatbikatı için kritik: 7 günden eski yedek uyarı, 30 günden
 * eski yedek \"yok sayılır\" (kritik). Saat dilimi farkı yaşı etkilemesin diye UTC.
 */
export function backupAge(createdAt: string, now = new Date()) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return { days: null as number | null, level: "bilgi" as CheckLevel, text: "tarih okunamadı" };
  const ms = Math.max(0, now.getTime() - t);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000);
  const text = days >= 1 ? `${days} gün önce` : hours >= 1 ? `${hours} saat önce` : "az önce";
  const level: CheckLevel = days > 30 ? "kritik" : days > 7 ? "uyari" : "ok";
  return { days, level, text };
}

/**
 * Doğrulama sonucunu tek satırlık duruma çevirir. `verify` yoksa \"doğrulanmadı\"
 * denir — varsayılmaz (dürüstlük kuralı).
 */
export function backupState(m: BackupManifestLike, verify?: VerifyLike | null) {
  const missing = verify ? verify.errors.filter((e) => e.startsWith("Eksik")).length : null;
  return {
    files: m.entries.length,
    bytes: formatBytes(m.totalBytes),
    cipherOnly: m.entries.filter((e) => e.shaScope === "cipher").length,
    verified: !!verify,
    verifyOk: verify ? verify.ok : null,
    missing,
    label: !verify
      ? "doğrulanmadı"
      : verify.ok
        ? missing ? `sağlam · ${missing} eksik` : "sağlam"
        : "HATALI",
    level: (!verify ? "bilgi" : verify.ok ? "ok" : "kritik") as CheckLevel,
  };
}

// ───────────────────────── Paylaşım bağlantısı görünümü ─────────────────────────

/** Token asla tam gösterilmez; ilk 8 karakter yeterlidir (denetim kaydıyla aynı). */
export function maskShareToken(token: string): string {
  const t = String(token ?? "");
  if (t.length <= 10) return t ? "…" : "";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/** Paylaşım bağlantısı için kalan süre metni ve düzey. */
export function shareRemaining(expiresAt: string | Date, revokedAt: string | Date | null, now = new Date()) {
  if (revokedAt) return { text: "kapatıldı", level: "bilgi" as CheckLevel, hours: null as number | null };
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return { text: "tarih okunamadı", level: "bilgi" as CheckLevel, hours: null };
  if (ms <= 0) return { text: "süresi doldu", level: "bilgi" as CheckLevel, hours: 0 };
  const hours = Math.round(ms / 3_600_000);
  const text = hours >= 48 ? `${Math.floor(hours / 24)} gün kaldı` : hours >= 1 ? `${hours} saat kaldı` : "1 saatten az";
  return { text, level: (hours < 24 ? "uyari" : "ok") as CheckLevel, hours };
}

/** Gölge mod özet satırlarını panelde gösterilecek biçime çevirir (boş → sıfır). */
export function shadowRows(rows: readonly { engine: string; model: string; count: number; findings: number; lastAt: string | null }[]) {
  const totalRecords = rows.reduce((n, r) => n + r.count, 0);
  const totalFindings = rows.reduce((n, r) => n + r.findings, 0);
  const last = rows.reduce<string | null>((acc, r) => (!r.lastAt ? acc : !acc || r.lastAt > acc ? r.lastAt : acc), null);
  return { rows, totalRecords, totalFindings, lastAt: last, empty: rows.length === 0 };
}

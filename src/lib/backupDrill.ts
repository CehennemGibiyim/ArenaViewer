/**
 * Yedekleme tatbikatının (DR drill) **saf** hesap katmanı.
 *
 * Amaç: yedek gerçekten geri yüklenebilir mi? Manifeste güvenmek yerine
 *  1. dosyaların özetlerini yeniden hesaplar (bütünlük),
 *  2. deponun listesiyle karşılaştırır (fazla/eksik dosya),
 *  3. isteğe bağlı **geri yükleme provası**: baytları verilen yazıcıya yazıp
 *     yeniden okuyup özeti doğrular.
 *
 * Girdi/çıktı yalnız veridir; dosya sistemi, DB ve HTTP çağrısı çağıranındır
 * (`/api/admin/backup?drill=1`). Böylece testler ağ ve disk olmadan koşar.
 */

export interface DrillEntry {
  key: string;
  sha256: string;
  size: number;
  /** Manifestte özetin hangi içeriğe ait olduğu: açık (`plain`) ya da şifreli (`cipher`). */
  shaScope: "plain" | "cipher";
}

export interface DrillManifest {
  createdAt: string;
  source: string;
  totalBytes: number;
  entries: DrillEntry[];
}

export interface DrillInput {
  manifest: DrillManifest;
  /** Depodaki anahtarlar (adaptör `list()` çıktısı). */
  storedKeys: string[];
  /** Depodan okunan dosya: **şifreli** baytlar; yoksa null. */
  read: (key: string) => Promise<Buffer | null>;
  /** Manifest özeti açık içerikten hesaplandıysa çözücü (isteğe bağlı). */
  decrypt?: (buf: Buffer) => Buffer;
  /** sha256 yardımcı (Node `crypto.createHash`); test enjeksiyonu için. */
  sha256: (buf: Buffer) => string;
  /** Geri yükleme provası: baytları yazıp yeniden okuyan yazıcı (isteğe bağlı). */
  restore?: (key: string, body: Buffer) => Promise<Buffer | null>;
}

export interface DrillFileResult {
  key: string;
  state: "saglam" | "ozet-uyusmuyor" | "eksik" | "cozulemedi" | "yazilamadi";
  expected: string;
  actual: string | null;
  size: number;
}

export interface DrillReport {
  ok: boolean;
  checked: number;
  healthy: number;
  /** Manifestte olmayan, depoda kalan dosyalar (silinmez; raporlanır). */
  extra: string[];
  results: DrillFileResult[];
  /** Geri yükleme provası yapıldı mı ve sonucu. */
  restoreTrial: { ran: boolean; ok: boolean; written: number; failed: number } | null;
  /** Tek satır özet — panelde ve denetim kaydında aynı metin. */
  summary: string;
  /** DR tatbikatı kararı için gerekçe listesi. */
  notes: string[];
}

/**
 * Yedek tatbikatını koşar. Hiçbir dosya **silinmez**; `restore` verildiğinde
 * yalnız yazma/geri okuma provası yapılır. Hata durumunda `ok=false` ve neden
 * `notes` içinde açıkça yazılır (sessiz başarı yok).
 */
export async function runDrill(input: DrillInput): Promise<DrillReport> {
  const results: DrillFileResult[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const e of input.manifest.entries) {
    seen.add(e.key);
    const enc = await input.read(e.key);
    if (!enc) {
      results.push({ key: e.key, state: "eksik", expected: e.sha256, actual: null, size: e.size });
      continue;
    }
    // Manifestteki özet açık içerikten; depodaki baytlar şifreli olabilir.
    let actual: string;
    if (e.shaScope === "cipher") {
      actual = input.sha256(enc);
    } else if (input.decrypt) {
      try {
        actual = input.sha256(input.decrypt(enc));
      } catch {
        results.push({ key: e.key, state: "cozulemedi", expected: e.sha256, actual: null, size: e.size });
        continue;
      }
    } else {
      // Çözücü verilmedi: şifreli baytları açık içerikle karşılaştırmak yanlış
      // olur. Doğrulanamayan dosya \"saglam\" sayılmaz.
      results.push({ key: e.key, state: "cozulemedi", expected: e.sha256, actual: null, size: e.size });
      notes.push(`${e.key}: açık içerik özeti doğrulanamadı (çözücü yok) — yedek anahtarını denetleyin.`);
      continue;
    }
    results.push({
      key: e.key,
      state: actual === e.sha256 ? "saglam" : "ozet-uyusmuyor",
      expected: e.sha256,
      actual,
      size: enc.length,
    });
  }

  const extra = input.storedKeys.filter((k) => !seen.has(k));

  let restoreTrial: DrillReport["restoreTrial"] = null;
  if (input.restore) {
    let written = 0;
    let failed = 0;
    for (const e of input.manifest.entries) {
      const enc = await input.read(e.key);
      if (!enc) { failed++; continue; }
      const back = await input.restore(e.key, enc).catch(() => null);
      if (!back) { failed++; continue; }
      const plain = (() => {
        if (e.shaScope === "cipher") return back;
        try { return input.decrypt ? input.decrypt(back) : null; } catch { return null; }
      })();
      if (!plain || input.sha256(plain) !== e.sha256) { failed++; continue; }
      written++;
    }
    restoreTrial = { ran: true, ok: failed === 0, written, failed };
  }

  const healthy = results.filter((r) => r.state === "saglam").length;
  const broken = results.filter((r) => r.state !== "saglam");
  const ok = broken.length === 0 && (!restoreTrial || restoreTrial.ok);

  if (extra.length) notes.push(`Depoda manifestte olmayan ${extra.length} dosya var (silinmedi; yeni dosyalar olabilir).`);
  if (broken.length) notes.push(`${broken.length} dosya doğrulanamadı — yedek tek başına geri yükleme için yeterli değil.`);
  if (!input.manifest.entries.length) notes.push("Manifest boş: depoda yedeklenecek dosya yok.");
  if (restoreTrial && !restoreTrial.ok) notes.push(`Geri yükleme provası ${restoreTrial.failed} dosyada başarısız.`);

  const summary = [
    `${results.length} dosya`,
    `${healthy} sağlam`,
    broken.length ? `${broken.length} hatalı` : "",
    extra.length ? `${extra.length} fazla` : "",
    restoreTrial ? `prova ${restoreTrial.ok ? "başarılı" : "BAŞARISIZ"}` : "prova yapılmadı",
  ].filter(Boolean).join(" · ");

  return { ok, checked: results.length, healthy, extra, results, restoreTrial, summary, notes };
}

/**
 * Yedeğin **kullanılabilirlik** eşiği: son yedek yaşı ve doğrulama durumuna göre
 * tek karar. Panelde \"yeşil/amber/kırmızı\" bandın tek kaynağı.
 */
export function drReadiness(opts: {
  lastBackupAt: string | null;
  lastVerifiedOk: boolean | null;
  now?: Date;
}): { level: "ok" | "uyari" | "kritik" | "bilgi"; text: string } {
  const now = opts.now ?? new Date();
  if (!opts.lastBackupAt) {
    return { level: "kritik", text: "Hiç doğrulanmış yedek yok — DR için hazır değil." };
  }
  const days = Math.floor(Math.max(0, now.getTime() - new Date(opts.lastBackupAt).getTime()) / 86_400_000);
  if (opts.lastVerifiedOk === false) return { level: "kritik", text: "Son yedek doğrulaması BAŞARISIZ — yeniden yedek alın." };
  if (days > 30) return { level: "kritik", text: `Son yedek ${days} gün önce — 30 gün sınırı aşıldı.` };
  if (days > 7) return { level: "uyari", text: `Son yedek ${days} gün önce — haftalık yedek hedefi aşıldı.` };
  return { level: "ok", text: `Son yedek ${days === 0 ? "bugün" : `${days} gün önce`}${opts.lastVerifiedOk ? " ve doğrulandı" : ""}.` };
}

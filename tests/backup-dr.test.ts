/**
 * g-backup-dr: depolama adaptörü + yedek/geri yükleme testleri.
 *
 * S3 imzası bilinen bir AWS SigV4 vektörüyle doğrulanır; S3 istemcisi ise
 * `fetch` enjeksiyonu ile sahte bir S3'e karşı sınanır (gerçek ağ yok).
 * Yedek manifesti/doğrulama/geri yükleme planı saf fonksiyonlar olarak test
 * edilir; ardından gerçek dosya sistemi adaptörü geçici klasörde çalıştırılır.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupFileName,
  createManifest,
  FsStorage,
  parseManifest,
  parseS3List,
  planRestore,
  safeKey,
  S3Storage,
  s3FromEnv,
  sigV4,
  stringifyManifest,
  summarizeBackup,
  verifyManifest,
} from "../src/lib/storageAdapter";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function main() {
  // ── 1) Anahtar güvenliği ───────────────────────────────────────────────
  assert.equal(safeKey("/dicom/1/a.bin"), "dicom/1/a.bin", "baştaki eğik çizgi atılır");
  assert.equal(safeKey("dicom\\1\\a.bin"), "dicom/1/a.bin", "ters eğik çizgi normalize edilir");
  assert.throws(() => safeKey("../etc/passwd"), /Geçersiz/, "yol kaçışı reddedilir");
  assert.throws(() => safeKey("a/../../b"), /Geçersiz/, "gizli kaçış reddedilir");
  assert.throws(() => safeKey(""), /Geçersiz/, "boş anahtar reddedilir");
  assert.throws(() => safeKey("a/".repeat(300)), /uzun/, "aşırı uzun anahtar reddedilir");
  console.log("PASS nesne anahtarı güvenliği (path traversal)");

  // ── 2) SigV4: AWS belgelerindeki vektör ────────────────────────────────
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  // "GET /test.txt" örneği (2013-05-24T00:00:00Z).
  const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
  url.searchParams.set("lifecycle", "");
  const signed = sigV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    amzDate: "20130524T000000Z",
  });
  assert.equal(signed["x-amz-date"], "20130524T000000Z", "tarih başlığı");
  assert.equal(signed.host, "examplebucket.s3.amazonaws.com", "host başlığı imzaya girer");
  assert.equal(signed["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "yük özeti");
  // AWS vektöründe Range başlığı ile imza: f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41
  assert.equal(
    /Signature=([a-f0-9]+)/.exec(signed.Authorization ?? "")?.[1],
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    "AWS SigV4 test vektörü eşleşir",
  );
  assert.match(signed.Authorization ?? "", /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/, "kimlik kapsamı");
  assert.match(signed.Authorization ?? "", /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/, "imzalanan başlıklar sıralı");
  console.log("PASS AWS SigV4 imzası (resmî test vektörü)");

  // ── 3) S3 XML listesi ──────────────────────────────────────────────────
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <Contents><Key>dicom/1/a%2Fb.bin</Key><Size>12</Size></Contents>
    <Contents><Key>dicom/2/c &amp; d.bin</Key><Size>34</Size></Contents>
    <CommonPrefixes><Prefix>dicom/3/</Prefix></CommonPrefixes>
  </ListBucketResult>`;
  assert.deepEqual(parseS3List(xml), [
    { key: "dicom/1/a%2Fb.bin", size: 12 },
    { key: "dicom/2/c & d.bin", size: 34 },
  ], "S3 listesi ayrıştırılır (XML kaçışları çözülür)");
  assert.deepEqual(parseS3List("<ListBucketResult/>"), [], "boş liste");
  console.log("PASS S3 list yanıtı ayrıştırma");

  // ── 4) S3 istemcisi: sahte uç noktaya karşı ────────────────────────────
  const store = new Map<string, Buffer>();
  const calls: { method: string; url: string; auth: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ method, url: u, auth: headers.get("authorization") ?? "" });
    const key = decodeURIComponent(new URL(u).pathname.replace(/^\/klinik\//, ""));
    if (method === "PUT") {
      store.set(key, Buffer.from(init.body as Uint8Array));
      return new Response("", { status: 200 });
    }
    if (method === "GET" && new URL(u).searchParams.get("list-type")) {
      const body = [...store.entries()].map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join("");
      return new Response(`<ListBucketResult>${body}</ListBucketResult>`, { status: 200 });
    }
    if (method === "GET") {
      const b = store.get(key);
      return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response("yok", { status: 404 });
    }
    if (method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("?", { status: 400 });
  }) as typeof fetch;

  const s3 = new S3Storage({
    endpoint: "http://minio.local:9000",
    bucket: "klinik",
    accessKeyId: "minio",
    secretAccessKey: "minio123",
    forcePathStyle: true,
    fetchImpl: fakeFetch,
  });
  assert.equal(s3.kind, "s3", "adaptör türü");
  assert.match(s3.describe(), /minio\.local:9000\/klinik/, "tanım sır içermez");
  assert.equal(s3.describe().includes("minio123"), false, "tanımda sır yok");
  await s3.put("dicom/7/a.bin", Buffer.from("ABC"));
  assert.equal(calls[0].method, "PUT", "PUT gönderildi");
  assert.equal(calls[0].url, "http://minio.local:9000/klinik/dicom/7/a.bin", "yol tarzı adresleme");
  assert.match(calls[0].auth, /^AWS4-HMAC-SHA256 Credential=minio\//, "istek imzalanır");
  assert.deepEqual(await s3.get("dicom/7/a.bin"), Buffer.from("ABC"), "PUT edilen nesne okunur");
  assert.equal(await s3.get("dicom/7/yok.bin"), null, "olmayan nesne null");
  const list = await s3.list("dicom/");
  assert.deepEqual(list, [{ key: "dicom/7/a.bin", size: 3 }], "liste doğru");
  await s3.delete("dicom/7/a.bin");
  assert.equal(await s3.get("dicom/7/a.bin"), null, "silme sonrası yok");
  await s3.delete("dicom/7/a.bin"); // yoksa sessiz
  await assert.rejects(() => s3.put("../kacis", Buffer.from("x")), /Geçersiz/, "adaptör de kaçışı engeller");
  // Hata yolları
  const hata = new S3Storage({
    endpoint: "http://minio.local:9000", bucket: "k", accessKeyId: "a", secretAccessKey: "b",
    fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
  });
  await assert.rejects(() => hata.put("x", Buffer.from("1")), /S3 PUT 500/, "PUT hatası bildirilir");
  await assert.rejects(() => hata.list(), /S3 LIST 500/, "LIST hatası bildirilir");
  console.log("PASS S3 istemcisi (PUT/GET/LIST/DELETE + hata yolları)");

  // ── 5) Ortamdan S3 yapılandırması ──────────────────────────────────────
  assert.equal(s3FromEnv({}), null, "eksik ortam → null");
  const env = s3FromEnv({
    S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(env?.forcePathStyle, true, "varsayılan yol tarzı (MinIO)");
  assert.equal(s3FromEnv({
    S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_VIRTUAL_HOST: "1",
  })?.forcePathStyle, false, "S3_VIRTUAL_HOST=1 → sanal host");
  console.log("PASS ortam yapılandırması");

  // ── 6) Yedek manifesti: oluştur/doğrula/serileştir ─────────────────────
  const a1 = Buffer.from("birinci dosya");
  const a2 = Buffer.from("ikinci dosya");
  const m = createManifest(
    [{ key: "dicom/2/b.bin", plaintext: a2 }, { key: "dicom/1/a.bin", plaintext: a1 }],
    { source: "fs:./.data", appVersion: "0.1.0", createdAt: "2026-01-15T10:00:00.000Z" },
  );
  assert.equal(m.format, "atikviewer-yedek", "biçim etiketi");
  assert.deepEqual(m.entries.map((e) => e.key), ["dicom/1/a.bin", "dicom/2/b.bin"], "girdiler sıralı (tekrarlanabilir)");
  assert.equal(m.totalBytes, a1.length + a2.length, "toplam bayt");
  assert.equal(m.entries[0].sha256, sha(a1), "özet açık içerikten");
  assert.equal(m.entries[0].encrypted, false, "açık dosya işareti");
  const encB = Buffer.from("sifreli-baytlar");
  const m2 = createManifest([{ key: "x/y.bin", encryptedBytes: encB }], { source: "s3:h/b", appVersion: "0.1.0" });
  assert.equal(m2.entries[0].encrypted, true, "depoda şifreli işareti");
  assert.equal(m2.entries[0].shaScope, "cipher", "özet şifreli baytlardan (çözülemez dosya)");
  assert.equal(m2.entries[0].sha256, sha(encB), "şifreli içerik özetlenir");
  assert.throws(() => createManifest([{ key: "bos" }], { source: "s", appVersion: "1" }), /Dosya içeriği yok/, "içeriksiz dosya reddedilir");
  console.log("PASS yedek manifesti oluşturma");

  // JSON tur-gidiş + bozuk yedek reddi
  const json = stringifyManifest(m);
  const back = parseManifest(json);
  assert.deepEqual(back.entries, m.entries, "manifest JSON tur-gidişi");
  assert.equal(back.totalBytes, m.totalBytes, "toplam bayt korunur");
  assert.throws(() => parseManifest("bozuk"), /JSON değil/, "bozuk JSON reddedilir");
  assert.throws(() => parseManifest('{"format":"baska"}'), /tanınmıyor/, "yanlış biçim reddedilir");
  assert.throws(() => parseManifest('{"format":"atikviewer-yedek","version":9,"entries":[]}'), /sürümü/, "sürüm denetlenir");
  assert.throws(
    () => parseManifest('{"format":"atikviewer-yedek","version":1,"entries":[{"key":"a","sha256":"kisa"}]}'),
    /kaydı geçersiz/,
    "geçersiz dosya kaydı reddedilir",
  );
  assert.throws(
    () => parseManifest('{"format":"atikviewer-yedek","version":1,"entries":[{"key":"../x","sha256":"' + "a".repeat(64) + '"}]}'),
    /Geçersiz/,
    "manifestteki yol kaçışı reddedilir",
  );
  console.log("PASS manifest doğrulama (bozuk/elle düzenlenmiş yedek)");

  // ── 7) Doğrulama: eksik/bozuk/uyuşan ──────────────────────────────────
  const good = await verifyManifest(m, async (k) => (k === "dicom/1/a.bin" ? a1 : k === "dicom/2/b.bin" ? a2 : null));
  assert.equal(good.ok, true, "sağlam yedek doğrulanır");
  assert.equal(good.checked, 2, "iki dosya denetlendi");
  const missing = await verifyManifest(m, async (k) => (k === "dicom/1/a.bin" ? a1 : null));
  assert.equal(missing.ok, false, "eksik dosya hatası");
  assert.ok(missing.errors.includes("Eksik dosya: dicom/2/b.bin"), "eksik dosya adı bildirilir");
  const corrupt = await verifyManifest(m, async () => Buffer.from("bozulmus"));
  assert.equal(corrupt.ok, false, "bozuk içerik hatası");
  assert.ok(corrupt.errors.some((e) => e.startsWith("Özet uyuşmuyor")), "özet uyuşmazlığı bildirilir");
  // Depoda şifreli duran bir dosya: özet AÇIK içerikten, doğrulama çözerek.
  const dec = (b: Buffer) => Buffer.from(b.toString().replace(/^ENC:/, ""));
  const encManifest = createManifest([{ key: "e/a.bin", plaintext: a1, storeEncrypted: true }], { source: "s", appVersion: "1" });
  assert.equal(encManifest.entries[0].encrypted, true, "depoda şifreli");
  assert.equal(encManifest.entries[0].shaScope, "plain", "özet açık içerikten (taşınabilir)");
  const encVerify = await verifyManifest(encManifest, async () => Buffer.from("ENC:" + a1.toString()), dec);
  assert.equal(encVerify.ok, true, "şifreli depo, açık özet ile doğrulanır");
  const noDecrypt = await verifyManifest(encManifest, async () => Buffer.from("ENC:" + a1.toString()));
  assert.ok(noDecrypt.errors.some((e) => /Şifre çözücü gerekli/.test(e)), "çözücü yoksa anlaşılır hata");
  const wrongDecrypt = await verifyManifest(encManifest, async () => a1, () => { throw new Error("anahtar yok"); });
  assert.ok(wrongDecrypt.errors.some((e) => /Şifre çözülemedi/.test(e)), "çözülemeyen dosya hata olarak bildirilir");
  const bozukYedek = await verifyManifest({ ...m, format: "baska" as typeof m.format }, async () => a1);
  assert.ok(bozukYedek.errors.some((e) => /biçimi tanınmıyor/.test(e)), "biçim hatası doğrulamada da yakalanır");
  console.log("PASS manifest doğrulama (eksik/bozuk/şifreli)");

  // ── 8) Geri yükleme planı ─────────────────────────────────────────────
  const plan = planRestore(m, [
    { key: "dicom/1/a.bin", sha256: sha(a1) },      // aynı → atla
    { key: "dicom/2/b.bin", sha256: "f".repeat(64) }, // farklı → yaz
    { key: "dicom/9/eski.bin", sha256: sha("eski") }, // fazla → dokunma
  ]);
  assert.deepEqual(plan.write, ["dicom/2/b.bin"], "değişen dosya yazılır");
  assert.deepEqual(plan.skip, ["dicom/1/a.bin"], "aynı dosya atlanır");
  assert.deepEqual(plan.extra, ["dicom/9/eski.bin"], "fazla dosya raporlanır, silinmez");
  const taze = planRestore(m, []);
  assert.equal(taze.write.length, 2, "boş hedefe hepsi yazılır");
  assert.equal(taze.extra.length, 0, "fazla dosya yok");
  console.log("PASS geri yükleme planı (idempotent, silme yok)");

  // ── 9) Dosya adı ve özet ──────────────────────────────────────────────
  const fn = backupFileName("0.1.0", new Date("2026-01-15T10:30:45Z"));
  assert.equal(fn, "yedek-0.1.0-20260115-103045.json", "dosya adı sıralanabilir");
  assert.match(backupFileName("v 1/2"), /^yedek-v_1_2-\d{8}-\d{6}\.json$/, "güvenli dosya adı (tehlikeli karakterler)")
  assert.match(summarizeBackup(m), /2 dosya \/ 0\.0 MB \(doğrulanmadı\)/, "özet (doğrulanmamış)");
  assert.match(summarizeBackup(m, good), /2 dosya .* 2 denetlendi .* 0 eksik .* sağlam/, "özet (sağlam)");
  assert.match(summarizeBackup(m, missing), /1 eksik .* HATALI/, "özet (eksik dosya)");
  console.log("PASS yedek adı ve özet");

  // ── 10) Dosya sistemi adaptörü (gerçek disk) ───────────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "av-store-"));
  try {
    const fsStore = new FsStorage(dir);
    await fsStore.put("dicom/1/a.bin", Buffer.from("AAA"));
    await fsStore.put("dicom/1/b.bin", Buffer.from("BB"));
    assert.deepEqual(await fsStore.get("dicom/1/a.bin"), Buffer.from("AAA"), "disk adaptörü okur");
    assert.equal(await fsStore.get("yok.bin"), null, "olmayan dosya null");
    assert.deepEqual((await fsStore.list()).map((o) => o.key), ["dicom/1/a.bin", "dicom/1/b.bin"], "liste sıralı");
    assert.deepEqual((await fsStore.list("dicom/1/b")).map((o) => o.key), ["dicom/1/b.bin"], "önek süzgeci");
    await fsStore.delete("dicom/1/b.bin");
    assert.equal(await fsStore.get("dicom/1/b.bin"), null, "silindi");
    await fsStore.delete("dicom/1/b.bin"); // tekrar silme sessiz
    await assert.rejects(() => fsStore.put("../kacis", Buffer.from("x")), /Geçersiz/, "disk adaptörü kaçışı engeller");
    assert.match(fsStore.describe(), /^fs:/, "tanım");
    // Atomik yazma: yarım dosya kalmaz
    assert.equal(fs.readdirSync(path.join(dir, "dicom", "1")).some((n) => n.includes(".tmp-")), false, "geçici dosya kalmaz");
    console.log("PASS dosya sistemi adaptörü (yaz/oku/listele/sil)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 11) Uç sözleşmesi ────────────────────────────────────────────────
  const root = path.join(__dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const backupRoute = read("src/app/api/admin/backup/route.ts");
  assert.ok(backupRoute.includes("createManifest") && backupRoute.includes("verifyManifest") && backupRoute.includes("planRestore"), "yedek ucu çekirdeği kullanır");
  assert.ok(backupRoute.includes("backup.manifest") && backupRoute.includes("backup.verify") && backupRoute.includes("backup.restore"), "tüm işlemler denetime yazılır");
  assert.ok(backupRoute.includes('authorize(req, ["yonetici"])'), "yedek ucu yönetici yetkisi ister");
  assert.ok(backupRoute.includes("Content-Disposition"), "manifest indirilebilir");
  const upload = read("src/app/api/storage/upload/route.ts");
  assert.ok(upload.includes("fileStorage().put"), "yükleme adaptörden geçer");
  assert.ok(!upload.includes("fs.writeFileSync"), "yükleme doğrudan diske yazmaz");
  const fileRoute = read("src/app/api/storage/file/[id]/route.ts");
  assert.ok(fileRoute.includes("fileStorage().get"), "indirme adaptörden geçer");
  const serverStorage = read("src/lib/server/storage.ts");
  assert.ok(serverStorage.includes("S3Storage") && serverStorage.includes("FsStorage"), "sunucu tarafı seçim iki arka ucu da tanır");
  assert.ok(serverStorage.includes("sealSecret"), "ayar sırrı şifrelenir");
  console.log("PASS uç sözleşmesi (adaptör + denetim + yetki)");

  console.log("Tüm g-backup-dr (depolama + yedek/DR) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

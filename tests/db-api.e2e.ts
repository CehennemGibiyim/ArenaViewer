/**
 * PostgreSQL'li uçtan uca API testi: ölçüm geçmişi, RADPEER ve model kayıt defteri.
 *
 * Neden ayrı: bu üç özellik gerçek şema + oturum/CSRF + HTTP sınırından geçer;
 * saf mantık testleri tabloların/varsayılanların doğru olduğunu kanıtlamaz.
 *
 * Gereksinim:
 *   1) Çalışan PostgreSQL ve uygulanmış şema:
 *        DATABASE_URL=postgres://atik@127.0.0.1:5432/atik npx drizzle-kit push --config=drizzle.config.ts
 *   2) Uygulama sunucusu (demo modu):
 *        DATABASE_URL=... AV_RATE_LIMIT=off npx next start -p 3200
 *   3) Çalıştır:
 *        DATABASE_URL=... BASE_URL=http://127.0.0.1:3200 npm run test:db-api
 *
 * Test kendi verisini "E2E." önekli hasta/çalışma ve `e2e.` model anahtarlarıyla
 * kurar ve başlamadan önce temizler; başka kayıtlara dokunmaz.
 */
import assert from "node:assert/strict";
import { Client } from "pg";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3200").replace(/\/$/, "");
const DB = process.env.DATABASE_URL ?? "postgres://atik@127.0.0.1:5432/atik";

let cookie = "";
let csrf = "";
let passed = 0;

function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
  console.log(`PASS ${msg}`);
}

async function boot() {
  const r = await fetch(`${BASE}/`, { redirect: "manual" });
  const setCookies = r.headers.getSetCookie?.() ?? [];
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const token = jar.get("av_csrf") ?? "";
  assert.ok(token, "ana sayfa av_csrf çerezi kurmalı");
  cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  csrf = token;
}

async function api(path: string, method = "GET", body?: unknown, withCsrf = true): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie };
  if (withCsrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

async function main() {
  await boot();
  const db = new Client({ connectionString: DB });
  await db.connect();

  // ── temizlik: yalnız E2E önekli veriler ──
  await db.query("delete from measurement_history where patient_id like 'E2E-%'");
  await db.query("delete from model_registry where model_key like 'e2e.%'");
  await db.query("delete from peer_reviews where report_id in (select id from reports where study_id in (select id from studies where study_uid like 'E2E.%'))");
  await db.query("delete from reports where study_id in (select id from studies where study_uid like 'E2E.%')");
  await db.query("delete from studies where study_uid like 'E2E.%'");

  const study = (await db.query(
    `insert into studies (study_uid, modality, body_part, series_description, patient_name, patient_id, study_date)
     values ('E2E.STUDY.1','CT','TORAKS','E2E toraks serisi','E2E^Hasta','E2E-PEER','2026-11-01') returning id`
  )).rows[0];
  const report = (await db.query(
    `insert into reports (study_id, status, created_by, content_hash, approved_at, approved_by, findings_text)
     values ($1,'onaylandi',2,'hash-e2e-peer', now(), 'Dr E2E Onay', 'E2E bulguları') returning id`,
    [study.id]
  )).rows[0];
  ok(Number(study.id) > 0 && Number(report.id) > 0, "DB: E2E çalışma + onaylı rapor kuruldu");

  // ═══════════ 1) ÖLÇÜM GEÇMİŞİ ═══════════
  const rows = [
    { patientId: "E2E-P1", studyUid: "E2E.STUDY.1", studyDate: "2026-11-01", seriesKey: "S1", modality: "CT", label: "Uzunluk · Nodül A", kind: "length", value: 25, unit: "mm", slice: 3 },
    { patientId: "E2E-P1", studyUid: "E2E.STUDY.1", studyDate: "2026-11-01", seriesKey: "S1", modality: "CT", label: "Elipsoid hacim · Nodül A", kind: "volume", value: 0.0785, unit: "mL", slice: 3 },
    { patientId: "E2E-P1", studyUid: "E2E.STUDY.1", studyDate: "2026-11-01", seriesKey: "S1", modality: "CT", label: "Ortalama HU · Nodül A", kind: "hu", value: 42.5, unit: "HU", slice: 3 },
  ];
  const csrfMissing = await api("/api/measurements", "POST", { rows }, false);
  ok(csrfMissing.status === 403, "CSRF jetonsuz POST 403 ile reddediliyor");

  const save1 = await api("/api/measurements", "POST", { rows });
  ok(save1.status === 200 && save1.json?.saved === 3, `ölçümler kaydedildi (saved=${save1.json?.saved})`);
  const dbRows1 = await db.query("select label, value, unit from measurement_history where patient_id='E2E-P1' order by label");
  ok(dbRows1.rowCount === 3, "DB: 3 ölçüm satırı gerçekten yazıldı");
  ok(Number(dbRows1.rows.find((r: any) => r.unit === "mL")?.value) === 0.0785, "DB: mL değeri hassasiyetle saklandı");

  const get1 = await api("/api/measurements?patientId=E2E-P1");
  ok(get1.status === 200 && get1.json.length === 3, "GET hasta bazlı ölçümleri döndürüyor");
  ok(get1.json[0].studyDate === "2026-11-01" && get1.json[0].unit !== undefined, "GET satırları alanlarıyla dönüyor");

  // aynı çalışma+seri yeniden kaydedilirse DEĞİŞTİRİR (kopya üretmez)
  const replace = await api("/api/measurements", "POST", { rows: [
    { ...rows[0], value: 27.5 },
    { ...rows[2], value: 45 },
  ] });
  ok(replace.status === 200 && replace.json?.saved === 2, "yeniden kayıt 2 satırla değiştiriyor");
  const dbRows2 = await db.query("select count(*)::int as n from measurement_history where patient_id='E2E-P1'");
  ok(dbRows2.rows[0].n === 2, "DB: kopya üretilmedi (2 satır kaldı)");
  const get2 = await api("/api/measurements?patientId=E2E-P1");
  ok(get2.json.find((r: any) => r.unit === "mm")?.value === 27.5, "DB: güncellenen değer okunuyor (25 → 27,5)");

  const badUnit = await api("/api/measurements", "POST", { rows: [{ ...rows[0], unit: "cm" }] });
  ok(badUnit.status === 400, "geçersiz birim 400 ile reddediliyor");
  const badValue = await api("/api/measurements", "POST", { rows: [{ ...rows[0], value: 0 }] });
  ok(badValue.status === 400, "sıfır/negatif değer reddediliyor");
  const noPatient = await api("/api/measurements?patientId=");
  ok(noPatient.status === 400, "patientId olmadan GET 400");

  // ═══════════ 2) RADPEER ═══════════
  const sampleBefore = await api("/api/peer-review/sample?rate=100");
  ok(sampleBefore.status === 200, "RADPEER örneklem ucu yanıt veriyor");
  const mine = sampleBefore.json.items.find((i: any) => i.reportId === Number(report.id));
  ok(!!mine, "onaylı rapor örnekleme girdi");
  ok(typeof mine.patientName === "string" && mine.patientName.startsWith("E2E"), "örneklem hasta bilgisiyle dönüyor");

  const preStats = await api("/api/peer-review/stats");
  const beforeKnown = preStats.json.known;
  const noNote = await api(`/api/reports/${report.id}/peer-reviews`, "POST", { result: "uyumsuz", discrepancyType: "yanlış yorum", note: "" });
  ok(noNote.status === 400, "uyumsuz değerlendirmede açıklama zorunlu (400)");
  const badType = await api(`/api/reports/${report.id}/peer-reviews`, "POST", { result: "uyumsuz", discrepancyType: "uydurma", note: "E2E notu" });
  ok(badType.status === 400, "geçersiz fark türü reddediliyor");

  const review = await api(`/api/reports/${report.id}/peer-reviews`, "POST", { result: "uyumsuz", discrepancyType: "yanlış yorum", note: "E2E: ikinci okuyucu farkı" });
  ok(review.status === 201 && review.json?.ok === true, "ikinci okuma kaydı oluşturuldu");
  ok(String(review.json?.advice ?? "").includes("addendum"), "uyumsuz için düzeltme/addendum önerisi dönüyor");

  const stats = await api("/api/peer-review/stats");
  ok(stats.status === 200 && stats.json.known === beforeKnown + 1, "istatistik yeni değerlendirmeyi sayıyor");
  ok(stats.json.uyumsuz >= 1 && stats.json.majorRate !== null, "uyumsuz ve büyük fark oranı hesaplanıyor");
  ok(stats.json.byScore.find((s: any) => s.score === 3).count >= 1, "RADPEER 3 (büyük fark) dağılımda görünüyor");
  ok(typeof stats.json.headline === "string" && stats.json.headline.includes("%95 GA"), "özet başlığı güven aralığını taşıyor");

  const sampleAfter = await api("/api/peer-review/sample?rate=100");
  const stillThere = sampleAfter.json.items.some((i: any) => i.reportId === Number(report.id));
  ok(!stillThere, "değerlendirilen rapor sonraki örneklemden çıkarıldı");

  // ═══════════ 3) MODEL KAYIT DEFTERİ ═══════════
  const reg = await api("/api/models", "POST", { modelKey: "e2e.nodule", version: "1.0.0", stage: "aktif", trafficPct: 100, artifactHash: "sha256:e2e", notes: "E2E kayıt" });
  ok(reg.status === 201 && reg.json?.model?.version === "1.0.0", "yeni model sürümü kaydedildi (201)");
  const shadow = await api("/api/models", "POST", { modelKey: "e2e.nodule", version: "1.1.0", stage: "gölge", trafficPct: 0, notes: "E2E gölge" });
  ok(shadow.status === 201, "gölge sürüm kaydedildi");
  const upd = await api("/api/models", "POST", { modelKey: "e2e.nodule", version: "1.0.0", stage: "aktif", trafficPct: 80, notes: "E2E trafik 80" });
  ok(upd.status === 200 && upd.json?.model?.trafficPct === 80, "mevcut sürüm güncellendi (200, trafik 80)");

  const invalidRetired = await api("/api/models", "POST", { modelKey: "e2e.nodule", version: "1.2.0", stage: "emekli", trafficPct: 20 });
  ok(invalidRetired.status === 400, "emekli sürüme trafik verilemez (400)");
  const invalidShadow = await api("/api/models", "POST", { modelKey: "e2e.nodule", version: "1.2.0", stage: "gölge", trafficPct: 10 });
  ok(invalidShadow.status === 400, "gölge sürüme trafik verilemez (400)");
  const invalidKey = await api("/api/models", "POST", { modelKey: "E2E BAD KEY", version: "1.0.0" });
  ok(invalidKey.status === 400, "geçersiz model anahtarı reddediliyor");

  const list = await api("/api/models");
  ok(list.status === 200 && list.json.models.filter((m: any) => m.modelKey === "e2e.nodule").length === 2, "kayıt defteri iki sürümü listeliyor");
  ok(list.json.summary.byStage.gölge >= 1 && list.json.summary.activeVersion !== null, "özet aşama sayıları ve aktif sürüm");

  const dup = await db.query("select count(*)::int as n from model_registry where model_key='e2e.nodule' and version='1.0.0'");
  ok(dup.rows[0].n === 1, "DB: aynı model+sürüm tek satır (upsert)");

  const auditRows = await db.query(
    "select action, count(*)::int as n from audit_logs where action like 'model_registry.%' or action = 'measurement-history-save' or action = 'report.peer_review' group by action"
  );
  const auditMap = Object.fromEntries(auditRows.rows.map((r: any) => [r.action, r.n]));
  ok((auditMap["model_registry.register"] ?? 0) >= 2, "denetim: model kayıtları audit_logs'a yazıldı");
  ok((auditMap["model_registry.update"] ?? 0) >= 1, "denetim: model güncellemesi önce/sonra ile yazıldı");
  ok((auditMap["measurement-history-save"] ?? 0) >= 1, "denetim: ölçüm geçmişi kaydı iz bıraktı");
  ok((auditMap["report.peer_review"] ?? 0) >= 1, "denetim: ikinci okuma iz bıraktı");

  // ═══════════ 5) OTURUM LİSTESİ + HESAP KİLİDİ (w-auth) ═══════════
  // Kurumsal giriş bu sunucuda yapılandırılmadı: istemciye bunun açıkça
  // bildirilmesi gerekir (giriş sayfası düğmeyi buna göre çizer).
  const loginInfo = await api("/api/auth/login");
  ok(loginInfo.status === 200 && loginInfo.json?.oidc?.enabled === false, "kurumsal giriş kapalıyken /api/auth/login bunu bildiriyor");
  const sessList = await api("/api/sessions");
  ok(sessList.status === 200 && Array.isArray(sessList.json?.sessions), "oturum listesi HTTP üzerinden okunuyor");
  ok((await api("/api/sessions?id=kisa", "DELETE")).status === 400, "geçersiz oturum kimliği 400 ile reddediliyor");

  const lockUser = `e2e.lock-${Date.now().toString(36)}`;
  const lockPass = "E2e-lock-2026";
  const created = await api("/api/users", "POST", { username: lockUser, fullName: "E2E Kilit", role: "radyolog", password: lockPass });
  ok(created.status === 200 && created.json?.ok === true, "kilit testi için geçici kullanıcı oluşturuldu");
  const login = (password: string) =>
    fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ username: lockUser, password }),
    }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));
  // Varsayılan eşik 5; kurulum env ile değiştirmiş olabilir → kilit görünene kadar dene.
  let last = await login("yanlis-parola");
  for (let i = 0; i < 9 && last.status !== 423; i++) last = await login("yanlis-parola");
  ok(last.status === 423 && last.json?.locked === true && (last.json?.retryAfterMinutes ?? 0) >= 1, "art arda hatalı giriş hesabı kilitliyor (423 + kalan süre)");
  ok((await login(lockPass)).status === 423, "kilitliyken doğru parola da reddediliyor");

  const userList = await api("/api/users");
  const lockRow = userList.json?.users?.find((x: any) => x.username === lockUser);
  ok(!!lockRow && lockRow.locked === true && lockRow.failedLoginCount >= 1, "yönetici listesinde hesap 'kilitli' ve sayaç görünüyor");
  ok(!JSON.stringify(lockRow).includes("passwordHash"), "kullanıcı listesi parola hash'i sızdırmıyor");

  const unlock = await api("/api/users", "PATCH", { id: lockRow.id, unlock: true });
  ok(unlock.status === 200, "kilidi aç isteği kabul edildi (200)");
  ok((await login(lockPass)).status === 200, "kilit açıldıktan sonra giriş başarılı");
  const unlockedRow = await db.query("select failed_login_count::int n, locked_until from users where username=$1", [lockUser]);
  ok(unlockedRow.rows[0].n === 0 && unlockedRow.rows[0].locked_until === null, "DB: kilit açma sayacı ve kilidi temizledi");
  const unlockAudit = await db.query("select count(*)::int n from audit_logs where action='user.unlock' and entity_id=$1", [String(lockRow.id)]);
  ok(unlockAudit.rows[0].n >= 1, "denetim: kilit açma ayrı olay olarak yazıldı");
  const sessionRows = await db.query("select count(*)::int n from sessions where user_id=$1", [lockRow.id]);
  ok(sessionRows.rows[0].n >= 1, "DB: başarılı giriş sunucu tarafı oturum kaydı açtı");

  await db.query("delete from sessions where user_id=$1", [lockRow.id]);
  await db.query("delete from users where id=$1", [lockRow.id]);

  await db.end();
  console.log(`\nTüm DB'li uçtan uca API testleri geçti (${passed} kontrol).`);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * LDAP/AD girişi uçtan uca testi — SAHTE dizin sunucusu + gerçek PostgreSQL.
 *
 *   DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
 *     npx tsx tests/ldap-integration.ts
 *
 * Sahte sunucu (127.0.0.1, rastgele port) gerçek LDAPv3 konuşur: BindRequest
 * (simple) ve SearchRequest'i kendi BER çözücümüzle ayrıştırır, BindResponse ve
 * SearchResultEntry/Done döner. Böylece istemcinin kodladığı baytlar gerçekten
 * bir sunucu tarafından okunur.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import {
  berEnum,
  berSeq,
  berStr,
  decodeString,
  ldapMessage,
  readTlv,
  toMessage,
  tlv,
  type Tlv,
} from "../src/lib/server/ldap";

const SVC_DN = "cn=svc,ou=servis,dc=hastane,dc=local";
const SVC_PW = "svc-parola";
const ADMIN_GROUP = "CN=RAD-Yonetici,OU=Gruplar,DC=hastane,DC=local";
const BASE_DN = "dc=hastane,dc=local";

interface FakeUser {
  dn: string;
  password: string;
  cn: string;
  mail: string;
  memberOf: string[];
}

const USERS: Record<string, FakeUser> = {
  "ayse.kaya": {
    dn: "uid=ayse.kaya,ou=people,dc=hastane,dc=local",
    password: "Dizin-2026!",
    cn: "Ayşe Kaya",
    mail: "ayse.kaya@hastane.local",
    memberOf: ["CN=doktorlar,OU=Gruplar,DC=hastane,DC=local"],
  },
  "admin.ldap": {
    dn: "uid=admin.ldap,ou=people,dc=hastane,dc=local",
    password: "Admin-2026!",
    cn: "Dizin Yönetici",
    mail: "admin.ldap@hastane.local",
    memberOf: [ADMIN_GROUP],
  },
  "yeni.kisi": {
    dn: "uid=yeni.kisi,ou=people,dc=hastane,dc=local",
    password: "Yeni-2026!",
    cn: "Yeni Kişi",
    mail: "yeni.kisi@hastane.local",
    memberOf: [],
  },
  "pasif.kisi": {
    dn: "uid=pasif.kisi,ou=people,dc=hastane,dc=local",
    password: "Pasif-2026!",
    cn: "Pasif Kişi",
    mail: "pasif.kisi@hastane.local",
    memberOf: [],
  },
};

/** Filtrede verilen özniteliğin eşitlik değerini bulur (kaçışlar ÇÖZÜLMEZ). */
function filterValue(node: Tlv, attrs: string[]): string | null {
  if (node.tag === 0xa3 && node.children.length === 2) {
    const name = decodeString(node.children[0]).toLowerCase();
    if (attrs.includes(name)) return decodeString(node.children[1]);
  }
  for (const c of node.children) {
    const v = filterValue(c, attrs);
    if (v != null) return v;
  }
  return null;
}

async function main() {
  if (process.env.AUTH_INTEGRATION_TEST !== "1" || !process.env.DATABASE_URL) {
    throw new Error("Yalnız ayrılmış test veritabanı için AUTH_INTEGRATION_TEST=1 ve DATABASE_URL gerekli.");
  }

  let bindCalls = 0;
  let userBinds = 0;
  const seenFilters: string[] = [];
  let down = false;

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = readTlv(buf, 0);
        if (!r) return;
        buf = buf.subarray(r.next);
        const msg = toMessage(r.node);
        if (!msg) continue;
        const reply = (op: Buffer) => sock.write(ldapMessage(msg.id, op));
        if (msg.opTag === 0x60) {
          bindCalls++;
          const [, nameNode, authNode] = msg.op.children;
          const dn = decodeString(nameNode);
          const pw = authNode?.tag === 0x80 ? decodeString(authNode) : "";
          if (dn === SVC_DN && pw === SVC_PW) {
            reply(tlv(0x61, Buffer.concat([berEnum(0), berStr(""), berStr("")])));
            continue;
          }
          userBinds++;
          const u = Object.values(USERS).find((x) => x.dn === dn);
          const code = u && u.password === pw ? 0 : 49;
          reply(tlv(0x61, Buffer.concat([berEnum(code), berStr(""), berStr(code ? "invalid credentials" : "")])));
          continue;
        }
        if (msg.opTag === 0x63) {
          const base = decodeString(msg.op.children[0]);
          const filter = msg.op.children[6];
          const wanted = filterValue(filter, ["uid", "samaccountname"]);
          seenFilters.push(JSON.stringify({ base, wanted }));
          const u = wanted ? USERS[wanted] : undefined;
          if (u) {
            const attrs: [string, string[]][] = [
              ["cn", [u.cn]],
              ["mail", [u.mail]],
              ["memberOf", u.memberOf],
            ];
            const entry = tlv(
              0x64,
              Buffer.concat([
                berStr(u.dn),
                berSeq(...attrs.map(([k, vals]) => berSeq(berStr(k), tlv(0x31, Buffer.concat(vals.map((v) => berStr(v))))))),
              ])
            );
            sock.write(ldapMessage(msg.id, entry));
          }
          reply(tlv(0x65, Buffer.concat([berEnum(0), berStr(""), berStr("")])));
          continue;
        }
        // Bilinmeyen işlem: protokol hatası
        reply(tlv(0x78, Buffer.concat([berEnum(2), berStr(""), berStr("desteklenmeyen işlem")])));
      }
    });
    sock.on("error", () => {});
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  // ── Ortam ────────────────────────────────────────────────────────────────
  process.env.AUTH_MODE = "hesap";
  process.env.SESSION_SECRET = "ci-only-signing-secret-not-for-production";
  process.env.REQUIRE_TOTP_FOR_ROLES = ""; // bu testte yönetici MFA'sı ayrı konu
  delete process.env.ACCESS_TOKEN;
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.OIDC_ISSUER;
  process.env.LDAP_URL = `ldap://127.0.0.1:${port}`;
  process.env.LDAP_BASE_DN = BASE_DN;
  process.env.LDAP_BIND_DN = SVC_DN;
  process.env.LDAP_BIND_PASSWORD = SVC_PW;
  process.env.LDAP_ADMIN_GROUP = ADMIN_GROUP;
  process.env.LDAP_AUTO_PROVISION = "1";

  const { db, pool } = await import("../src/db/index");
  const { users, sessions, auditLogs } = await import("../src/db/schema");
  const { POST } = await import("../src/app/api/auth/login/route");
  const { SESSION_COOKIE, verifySessionRef } = await import("../src/lib/server/session");

  const created: number[] = [];
  const login = (username: string, password: string) =>
    POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
    ).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any, cookie: r.cookies.get(SESSION_COOKIE)?.value ?? "" }));

  const cleanup = async () => {
    for (const id of created) {
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  };

  // Test hermeticliği: önceki koşudan kalan dizin hesaplarını temizle.
  const staleNames = ["ayse.kaya", "admin.ldap", "yeni.kisi", "pasif.kisi"];
  const staleDns = Object.values(USERS).map((u) => u.dn.toLowerCase());
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.username, staleNames));
  const staleByDn = await db.select({ id: users.id }).from(users).where(inArray(users.ldapDn, staleDns));
  for (const row of [...stale, ...staleByDn]) {
    await db.delete(sessions).where(eq(sessions.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }

  try {
    // ── 1) Dizin hesabıyla giriş: hesap açılır, oturum kurulur ─────────────
    const r1 = await login("ayse.kaya", "Dizin-2026!");
    assert.equal(r1.status, 200, `dizin girişi başarılı olmalı (${JSON.stringify(r1.json)})`);
    const ref1 = verifySessionRef(r1.cookie);
    assert.ok(ref1 && /^[a-f0-9]{32}$/.test(ref1.sid), "sunucu oturum kaydı kurulur");
    created.push(ref1!.uid);
    const u1 = (await db.select().from(users).where(eq(users.id, ref1!.uid)))[0];
    assert.equal(u1.username, "ayse.kaya");
    assert.equal(u1.ldapDn, USERS["ayse.kaya"].dn.toLowerCase(), "dizin DN'i hesaba yazılır");
    assert.equal(u1.fullName, "Ayşe Kaya", "cn ad olarak kullanılır");
    assert.equal(u1.role, "radyolog", "yönetici grubunda değil");
    assert.equal(u1.passwordHash, "-", "parola uygulamada tutulmaz");
    const a1 = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login"));
    const last1 = a1[a1.length - 1];
    assert.match(last1.details, /"method":"ldap"/, "denetim yöntemi ldap");
    assert.match(last1.details, /"created":true/);
    console.log("PASS LDAP ilk giriş: servis bind → kullanıcı araması → kullanıcı bind → hesap + oturum + denetim.");

    // ── 2) Tekrar giriş: mükerrer hesap yok ─────────────────────────────────
    const r2 = await login("ayse.kaya", "Dizin-2026!");
    assert.equal(r2.status, 200);
    const ref2 = verifySessionRef(r2.cookie);
    assert.equal(ref2?.uid, ref1!.uid, "aynı hesaba bağlanır");
    const sameDn = (await db.select({ id: users.id }).from(users).where(eq(users.ldapDn, u1.ldapDn))).length;
    assert.equal(sameDn, 1, "tekrarlanan giriş yeni hesap açmaz");
    console.log("PASS LDAP tekrar giriş: DN eşleşmesiyle aynı hesap, mükerrer kayıt yok.");

    // ── 3) Yönetici grubu rolü yükseltir ────────────────────────────────────
    const r3 = await login("admin.ldap", "Admin-2026!");
    assert.equal(r3.status, 200);
    const ref3 = verifySessionRef(r3.cookie);
    created.push(ref3!.uid);
    const u3 = (await db.select().from(users).where(eq(users.id, ref3!.uid)))[0];
    assert.equal(u3.role, "yonetici", "LDAP_ADMIN_GROUP üyeliği yönetici yapar");
    console.log("PASS LDAP rolleri: yönetici grubu yönetici rolüyle hesap açar.");

    // ── 4) Hatalı parola / boş parola / bilinmeyen kullanıcı ────────────────
    const bad = await login("ayse.kaya", "yanlis-parola");
    assert.equal(bad.status, 401);
    assert.ok(typeof bad.json?.remainingAttempts === "number", "kalan deneme bildirilir");
    const bindBeforeEmpty = bindCalls;
    const empty = await login("ayse.kaya", "");
    assert.equal(empty.status, 401);
    assert.equal(bindCalls, bindBeforeEmpty, "boş parola dizine hiç gönderilmez (anonim bind koruması)");
    const unknown = await login("olmayan.kisi", "Herhangi-2026!");
    assert.equal(unknown.status, 401);
    assert.equal((await db.select({ id: users.id }).from(users).where(eq(users.username, "olmayan.kisi"))).length, 0, "bilinmeyen kimlik için hesap açılmaz");
    console.log("PASS LDAP hata yolları: hatalı parola 401, boş parola ağa çıkmaz, olmayan kullanıcı hesap açmaz.");

    // ── 5) Filtre enjeksiyonu ───────────────────────────────────────────────
    const beforeInjection = seenFilters.length;
    const inj = await login("*)(uid=*", "Herhangi-2026!");
    assert.equal(inj.status, 401, "joker enjeksiyonu ile giriş yok");
    const filtersAfter = seenFilters.slice(beforeInjection);
    assert.ok(
      filtersAfter.length === 0 || filtersAfter.every((f) => f.includes("\\2a")),
      `dizine giden filtre kaçırılmış olmalı (${filtersAfter.join(" | ")})`
    );
    console.log("PASS LDAP enjeksiyonu: kullanıcı adı filtresi RFC 4515 ile kaçırılıyor, joker etkisiz.");

    // ── 6) Otomatik açma kapalı ─────────────────────────────────────────────
    process.env.LDAP_AUTO_PROVISION = "0";
    const noProv = await login("yeni.kisi", "Yeni-2026!");
    assert.equal(noProv.status, 403, "LDAP_AUTO_PROVISION=0 iken tanımsız kimlik reddedilir");
    assert.match(String(noProv.json?.error), /hesap/i);
    process.env.LDAP_AUTO_PROVISION = "1";
    console.log("PASS LDAP politikası: otomatik hesap açma kapatılabilir (403).");

    // ── 7) Pasif hesap dizinle atlanmaz ─────────────────────────────────────
    const pasifDn = USERS["pasif.kisi"].dn.toLowerCase();
    const pasifId = (
      await db
        .insert(users)
        .values({ username: `pasif.${randomUUID().slice(0, 6)}`, passwordHash: "-", fullName: "Pasif Kişi", role: "radyolog", active: false, ldapDn: pasifDn })
        .returning({ id: users.id })
    )[0].id;
    const pasifName = (await db.select({ u: users.username }).from(users).where(eq(users.id, pasifId)))[0].u;
    created.push(pasifId);
    const pasif = await login(pasifName, "Pasif-2026!");
    assert.equal(pasif.status, 401, "pasif hesap LDAP ile de giremez");
    console.log("PASS LDAP güvenliği: pasif hesap dizin doğrulamasıyla atlanamaz.");

    // ── 8) Dizin sunucusu kapalıyken teşhis edilebilir hata ─────────────────
    down = true;
    // ── 8) Doğrudan bind modu (servis hesabı yok) ───────────────────────────
    const svcDn = process.env.LDAP_BIND_DN;
    const svcPw = process.env.LDAP_BIND_PASSWORD;
    delete process.env.LDAP_BIND_DN;
    delete process.env.LDAP_BIND_PASSWORD;
    process.env.LDAP_USER_DN_TEMPLATE = "uid={username},ou=people,dc=hastane,dc=local";
    const bindsBeforeTemplate = userBinds;
    const tpl = await login("yeni.kisi", "Yeni-2026!");
    assert.equal(tpl.status, 200, `doğrudan bind ile giriş (${JSON.stringify(tpl.json)})`);
    assert.equal(userBinds - bindsBeforeTemplate, 1, "servis bind'i yok, tek kullanıcı bind'i");
    const refTpl = verifySessionRef(tpl.cookie);
    created.push(refTpl!.uid);
    const uTpl = (await db.select().from(users).where(eq(users.id, refTpl!.uid)))[0];
    assert.equal(uTpl.ldapDn, USERS["yeni.kisi"].dn.toLowerCase(), "şablondan üretilen DN hesaba yazılır");
    console.log("PASS LDAP doğrudan bind: DN şablonu ile servis hesabı olmadan giriş, tek bind.");

    // ── 9) Dizin sunucusu kapalıyken teşhis edilebilir hata ─────────────────
    process.env.LDAP_BIND_DN = svcDn;
    process.env.LDAP_BIND_PASSWORD = svcPw;
    delete process.env.LDAP_USER_DN_TEMPLATE;
    await new Promise<void>((r) => server.close(() => r()));
    const offline = await login("ayse.kaya", "Dizin-2026!");
    assert.equal(offline.status, 503, "sunucu yokken 503 ve açıklama döner");
    assert.match(String(offline.json?.error), /dizin sunucusuna ulaşılamadı/i);
    void down;
    console.log("PASS LDAP dayanıklılığı: dizin sunucusu yokken 'parola hatalı' yerine 503 + açıklama.");
  } finally {
    await cleanup();
    if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import {
  berBool,
  berEnum,
  berInt,
  berSeq,
  berStr,
  bindRequest,
  buildFilter,
  decodeInt,
  decodeString,
  escapeDnValue,
  escapeFilterValue,
  fillTemplate,
  inAdminGroup,
  ldapConfig,
  ldapEnabled,
  ldapErrorText,
  ldapMessage,
  parseFilter,
  readAll,
  readTlv,
  resultCode,
  resultDiagnostic,
  sameDn,
  searchRequest,
  tlv,
  toEntry,
  toMessage,
  type Tlv,
} from "../src/lib/server/ldap";

/**
 * LDAP çekirdeği testleri — dizin sunucusu YOK.
 * Kanıtlanan: yapılandırma, RFC 4515/4514 kaçışları (filtre enjeksiyonu),
 * BER kodlama/çözme, filtre ayrıştırma ve yanıt yorumlama.
 */
const byTag = (nodes: Tlv[], tag: number) => nodes.filter((n) => n.tag === tag);

function main() {
  // ── Yapılandırma ─────────────────────────────────────────────────────────
  assert.equal(ldapConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(ldapEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(ldapConfig({ LDAP_URL: "http://x", LDAP_BASE_DN: "dc=a" } as unknown as NodeJS.ProcessEnv), null, "yalnız ldap/ldaps");
  assert.equal(ldapConfig({ LDAP_URL: "ldap://x", LDAP_BASE_DN: "" } as unknown as NodeJS.ProcessEnv), null, "taban DN ya da şablon gerekli");
  const base = { LDAP_URL: "ldaps://dc1.hastane.local:636", LDAP_BASE_DN: "dc=hastane,dc=local" } as unknown as NodeJS.ProcessEnv;
  const cfg = ldapConfig(base)!;
  assert.equal(cfg.userFilter, "(|(sAMAccountName={username})(uid={username}))");
  assert.equal(cfg.attrName, "cn");
  assert.equal(cfg.attrGroups, "memberOf");
  assert.equal(cfg.defaultRole, "radyolog");
  assert.equal(cfg.autoProvision, true);
  assert.equal(cfg.timeoutMs, 5000);
  const tplOnly = ldapConfig({ LDAP_URL: "ldap://x", LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=a" } as unknown as NodeJS.ProcessEnv);
  assert.ok(tplOnly, "şablonla arama olmadan da yapılandırma geçerli");
  assert.equal(ldapConfig({ ...base, LDAP_DEFAULT_ROLE: "root" } as unknown as NodeJS.ProcessEnv)!.defaultRole, "radyolog", "bilinmeyen rol güvenli varsayılana düşer");
  assert.equal(ldapConfig({ ...base, LDAP_TIMEOUT_MS: "10" } as unknown as NodeJS.ProcessEnv)!.timeoutMs, 5000, "aşırı küçük zaman aşımı sınırlanır");
  assert.equal(ldapConfig({ ...base, LDAP_TIMEOUT_MS: "999999" } as unknown as NodeJS.ProcessEnv)!.timeoutMs, 30_000, "aşırı büyük zaman aşımı sınırlanır");
  assert.equal(ldapConfig({ ...base, LDAP_AUTO_PROVISION: "0" } as unknown as NodeJS.ProcessEnv)!.autoProvision, false);
  console.log("PASS LDAP yapılandırması: url/taban DN/şablon kuralları, güvenli varsayılanlar ve sınırlar.");

  // ── Kaçışlar (filtre enjeksiyonu) ────────────────────────────────────────
  assert.equal(escapeFilterValue("a*b"), "a\\2ab");
  assert.equal(escapeFilterValue("(uid=*)"), "\\28uid=\\2a\\29");
  assert.equal(escapeFilterValue("back\\slash"), "back\\5cslash");
  assert.equal(escapeFilterValue("nul\0"), "nul\\00");
  const injected = buildFilter("(|(sAMAccountName={username})(uid={username}))", "*)(uid=*");
  assert.ok(!injected.includes("*)(uid="), `filtre enjeksiyonu kaçırılır (${injected})`);
  assert.match(injected, /\\2a\\29\\28uid=\\2a/);
  assert.equal(buildFilter("(uid={user})", "ayse"), "(uid=ayse)");
  assert.equal(escapeDnValue("Kaya, Ayşe"), "Kaya\\, Ayşe", "DN'de virgül kaçırılır");
  assert.equal(fillTemplate("uid={username},ou=p,dc=a", "ayse"), "uid=ayse,ou=p,dc=a");
  assert.equal(fillTemplate("uid={username},ou=p", "a,b"), "uid=a\\,b,ou=p");
  console.log("PASS kaçışlar: RFC 4515 filtre ve RFC 4514 DN kaçışı ile enjeksiyon kapanıyor.");

  // ── DN / grup eşleşmesi ──────────────────────────────────────────────────
  assert.equal(sameDn("CN=Ali, OU=RAD, DC=a", "cn=ali,ou=rad,dc=a"), true);
  assert.equal(sameDn("CN=Ali,OU=RAD", "CN=Veli,OU=RAD"), false);
  assert.equal(sameDn("", ""), false);
  const admin = "CN=RAD-Yonetici,OU=Gruplar,DC=hastane,DC=local";
  assert.equal(inAdminGroup([admin], admin), true);
  assert.equal(inAdminGroup([admin.toUpperCase()], admin), true, "büyük/küçük harf duyarsız");
  assert.equal(inAdminGroup(["CN=RAD-Yonetici,OU=Baska"], "RAD-Yonetici"), true, "CN adıyla eşleşme");
  assert.equal(inAdminGroup(["CN=doktorlar"], "RAD-Yonetici"), false);
  assert.equal(inAdminGroup([], admin), false);
  assert.equal(inAdminGroup([admin], ""), false);
  console.log("PASS grup eşleşmesi: tam DN ve CN biçimleri, harf duyarsız karşılaştırma.");

  // ── BER kodlama ──────────────────────────────────────────────────────────
  assert.deepEqual([...berInt(0)], [0x02, 0x01, 0x00]);
  assert.deepEqual([...berInt(127)], [0x02, 0x01, 0x7f]);
  assert.deepEqual([...berInt(128)], [0x02, 0x02, 0x00, 0x80], "işaret biti için baştaki sıfır");
  const long = tlv(0x04, Buffer.alloc(200, 0x41));
  assert.equal(long[0], 0x04);
  assert.equal(long[1], 0x81, "uzun biçim uzunluk");
  assert.equal(long[2], 200);
  const rt = readTlv(long)!;
  assert.equal(rt.node.tag, 0x04);
  assert.equal(decodeString(rt.node).length, 200);
  assert.equal(readTlv(long.subarray(0, 100)), null, "eksik veri null döner (TCP parçası)");
  const two = Buffer.concat([berStr("a"), berStr("bb"), berStr("c").subarray(0, 2)]);
  const all = readAll(two);
  assert.equal(all.nodes.length, 2, "tamamlanmış TLV'ler ayrıştırılır");
  assert.equal(all.rest.length, 2, "tamamlanmayan kuyruk geri verilir");
  const msg = toMessage(readTlv(ldapMessage(5, berEnum(0)))!.node)!;
  assert.equal(msg.id, 5);
  assert.equal(msg.opTag, 0x0a);
  assert.equal(decodeInt(msg.op), 0);
  console.log("PASS BER: kısa/uzun uzunluk, işaretli tamsayı, eksik veri ve çoklu mesaj ayrıştırma.");

  // ── BindRequest / SearchRequest ──────────────────────────────────────────
  const bind = toMessage(readTlv(ldapMessage(1, bindRequest("uid=ayse,dc=a", "gizli")))!.node)!;
  assert.equal(bind.opTag, 0x60, "BindRequest application 0");
  const bparts = bind.op.children;
  assert.equal(decodeInt(bparts[0]), 3, "LDAP sürüm 3");
  assert.equal(decodeString(bparts[1]), "uid=ayse,dc=a");
  assert.equal(bparts[2].tag, 0x80, "simple authentication");
  assert.equal(decodeString(bparts[2]), "gizli");

  const sr = toMessage(readTlv(ldapMessage(2, searchRequest("dc=a", parseFilter("(uid=ayse)"), ["cn", "mail"])))!.node)!;
  assert.equal(sr.opTag, 0x63, "SearchRequest application 3");
  assert.equal(decodeString(sr.op.children[0]), "dc=a");
  assert.equal(decodeInt(sr.op.children[1]), 2, "wholeSubtree");
  assert.equal(sr.op.children[6].tag, 0xa3, "equalityMatch filtresi");
  const attrs = sr.op.children[7];
  assert.deepEqual(attrs.children.map(decodeString), ["cn", "mail"]);
  console.log("PASS istekler: BindRequest (sürüm 3 + simple auth) ve SearchRequest alanları doğru kodlanıyor.");

  // ── Filtre ayrıştırma ────────────────────────────────────────────────────
  assert.equal(parseFilter("(uid=ayse)")[0], 0xa3);
  assert.equal(parseFilter("(mail=*)")[0], 0x87, "present filtresi");
  const or = parseFilter("(|(a=1)(b=2))");
  assert.equal(or[0], 0xa1);
  assert.equal(readTlv(or)!.node.children.length, 2);
  const and = parseFilter("(&(objectClass=person)(uid=*))");
  assert.equal(and[0], 0xa0, "AND filtresi");
  assert.equal(readTlv(and)!.node.children.length, 2);
  assert.throws(() => parseFilter("(uid>=5)"), /desteklenmiyor/, "desteklenmeyen sözdizimi sessizce geçmez");
  assert.throws(() => parseFilter("(uid=5"), /desteklenmiyor|\)/, "kapanmayan filtre hata verir");
  assert.throws(() => parseFilter("uid=5"), /\(/, "parantezsiz filtre hata verir");
  console.log("PASS filtre: equality/present/OR desteği, desteklenmeyen sözdiziminde açık hata.");

  // ── Yanıt yorumlama ──────────────────────────────────────────────────────
  const entryNode = tlv(
    0x64,
    Buffer.concat([
      berStr("uid=ayse,ou=people,dc=hastane,dc=local"),
      berSeq(
        berSeq(berStr("cn"), tlv(0x31, berStr("Ayşe Kaya"))),
        berSeq(berStr("memberOf"), tlv(0x31, Buffer.concat([berStr("CN=RAD-Yonetici,OU=Gruplar,DC=hastane,DC=local")])))
      ),
    ])
  );
  const entry = toEntry(readTlv(entryNode)!.node)!;
  assert.equal(entry.dn, "uid=ayse,ou=people,dc=hastane,dc=local");
  assert.deepEqual(entry.attrs.cn, ["Ayşe Kaya"]);
  assert.equal(entry.attrs.memberof.length, 1);
  assert.equal(toEntry(readTlv(tlv(0x65, Buffer.alloc(0)))!.node), null, "entry olmayan işlem null");

  const doneNode = readTlv(tlv(0x65, Buffer.concat([berEnum(49), berStr(""), berStr("invalid credentials")])))!.node;
  assert.equal(resultCode(doneNode), 49);
  assert.equal(resultDiagnostic(doneNode), "invalid credentials");
  assert.match(ldapErrorText(49), /parola hatalı/);
  assert.match(ldapErrorText(999), /999/);
  console.log("PASS yanıtlar: SearchResultEntry DN/öznitelikleri, sonuç kodu ve tanılama metni.");

  // ── Yardımcılar ──────────────────────────────────────────────────────────
  assert.equal(decodeInt(readTlv(berBool(true))!.node), 255, "boolean 0xff");
  assert.ok(berSeq(berInt(1)).length > 2);
  console.log("PASS yardımcılar: boolean/sequence kodlamaları tutarlı.");

  console.log("Tüm LDAP çekirdek testleri geçti.");
}

main();

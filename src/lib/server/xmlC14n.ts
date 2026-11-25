/**
 * Küçük, güvenlik odaklı XML ayrıştırıcı + c14n (canonicalization) alt kümesi.
 *
 * Neden kendi yazıldı: SAML imza doğrulaması için `SignedInfo` ve imzalanan
 * öğenin **bayt düzeyinde** aynısını üretebilmek gerekir; harici bağımlılık
 * eklemeden (depo politikası) bu kadarı yeterli ve denetlenebilir.
 *
 * Desteklenen: öğeler, öznitelikler, metin, CDATA, yorumlar (c14n'de atılır),
 * XML bildirimi, önceden tanımlı varlıklar ve sayısal karakter referansları.
 * DESTEKLENMEYEN ve bilinçli olarak REDDEDİLEN: DOCTYPE/ENTITY (XXE),
 * işlem yönergeleri (c14n dışında bırakılır), ad alanı dışı genişletmeler.
 *
 * Kanonikleştirme: XML C14N 1.0 (yorumlar hariç) ve Exclusive C14N alt kümesi —
 * öğe sırası korunur, öznitelikler (ad alanı URI'si, yerel ad) sırasına göre
 * dizilir, boş öğeler `<a></a>` olarak yazılır, metin varlıkları kaçırılır.
 */
export interface XmlAttr {
  name: string;
  value: string;
}

export interface XmlNode {
  /** Belgede yazıldığı gibi nitelikli ad (ör. `samlp:Response`). */
  name: string;
  attrs: XmlAttr[];
  /** Alt düğümler; metin düğümleri `#text` adıyla **belge sırasında** yer alır. */
  children: XmlNode[];
  /** Yalnız `#text` düğümlerinde dolu (varlıklar çözülmüş). */
  text: string;
}

export const TEXT_NODE = "#text";

const textNode = (value: string): XmlNode => ({ name: TEXT_NODE, attrs: [], children: [], text: value });

export class XmlError extends Error {}

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Varlıkları çözer; bilinmeyen varlıkta hata (belge reddedilir). */
function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = Number.parseInt(ent.slice(2), 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) throw new XmlError("geçersiz karakter referansı");
      return String.fromCodePoint(cp);
    }
    if (ent.startsWith("#")) {
      const cp = Number.parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) throw new XmlError("geçersiz karakter referansı");
      return String.fromCodePoint(cp);
    }
    const v = PREDEFINED[ent];
    if (v === undefined) throw new XmlError(`bilinmeyen varlık: ${ent}`);
    return v;
  });
}

/** XML metnini güvenli biçimde ağaca çevirir. */
export function parseXml(src: string): XmlNode {
  if (!src || typeof src !== "string") throw new XmlError("boş XML");
  // DTD/ENTITY yasak: XXE ve varlık genişletme saldırılarının kapısı kapatılır.
  if (/<!DOCTYPE/i.test(src) || /<!ENTITY/i.test(src)) throw new XmlError("DTD/ENTITY desteklenmiyor");

  const root: XmlNode = { name: "#document", attrs: [], children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;

  const pushText = (raw: string) => {
    const t = decodeEntities(raw);
    if (t) stack[stack.length - 1].children.push(textNode(t));
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlError("kapanmayan yorum");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlError("kapanmayan CDATA");
      stack[stack.length - 1].children.push(textNode(src.slice(lt + 9, end)));
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlError("kapanmayan işlem yönergesi");
      i = end + 2;
      continue;
    }
    if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end === -1) throw new XmlError("kapanmayan bitiş etiketi");
      const name = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top === root || top.name !== name) throw new XmlError(`eşleşmeyen bitiş etiketi: ${name}`);
      i = end + 1;
      continue;
    }

    // Açılış etiketi: ad + öznitelikler + (/> ya da >)
    const tagEnd = findTagEnd(src, lt + 1);
    const rawTag = src.slice(lt + 1, tagEnd);
    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(body);
    if (!nameMatch) throw new XmlError("geçersiz etiket");
    const name = nameMatch[0];
    const node: XmlNode = { name, attrs: parseAttrs(body.slice(name.length)), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = tagEnd + 1;
  }

  if (stack.length !== 1) throw new XmlError("kapanmayan öğe");
  const elems = root.children.filter((c) => c.name !== TEXT_NODE);
  const disi = root.children.filter((c) => c.name === TEXT_NODE && c.text.trim() !== "");
  if (disi.length) throw new XmlError("kök dışında metin var");
  if (elems.length !== 1) throw new XmlError("belge tek kök öğe içermeli");
  return elems[0];
}

function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  throw new XmlError("kapanmayan etiket");
}

function parseAttrs(raw: string): XmlAttr[] {
  const out: XmlAttr[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /\s/.test(raw[i])) i++;
    if (i >= n) break;
    const m = /^[A-Za-z_][\w.:-]*/.exec(raw.slice(i));
    if (!m) throw new XmlError("geçersiz öznitelik");
    const name = m[0];
    i += name.length;
    while (i < n && /\s/.test(raw[i])) i++;
    if (raw[i] !== "=") throw new XmlError(`öznitelik değeri yok: ${name}`);
    i++;
    while (i < n && /\s/.test(raw[i])) i++;
    const q = raw[i];
    if (q !== '"' && q !== "'") throw new XmlError(`tırnaksız öznitelik: ${name}`);
    i++;
    const end = raw.indexOf(q, i);
    if (end === -1) throw new XmlError(`kapanmayan öznitelik: ${name}`);
    const value = decodeEntities(raw.slice(i, end));
    if (out.some((a) => a.name === name)) throw new XmlError(`yinelenen öznitelik: ${name}`);
    out.push({ name, value });
    i = end + 1;
  }
  return out;
}

/* ── Yardımcılar ─────────────────────────────────────────────────────────── */

export const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1);
export const prefixOf = (qname: string): string => (qname.includes(":") ? qname.slice(0, qname.indexOf(":")) : "");

export function attr(node: XmlNode | undefined | null, name: string): string | undefined {
  if (!node) return undefined;
  const hit = node.attrs.find((a) => a.name === name || (a.name.includes(":") && a.name.slice(a.name.indexOf(":") + 1) === name));
  return hit?.value;
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name !== TEXT_NODE && localName(c.name) === name);
}

/** Öğenin metin değeri (alt öğeler dahil, belge sırasında). */
export function textContent(node: XmlNode): string {
  if (node.name === TEXT_NODE) return node.text;
  return node.children.map((c) => (c.name === TEXT_NODE ? c.text : textContent(c))).join("");
}

export function childNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name !== TEXT_NODE && localName(c.name) === name);
}

/** Alt ağaçta yerel ada göre ilk öğe (genişlik öncelikli). */
export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  const queue: XmlNode[] = [node];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur !== node && cur.name !== TEXT_NODE && localName(cur.name) === name) return cur;
    queue.push(...cur.children);
  }
  return undefined;
}

/* ── Kanonikleştirme ─────────────────────────────────────────────────────── */

export interface C14nOptions {
  /** C14N metodu: exclusive (varsayılan SAML için) ya da inclusive. */
  exclusive?: boolean;
  /** Kanonik çıktıya girmeyecek düğümler (ör. zarf içindeki Signature). */
  exclude?: Set<XmlNode>;
  /** Üst öğelerden devralınan ad alanı kapsamı (imza doğrulaması için). */
  scope?: Map<string, string>;
}

/** Köklenmiş ağaçta öğenin ad alanı kapsamını (üst öğeler dahil) toplar. */
export function namespaceScope(node: XmlNode, ancestors: XmlNode[]): Map<string, string> {
  const scope = new Map<string, string>();
  for (const a of [...ancestors, node]) {
    for (const at of a.attrs) {
      if (at.name === "xmlns") scope.set("", at.value);
      else if (at.name.startsWith("xmlns:")) scope.set(at.name.slice(6), at.value);
    }
  }
  return scope;
}

/** Belge ağacında öğeye giden yolu (üst öğeler) bulur. */
export function pathTo(root: XmlNode, target: XmlNode): XmlNode[] | null {
  if (root === target) return [];
  for (const c of root.children) {
    const p = pathTo(c, target);
    if (p) return [root, ...p];
  }
  return null;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const escAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");

interface NsDecl {
  prefix: string;
  uri: string;
}

function declaredNs(node: XmlNode): NsDecl[] {
  const out: NsDecl[] = [];
  for (const a of node.attrs) {
    if (a.name === "xmlns") out.push({ prefix: "", uri: a.value });
    else if (a.name.startsWith("xmlns:")) out.push({ prefix: a.name.slice(6), uri: a.value });
  }
  return out;
}

/** Alt ağaçta (dışlanan düğümler hariç) görülen önek kümesi. */
function usedPrefixes(node: XmlNode, acc: Set<string>, exclude: Set<XmlNode>): void {
  if (exclude.has(node)) return;
  acc.add(prefixOf(node.name));
  for (const a of node.attrs) {
    if (a.name !== "xmlns" && !a.name.startsWith("xmlns:")) acc.add(prefixOf(a.name));
  }
  for (const c of node.children) usedPrefixes(c, acc, exclude);
}

/**
 * Öğeyi kanonik XML'e çevirir.
 *
 * `exclusive` (Exclusive C14N, SAML'de yaygın): yalnız alt ağaçta **kullanılan**
 * öneklerin bildirimleri yazılır. Inclusive: üst kapsamdan devralınan tüm ad
 * alanları kök öğede yazılır. İkisinde de öznitelikler sıralanır, yorumlar ve
 * işlem yönergeleri atılır, boş öğeler `<a></a>` biçiminde yazılır.
 */
export function canonicalize(node: XmlNode, opts: C14nOptions = {}): string {
  const exclusive = opts.exclusive !== false;
  const exclude = opts.exclude ?? new Set<XmlNode>();
  const scope = new Map(opts.scope ?? []);
  const buf: string[] = [];
  const used = new Set<string>();
  usedPrefixes(node, used, exclude);

  const walk = (cur: XmlNode, inherited: Map<string, string>, isRoot: boolean) => {
    if (exclude.has(cur)) return;
    if (cur.name === TEXT_NODE) {
      buf.push(escText(cur.text));
      return;
    }
    const own = declaredNs(cur);
    const curScope = new Map(inherited);
    for (const d of own) curScope.set(d.prefix, d.uri);

    // 1) Öğenin kendi bildirimleri — exclusive c14n'de kullanılmayanlar yazılmaz
    //    (ör. yalnız imza içinde geçen `ds` öneki özet hesabında görünmez).
    const render: NsDecl[] = [];
    const rendered = new Set<string>();
    for (const d of own) {
      if (d.prefix === "xml") continue;
      if (exclusive && !used.has(d.prefix) && d.prefix !== "") continue;
      // Inclusive: üstte aynı değerle bildirilmişse yine de yazılır (kaynaktaki gibi).
      render.push(d);
      rendered.add(d.prefix);
    }
    // 2) Kök öğe: alt ağaçta kullanılan, üstten devralınan bildirimler
    if (isRoot) {
      for (const [p, uri] of curScope) {
        if (p === "xml" || rendered.has(p)) continue;
        if (exclusive && !used.has(p)) continue;
        render.push({ prefix: p, uri });
        rendered.add(p);
      }
    }
    render.sort((a, b) => (a.prefix === "" ? (b.prefix === "" ? 0 : -1) : b.prefix === "" ? 1 : a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));

    // 3) Öznitelikler: (ad alanı URI'si, yerel ad) sırasına göre
    const plain = cur.attrs
      .filter((a) => a.name !== "xmlns" && !a.name.startsWith("xmlns:"))
      .map((a) => ({
        name: a.name,
        value: a.value,
        ns: prefixOf(a.name) ? (curScope.get(prefixOf(a.name)) ?? "") : "",
        local: localName(a.name),
      }))
      .sort((x, y) => (x.ns === y.ns ? (x.local === y.local ? (x.name < y.name ? -1 : 1) : x.local < y.local ? -1 : 1) : x.ns < y.ns ? -1 : 1));

    buf.push("<", cur.name);
    for (const d of render) buf.push(d.prefix ? ` xmlns:${d.prefix}="${escAttr(d.uri)}"` : ` xmlns="${escAttr(d.uri)}"`);
    for (const a of plain) buf.push(` ${a.name}="${escAttr(a.value)}"`);
    buf.push(">");
    for (const c of cur.children) walk(c, curScope, false);
    buf.push("</", cur.name, ">");
  };

  walk(node, scope, true);
  return buf.join("");
}

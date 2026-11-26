/**
 * Guide coverage — kılavuz ile arayüz arasındaki farkı CI'da yakalar.
 *
 * Zorunlu tutulan metinler:
 *  1) src/components/{Workstation,RightPanel,KneeSegPanel}.tsx içindeki statik
 *     title="…" ve aria-label="…" dizelerinin TAMAMI (dynamic/template olanlar hariç),
 *  2) docs/menu-kilavuzu.manifest.json içindeki küratörlü anchor'lar,
 *  3) KURULUM_VE_KULLANIM.md'nin MENU_KILAVUZU.md'ye bağlanması,
 *  4) MENU_KILAVUZU.md içindeki göreli görsellerin diskte var olması.
 *
 * Yeni bir düğme/menü eklendiğinde kılavuz güncellenmezse bu test KIRMIZI döner.
 * Bu davranış bilinçlidir — bkz. docs/KILAVUZ_BAKIMI.md.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

const guide = read("docs/MENU_KILAVUZU.md");
const setupGuide = read("docs/KURULUM_VE_KULLANIM.md");

// 1) Kod içindeki statik ipuçları
const uiFiles = [
  "src/components/Workstation.tsx",
  "src/components/RightPanel.tsx",
  "src/components/KneeSegPanel.tsx",
];
const pattern = /(?:title|aria-label)="([^"]{8,200})"/g;
const seen = new Set<string>();
for (const file of uiFiles) {
  const src = read(file);
  for (const match of src.matchAll(pattern)) {
    const text = match[1].trim();
    if (text.includes("${") || text.includes("<") || seen.has(text)) continue;
    seen.add(text);
    const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    ok(guide.includes(text), `${path.basename(file)}: "${short}"`);
  }
}
console.log(`  (statik ipucu: ${seen.size} adet denetlendi)`);

// 2) Küratörlü anchor'lar
const anchors = JSON.parse(read("docs/menu-kilavuzu.manifest.json")) as string[];
for (const anchor of anchors) {
  ok(guide.includes(anchor), `manifest: "${anchor.length > 60 ? `${anchor.slice(0, 60)}…` : anchor}"`);
}

// 3) Kurulum kılavuzu menü kılavuzuna bağlanır
ok(/MENU_KILAVUZU\.md/.test(setupGuide), "KURULUM_VE_KULLANIM.md → MENU_KILAVUZU.md bağlantısı");

// 4) Kılavuzdaki göreli görseller var
for (const match of guide.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
  const rel = match[1].split("#")[0];
  ok(existsSync(path.join(root, "docs", rel)), `görsel mevcut: ${rel}`);
}

if (failures > 0) {
  console.error(`\nGuide coverage: FAIL (${failures} eksik). docs/KILAVUZ_BAKIMI.md adımlarını uygulayın.`);
  process.exit(1);
}
console.log("\nGuide coverage: PASS");

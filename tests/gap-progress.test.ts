import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAP_ITEMS, CATEGORIES } from "../src/lib/gapAnalysis";
import { gapProgress } from "../src/lib/gapProgress";

assert.deepEqual(gapProgress([]), { var: 0, kismi: 0, yok: 0, total: 0, completedPercent: 0, open: 0, indexPercent: 0 });
assert.deepEqual(gapProgress([{ status: "var" }, { status: "kismi" }, { status: "yok" }]), { var: 1, kismi: 1, yok: 1, total: 3, completedPercent: 33, open: 2, indexPercent: 50 });
assert.equal(gapProgress([{ status: "kismi" }]).completedPercent, 0);
assert.equal(gapProgress([{ status: "var" }]).completedPercent, 100);
assert.equal(new Set(GAP_ITEMS.map(x => x.id)).size, GAP_ITEMS.length);
assert.ok(GAP_ITEMS.every(x => CATEGORIES.some(c => c.id === x.category)));
assert.equal(gapProgress(GAP_ITEMS).total, GAP_ITEMS.length);
assert.equal(GAP_ITEMS.find(x => x.id === "g-supplychain")?.status, "kismi");
const workflow = readFileSync(".github/workflows/ci.yml", "utf8").split("  dependency-review:")[1].split("  ui-tests:")[0];
assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
assert.match(workflow, /uses: actions\/dependency-review-action@v4/);
console.log("PASS kıyaslama yüzdeleri, durum sayımları ve dependency-review hata görünürlüğü");

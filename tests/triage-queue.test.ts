import assert from "node:assert/strict";
import { triageCounts, triageGroup } from "../src/lib/triageQueue";
import type { StudyRow } from "../src/lib/types";

const row = (score: number, aiEngine = "cv-heuristic", triageLevel = "ADAY") => ({ triageScore: score, aiEngine, triageLevel } as StudyRow);
assert.equal(triageGroup(row(0.95)), "kritik");
assert.equal(triageGroup(row(0.8)), "yuksek");
assert.equal(triageGroup(row(0.6)), "diger");
assert.equal(triageGroup(row(0.95, "", "")), "analiz-yok");
assert.equal(triageGroup(row(0.95, "image-review")), "analiz-yok");
assert.equal(triageGroup(row(0.95, "no-model")), "analiz-yok");
assert.equal(triageGroup(row(NaN)), "analiz-yok");
assert.equal(triageGroup(row(0.95, "simulated-sample")), "kritik");
assert.deepEqual(triageCounts([row(.95), row(.78), row(.55), row(0, "")]), { kritik: 1, yuksek: 1, diger: 1, "analiz-yok": 1 });
assert.deepEqual(triageCounts([]), { kritik: 0, yuksek: 0, diger: 0, "analiz-yok": 0 });
console.log("PASS triaj kuyruk gruplama ve özet");

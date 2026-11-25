import assert from "node:assert/strict";
import { parseStowResponse } from "../src/lib/stowResponse";

const ref = (uid: string) => ({ "00081155": { vr: "UI", Value: [uid] } });
const sq = (...v: unknown[]) => ({ vr: "SQ", Value: v });
const accepted = { "00081199": sq(ref("1.2.3")) };
assert.deepEqual(parseStowResponse(JSON.stringify(accepted), "1.2.3"), { stored: 1, failed: 0 });
assert.deepEqual(parseStowResponse(JSON.stringify([accepted]), "1.2.3"), { stored: 1, failed: 0 });
assert.throws(() => parseStowResponse(JSON.stringify({ "00081198": sq(ref("1.2.3")) }), "1.2.3"), /reddetti/);
assert.throws(() => parseStowResponse(JSON.stringify({ ...accepted, "00081198": sq({}) }), "1.2.3"), /reddetti/);
for (const response of ["", "{", "{}", "[]", '[{} , {}]', JSON.stringify({ "00081199": sq({}) }), JSON.stringify({ "00081199": { Value: [ref("1.2.3")] } }), JSON.stringify({ "00081199": sq(ref("invalid")) }), JSON.stringify({ "00081199": sq(ref("1.2.3"), ref("1.2.4")) })]) {
  assert.throws(() => parseStowResponse(response, "1.2.3"), /doğrulanamadı/);
}
assert.throws(() => parseStowResponse(JSON.stringify(accepted), "1.2.4"), /doğrulanamadı/);
console.log("PASS STOW kabul, red, kısmi ve belirsiz yanıtlar");

import assert from "node:assert/strict";
import { SEED } from "../src/lib/templates";

async function main() {
  // Tohum şablonlar isim bazlı eşleştirilip eksiksiz ekleniyor; yinelenen ad olmamalı.
  const names = SEED.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "Tohum şablon adları benzersiz olmalı");

  for (const t of SEED) {
    assert.ok(t.modality.trim(), `${t.name}: modalite boş`);
    assert.ok(t.bodyPart.trim(), `${t.name}: bölge boş`);
    assert.ok(t.technique.trim().length > 8, `${t.name}: teknik metni çok kısa`);
    assert.ok(t.findings.trim().length > 20, `${t.name}: bulgu metni çok kısa`);
    assert.ok(t.impression.trim().length > 3, `${t.name}: izlenim eksik`);
  }

  // Kapsam: MR artık raporlanabilir; US/MG/NM gibi görüntüleme modaliteleri de var.
  const byModality = new Map<string, number>();
  for (const t of SEED) byModality.set(t.modality, (byModality.get(t.modality) ?? 0) + 1);
  assert.ok((byModality.get("MR") ?? 0) >= 10, `MR şablonu yetersiz: ${byModality.get("MR")}`);
  for (const m of ["CT", "CR", "MR", "US", "MG"]) {
    assert.ok((byModality.get(m) ?? 0) > 0, `${m} için en az bir şablon olmalı`);
  }
  console.log(`PASS tohum şablonlar: ${SEED.length} şablon, benzersiz ad, zorunlu alanlar dolu. Dağılım: ${[...byModality.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log("Tüm şablon testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });

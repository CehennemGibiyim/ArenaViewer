/** Yalnız ayrılmış CI PostgreSQL veritabanında çalıştırın. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

async function main() {
  if (process.env.AI_PERFORMANCE_INTEGRATION_TEST !== "1" || !process.env.DATABASE_URL) throw new Error("Ayrılmış test veritabanı ve AI_PERFORMANCE_INTEGRATION_TEST=1 gereklidir.");
  process.env.AUTH_MODE = "hesap";
  process.env.SESSION_SECRET = "ci-only-signing-secret-not-for-production";
  const { db, pool } = await import("../src/db/index");
  const { studies, reports, users } = await import("../src/db/schema");
  const { issueSessionCookie, SESSION_COOKIE } = await import("../src/lib/server/session");
  const { GET } = await import("../src/app/api/ai/performance/route");
  const token = randomUUID();
  const studyIds: number[] = [], userIds: number[] = [];
  const request = (uid?: number) => new NextRequest("http://localhost/api/ai/performance", uid ? { headers: { cookie: `${SESSION_COOKIE}=${issueSessionCookie(uid)}` } } : {});
  try {
    for (const role of ["radyolog", "teknisyen"]) {
      const [u] = await db.insert(users).values({ username: `${role}-${token}`, passwordHash: "-", fullName: "Test", role }).returning({ id: users.id });
      userIds.push(u.id);
    }
    assert.equal((await GET(request())).status, 401);
    assert.equal((await GET(request(userIds[1]))).status, 403);
    for (let i = 0; i < 2; i++) {
      const [s] = await db.insert(studies).values({ studyUid: `${token}.${i}`, modality: "CT", bodyPart: "HEAD", seriesDescription: "test" }).returning({ id: studies.id });
      studyIds.push(s.id);
    }
    const finding = (id: string, category = "Nodul", source = "ai-model") => ({ id, category, source });
    const base = { engine: `test-${token}`, aiModel: "model-A" };
    await db.insert(reports).values([
      { studyId: studyIds[0], ...base, status: "onaylandi", findingsJson: [finding("old")], findingsApproval: { old: "reddedildi" } },
      { studyId: studyIds[0], ...base, status: "taslak", findingsJson: [finding("a"), finding("b"), finding("c"), finding("d"), finding("m", "Hekim", "manual"), finding("system", "Sistem"), null], findingsApproval: { a: "onaylandi", b: "reddedildi", c: "duzenlendi" } },
      { studyId: studyIds[1], ...base, status: "onaylandi", aiModel: "model-B", findingsJson: [finding("e")], findingsApproval: { e: "onaylandi" } },
    ]);
    const response = await GET(request(userIds[0]));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    const rows = data.rows.filter((r: { engine: string }) => r.engine === base.engine);
    const a = rows.find((r: { model: string; category: string }) => r.model === "model-A" && r.category === "Nodul");
    assert.deepEqual([a.shown, a.approved, a.rejected, a.edited, a.pending, a.approvalShare], [4, 1, 1, 1, 1, .5]);
    assert.equal(rows.find((r: { category: string }) => r.category === "Hekim").manualAdded, 1);
    assert.equal(rows.find((r: { model: string }) => r.model === "model-B").approvalShare, 1);
    assert.equal(data.calibration.length, 0); assert.match(data.note, /klinik PPV|Klinik PPV/);
    assert.ok(data.draftReports >= 1);
    console.log("PASS PostgreSQL AI geri bildirim: yetki, son rapor, model, kararlar ve güvenli gösterim");
  } finally {
    for (const id of studyIds) await db.delete(studies).where(eq(studies.id, id));
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

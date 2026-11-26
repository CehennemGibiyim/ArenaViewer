/**
 * Tek bir DICOM örneğini şifreli depoya yazar (storage/upload ile dicomweb STOW-RS
 * alımı ortak yolu). Çift (çalışma içinde aynı sha256) atlanır.
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { storedFiles, studies } from "@/db/schema";
import { encryptBuffer } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";

export interface StoreInstanceResult {
  stored: boolean;
  duplicate: boolean;
  fileId: number | null;
  bytes: number;
}

export async function storeDicomInstance(studyId: number, name: string, bytes: Uint8Array): Promise<StoreInstanceResult> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dup = await db.select({ id: storedFiles.id }).from(storedFiles).where(and(eq(storedFiles.studyId, studyId), eq(storedFiles.sha256, sha))).limit(1);
  if (dup[0]) return { stored: false, duplicate: true, fileId: dup[0].id, bytes: bytes.length };
  const rel = path.join("dicom", String(studyId), `${randomUUID()}.bin`);
  await fileStorage().put(rel, encryptBuffer(Buffer.from(bytes)));
  const ins = await db.insert(storedFiles).values({ studyId, name: name.slice(0, 200), size: bytes.length, path: rel, sha256: sha }).returning({ id: storedFiles.id });
  await db
    .update(studies)
    .set({ hasFiles: true, updatedAt: new Date(), sliceCount: sql`${studies.sliceCount} + 1` })
    .where(eq(studies.id, studyId));
  return { stored: true, duplicate: false, fileId: ins[0]?.id ?? null, bytes: bytes.length };
}

/**
 * Orthanc E2E'leri için paylaşılan HTTP yardımcıları (temizlik vb.).
 * pacs-lazy.e2e.ts kullanır; pacs.orthanc.e2e.ts kendi satır içi sürümüyle çalışır (davranışı korunur).
 */

export function orthancAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

export function orthancReq(base: string, user: string, pass: string, path: string, init: RequestInit = {}): Promise<Response> {
  const auth = orthancAuth(user, pass);
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: auth, ...(init.headers as Record<string, string> | undefined) },
  });
}

/** StudyInstanceUID ile bulunan çalışmayı Orthanc'tan siler; kalan kayıt sayısını döndürür. */
export async function deleteStudyFromOrthanc(
  base: string,
  user: string,
  pass: string,
  studyUid: string,
): Promise<{ deleted: boolean; remaining: number }> {
  const lookup = await orthancReq(base, user, pass, "/tools/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
  });
  if (!lookup.ok) return { deleted: false, remaining: -1 };
  const studyIds = (await lookup.json()) as string[];
  const deleted = await Promise.all(studyIds.map((id) => orthancReq(base, user, pass, `/studies/${id}`, { method: "DELETE" })));
  const remainingRes = await orthancReq(base, user, pass, "/tools/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
  });
  const remaining = remainingRes.ok ? ((await remainingRes.json()) as string[]).length : -1;
  return { deleted: deleted.every((r) => r.ok), remaining };
}

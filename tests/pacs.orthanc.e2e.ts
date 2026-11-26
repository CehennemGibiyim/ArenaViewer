/**
 * Gerçek PACS (Orthanc) ile uçtan uca DICOMweb testi.
 *
 * Çalıştırma (CI veya yerel):
 *   ORTHANC_URL=http://localhost:8042 ORTHANC_USER=orthanc ORTHANC_PASS=orthanc \
 *     npx tsx tests/pacs.orthanc.e2e.ts
 *
 * ORTHANC_URL tanımlı değilse test ATLANIR (boş CI'da hata vermez).
 *
 * Senaryo: minimal geçerli bir DICOM yarat → STOW-RS ile yükle → QIDO-RS ile
 * ara/bul → WADO-RS ile geri al → temizlik için sil. Böylece okuma VE yazma
 * yönü de gerçek bir PACS üzerinde doğrulanır.
 */
import { randomInt } from "node:crypto";
import * as dicomParser from "dicom-parser";
import { parseMultipartRelated, qidoInstances, qidoStudies, stowInstance, wadoInstance } from "../src/lib/server/pacs";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";
import { minimalDicom } from "./dicomFactory";

const BASE = (process.env.ORTHANC_URL ?? "").replace(/\/$/, "");
const USER = process.env.ORTHANC_USER ?? "orthanc";
const PASS = process.env.ORTHANC_PASS ?? "orthanc";

if (!BASE) {
  console.log("ATLANDI: ORTHANC_URL tanımlı değil — gerçek PACS e2e testi çalıştırılmadı.");
  process.exit(0);
}

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const uid = (root: string) => `${root}.${randomInt(0, 1_000_000)}.${Date.now()}`;

// ───────── HTTP yardımcıları ─────────

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: auth, ...(init.headers as Record<string, string> | undefined) },
  });
}

const jget = async (path: string) => (await req(path)).json() as Promise<unknown>;

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

async function main() {
  const root = "1.2.826.0.1.3680043.8.498";
  const patientId = `ARENA-${Date.now()}`;
  const studyUid = uid(root);
  const seriesUid = uid(root);
  const sopUid = uid(root);
  const dcm = minimalDicom({ patientId, patientName: "E2E^PACIENT", studyUid, seriesUid, sopUid });

  ok(dcm.slice(128, 132).every((b, i) => b === "DICM".charCodeAt(i)), "minimal DICOM: DICM imzası var");
  const parsed = dicomParser.parseDicom(dcm);
  ok(parsed.string("x0020000d") === studyUid && parsed.string("x0020000e") === seriesUid && parsed.string("x00080018") === sopUid, "minimal DICOM: UID alanları okunabilir");

  try {
  // 1) Uygulamanın gerçek DICOMweb istemcisi üzerinden STOW, QIDO ve WADO.
  const cfg = { ...DEFAULT_PACS, name: "Orthanc E2E", qidoRoot: `${BASE}/dicom-web`, auth: { ...DEFAULT_PACS.auth, type: "basic" as const, username: USER, password: PASS } };
  const stow = await stowInstance(cfg, dcm);
  ok(stow.ok && stow.stored === 1 && stow.failed.length === 0, "Uygulama STOW: Orthanc kabul yanıtını doğruladı");
  const found = await qidoStudies(cfg, patientId);
  ok(found.some((study) => study.studyUid === studyUid && study.patientId === patientId), "Uygulama QIDO: doğru çalışma ve hasta kimliği");
  const appInstances = await qidoInstances(cfg, studyUid);
  ok(appInstances.some((item) => item.seriesUid === seriesUid && item.sopUid === sopUid), "Uygulama QIDO: seri ve SOP UID eşleşti");
  const retrieved = await wadoInstance(cfg, studyUid, seriesUid, sopUid);
  const retrievedDs = dicomParser.parseDicom(retrieved);
  ok(retrievedDs.string("x00080018") === sopUid && retrievedDs.string("x0020000d") === studyUid, "Uygulama WADO: doğru DICOM geri alındı");

  // 2) QIDO-RS: çalışmayı hasta kimliğiyle bul
  const studies = (await jget(`/dicom-web/studies?PatientID=${patientId}&includefield=all`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(studies) && studies.length >= 1, `QIDO-RS: yüklenen çalışma bulundu (${studies.length} sonuç)`);

  // 3) Seri ve instance listesi
  const series = (await jget(`/dicom-web/studies/${studyUid}/series`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(series) && series.length >= 1, "QIDO-RS: seri listesi alındı");
  const instances = (await jget(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(instances) && instances.length >= 1, "QIDO-RS: instance listesi alındı");

  // 4) WADO-RS: instance'ı geri al ve DICM imzasını doğrula
  const wado = await req(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`, {
    headers: { Accept: 'multipart/related; type="application/dicom"' },
  });
  if (wado.ok) {
    const body = new Uint8Array(await wado.arrayBuffer());
    const dicom = parseMultipartRelated(body, wado.headers.get("content-type") ?? "");
    ok(!!dicom && dicom.length > 132 && dicom.slice(128, 132).every((b, i) => b === "DICM".charCodeAt(i)), `WADO-RS: DICOM instance geri alındı (${dicom?.length ?? 0} bayt)`);
  } else {
    ok(false, `WADO-RS: instance alınamadı (${wado.status})`);
  }

  } finally {
  // Test hata verse de yalnızca bu testin StudyInstanceUID kaydını temizle.
  const lookup = await req("/tools/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
  });
  if (lookup.ok) {
    const studyIds = await lookup.json() as string[];
    const deleted = await Promise.all(studyIds.map((id) => req(`/studies/${id}`, { method: "DELETE" })));
    const remaining = await req("/tools/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
    });
    const remainingIds = remaining.ok ? await remaining.json() as string[] : [studyUid];
    ok(deleted.every((response) => response.ok) && remainingIds.length === 0, "Temizlik: çalışma silindi");
  } else {
    ok(false, `Temizlik: Orthanc çalışma kimliği bulunamadı (${lookup.status})`);
  }
  }

  if (failed) { console.error(`${failed} Orthanc e2e adımı başarısız`); process.exit(1); }
  console.log("Tüm Orthanc uçtan uca testleri geçti.");
}

main().catch((e) => { console.error("Orthanc e2e hatası:", e instanceof Error ? e.message : e); process.exit(1); });

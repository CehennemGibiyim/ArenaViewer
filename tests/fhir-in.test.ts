/** FHIR girişi (e-fhir-in) testleri — ServiceRequest/ImagingStudy → sipariş. */
import {
  fhirReferenceId,
  fhirResourcesToOrders,
  fhirToStudyDate,
  guessModalityText,
  imagingStudyToOrder,
  mergeFhirPair,
  modalityFromFhir,
  patientFromFhir,
  serviceRequestToOrder,
} from "../src/lib/fhirIn";
import { coerceFhirConfig, fhirHeaders, fhirQueryUrl } from "../src/lib/server/fhirRepo";
import { cfgFromEnv, pullOnce, validateEnv } from "../scripts/fhir-pull";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

async function main(): Promise<void> {

const SR = {
  resourceType: "ServiceRequest",
  id: "SR-77",
  identifier: [{ value: "ACC-7701" }],
  status: "active",
  intent: "order",
  patient: { identifier: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", value: "PID-55" }] },
  code: { coding: [{ system: "http://snomed.info/sct", code: "71045" }], text: "BEYIN CT" },
  bodySite: [{ text: "BEYIN" }],
  occurrenceDateTime: "2026-03-14T09:30:00+03:00",
  reasonReference: [{ reference: "DiagnosticReport/DR-1" }],
};

const IMG = {
  resourceType: "ImagingStudy",
  id: "IMG-77",
  status: "available",
  subject: { reference: "Patient/PID-55", identifier: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", value: "PID-55" }] },
  modality: "CT",
  identifier: [
    { system: "urn:dicom:uid", value: "1.2.840.113619.2.55.3.2831200230.843" },
    { system: "urn:oid:1.2.840.113619.2.55.3.2831200230.843", value: "ACC-7701" },
  ],
  bodySite: [{ text: "BEYIN" }],
};

// ── 1. ServiceRequest ayrıştırma ──
{
  const o = serviceRequestToOrder(SR);
  ok(o !== null, "ServiceRequest sipariş üretildi");
  ok(o?.patientId === "PID-55" && o?.patientName === "PID-55", `Hasta kimliği ${o?.patientId}`);
  ok(o?.accessionNumber === "ACC-7701", `Accession ${o?.accessionNumber}`);
  ok(o?.modality === "CT", `Modalite ${o?.modality}`);
  ok(o?.bodyPart === "BEYIN", `Vücut bölgesi ${o?.bodyPart}`);
  ok(o?.studyDate === "20260314", `Tarih ${o?.studyDate}`);
  ok(o?.studyUid === "fhir.ACC-7701" && o?.fhirSource === "ServiceRequest/SR-77", `Study UID + kaynak ${o?.studyUid}/${o?.fhirSource}`);
  ok(!!o?.warnings.some((w) => /71045/.test(w)), "SNOMED modalite kodu bilinmez → uyarı üretilir (tahmin yok)");
  ok(!(o?.warnings.some((w) => /accession|hasta kimlik|modalite yok/.test(w)) ?? false), "uyarı yalnız modalite kodu ile sınırlı");
}

// ── 2. Eksik/geçersiz sipariş red ──
{
  const noPid = serviceRequestToOrder({ ...SR, patient: {} });
  ok(noPid === null, "identifier olmayan ServiceRequest reddedilir");
  const noAccession = serviceRequestToOrder({ ...SR, identifier: [] });
  ok(noAccession === null, "accessionNumber olmayan sipariş reddedilir");
  const badDate = serviceRequestToOrder({ ...SR, occurrenceDateTime: "2026-13-40T99:99:99" });
  ok(badDate !== null && badDate.studyDate === undefined, "geçersiz tarih sessizce atlanır (studyDate boş)");
}

// ── 3. ImagingStudy → çalışma ──
{
  const o = imagingStudyToOrder(IMG);
  ok(o !== null, "ImagingStudy sipariş üretildi");
  ok(o?.studyUid === "1.2.840.113619.2.55.3.2831200230.843", `UID ${o?.studyUid}`);
  ok(o?.patientId === "PID-55", "ImagingStudy hasta kimliği");
  ok(o?.modality === "CT", `ImagingStudy modalite ${o?.modality}`);
  ok(o?.accessionNumber === "ACC-7701", "accession identifier'den alınır");
  const noUid = imagingStudyToOrder({ ...IMG, identifier: [], imagingStudyUid: undefined });
  ok(noUid === null, "UID olmayan ImagingStudy reddedilir");
}

// ── 4. Bundle + birleştirme ──
{
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: SR }, { resource: IMG }],
  };
  const orders = fhirResourcesToOrders(bundle);
  ok(orders.length === 2, `Bundle'dan ${orders.length} aday çıkarıldı`);
  const merged = mergeFhirPair(SR, IMG);
  ok(merged !== null && merged.studyUid === "1.2.840.113619.2.55.3.2831200230.843", "ServiceRequest+ImagingStudy birleştirilir (UID ImagingStudy'den)");
  ok(merged?.accessionNumber === "ACC-7701" && merged?.modality === "CT", "birleştirme accession + modalite taşır");
  ok(fhirResourcesToOrders({ resourceType: "Patient", id: "P-1" }).length === 0, "Patient kaynağı sipariş üretmez");
  ok(fhirResourcesToOrders("boş").length === 0, "geçersiz girdi güvenle boş");
  ok(fhirResourcesToOrders(IMG).length === 1, "tek ImagingStudy kaynağı da kabul edilir");
}

// ── 5. Yardımcı sözleşme ──
{
  ok(fhirToStudyDate("2026-03-14T09:30:00+03:00") === "20260314", "tarih/saat → YYYYMMDD");
  ok(fhirToStudyDate("2026-02-31T00:00:00Z") === "", "ayın 31'i geçersiz");
  ok(fhirToStudyDate("202602") === "", "kısık tarih geçersiz");
  ok(guessModalityText("BEYIN BT (CT)") === "CT", "metinden modalite");
  ok(guessModalityText("aBDüYIN") === "", "tanımsız metin modalite vermez");
  ok(fhirReferenceId("Patient/P-9") === "P-9", "reference ID");
  ok(modalityFromFhir("CT") === "CT" && modalityFromFhir([{ code: "MR" }]) === "MR", "modalite kodu");
  ok(modalityFromFhir([{ code: "BILENMEZ" }]) === "", "bilinmeyen modalite boş (tahmin yok)");
  ok(patientFromFhir({ name: [{ given: ["Ahmet"], family: "Yılmaz" }], identifier: [{ value: "X1" }] }).patientName === "Ahmet Yılmaz", "HumanName → " + patientFromFhir({ name: [{ given: ["Ahmet"], family: "Yılmaz" }], identifier: [{ value: "X1" }] }).patientName);
}

// ── 6. FHIR ucu sözleşmesi ──
{
  const cfg = coerceFhirConfig({ baseUrl: "https://fhir.kurum/fhir/r4/", token: "tok", timeoutMs: 0 });
  ok(cfg !== null && cfg.baseUrl === "https://fhir.kurum/fhir/r4", "kök trailing slash kapatılır");
  ok(cfg?.timeoutMs === 15000, "timeout geçersizse varsayılan");
  ok(coerceFhirConfig({ baseUrl: "ftp://x" })?.baseUrl === "", "ftp kökü reddedilir");
  const headers = fhirHeaders({ baseUrl: "x", token: "t1", username: "", password: "", timeoutMs: 1, defaultModality: "" });
  ok(headers.Authorization === "Bearer t1", "Bearer header");
  const basic = fhirHeaders({ baseUrl: "x", token: "", username: "a", password: "b", timeoutMs: 1, defaultModality: "" });
  ok(basic.Authorization === "Basic " + Buffer.from("a:b").toString("base64"), "Basic header");
  const url = fhirQueryUrl("https://fhir.kurum/fhir/r4", "ServiceRequest");
  ok(url.includes("type=ServiceRequest") && url.includes("_count=200"), "çekim URL parametreleri");
}

// ── 7. Köprü çekimi — gerçek fetch (mock) ──
{
  process.env.HIS_BASE_URL = "http://127.0.0.1:3999";
  process.env.HIS_API_KEY = "k";
  const cfg = cfgFromEnv();
  ok(validateEnv({ ...cfg, baseUrl: "https://f.example/r4", token: "t" }) === null, "token ile yapılandırma geçerli");
  ok(validateEnv({ ...cfg, baseUrl: "https://f.example/r4", token: "", username: "" })?.includes("FHIR_TOKEN") === true, "kimlik yok → hata");

  const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined, headers: init?.headers as Record<string, string> | undefined });
    if (url.includes("/api/his/fhir")) {
      const body = JSON.parse(init?.body as string);
      const sr = body.entry?.[0]?.resource;
      return new Response(JSON.stringify({ ok: true, accepted: sr ? 1 : 0, created: sr ? 1 : 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // FHIR sunucusu: ServiceRequest bundle + ImagingStudy single
    if (url.includes("type=ServiceRequest")) {
      return new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [{ resource: SR }] }), { status: 200, headers: { "content-type": "application/fhir+json" } });
    }
    return new Response(JSON.stringify(IMG), { status: 200, headers: { "content-type": "application/fhir+json" } });
  }) as typeof fetch;

  const r = await pullOnce({ ...cfg, baseUrl: "https://f.example/r4", token: "tok", timeoutMs: 5000, defaultModality: "" }, () => {});
  globalThis.fetch = origFetch;
  ok(r.ok, `köprü çekimi başarılı (${r.error ?? ""})`);
  const pushes = calls.filter((c) => c.url.includes("/api/his/fhir"));
  ok(pushes.length === 2, `uç 2 kez çağrıldı (${pushes.length})`);
  const push = pushes[0];
  ok(push?.headers?.["x-api-key"] === "k", "push x-api-key ile geliyor");
  const pushed = JSON.parse(push?.body ?? "null");
  ok(pushed?.entry?.[0]?.resource?.resourceType === "ServiceRequest", "ServiceRequest bundle'ı gerçeküstü olarak iletilir");
  ok(calls.filter((c) => c.url.includes("type=ServiceRequest")).length === 1, "ServiceRequest çekim URL'si");
  ok(calls.filter((c) => c.url.includes("type=ImagingStudy")).length === 1, "ImagingStudy çekim URL'si");
}

// ── 8. Köprü hata yönetimi ──
{
  const cfg = { baseUrl: "https://f.example/r4", token: "tok", username: "", password: "", timeoutMs: 5000, defaultModality: "" };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  const r = await pullOnce(cfg, () => {});
  globalThis.fetch = origFetch;
  ok(!r.ok && /kimlik/.test(r.error ?? ""), `401 → kimlik hatası (${r.error})`);
}

}

void main().then(() => {
  if (failed > 0) {
    console.error(`\nfhir-in: FAIL (${failed} kaldı)`);
    process.exit(1);
  }
  console.log(`\nfhir-in: PASS (${""}tüm assert geçti)`);
});

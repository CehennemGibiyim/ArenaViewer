"use client";

/**
 * GitHub Pages (statik demo): sunucu ve veritabanı yoktur. Bu modül /api/* isteklerini
 * ağa göndermeden TARAYICI İÇİNDE karşılar:
 *   - /api/analyze            → src/lib/analyze.ts (sunucudakiyle aynı saf fonksiyon)
 *   - /api/reports*           → rapor kaydı/onayı/addendum, tarayıcının localStorage'ında
 *   - /api/state              → ölçümler ve anahtar kesitler, localStorage
 *   - /api/reports/draft-impression → kural tabanlı izlenim taslağı
 * Diğer uçlar (çalışma listesi, PACS, yönetim, depolama) 503 döner.
 * Veriler yalnızca bu tarayıcıda kalır, hiçbir yere gönderilmez.
 * Yalnızca scripts/prepare-pages.sh tarafından Pages derlemesine eklenir.
 */
import type { AnalyzeBody } from "@/lib/analyze";
import { missingReviewReasons, sanitizeReviewReasons } from "@/lib/findingReview";
import type { Finding, FindingApprovalStatus, SavedReport } from "@/lib/types";
import { parseReportSnapshot } from "@/lib/reportDiff";

const OPERATOR = { fullName: "Demo Radyolog", title: "Uzm. Dr.", regNo: "" };
const K_REPORTS = "atik-demo-reports";
const K_ADDENDA = "atik-demo-addenda";
const K_STATE = "atik-demo-state:";
const K_TEMPLATES = "atik-demo-templates";
const K_VERSIONS = "atik-demo-report-versions";
const K_SIGS = "atik-demo-signatures";

interface DemoVersion { id: number; versionNo: number; action: string; createdByName: string; createdAt: string; snapshot: string | null }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fail = (error: string, status = 400) => json({ error }, status);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SaveBody {
  reportId?: number;
  action?: "save" | "approve";
  study: { studyUid: string; patientName: string; patientId: string; patientAge: string; patientSex: string; studyDate: string; institution: string; modality: string; bodyPart: string; seriesDescription: string; sliceCount: number };
  report: {
    mode: string; clinicalInfo: string; technique: string; findingsText: string; impression: string; recommendation: string;
    findingsJson: Finding[]; findingsApproval: Record<string, FindingApprovalStatus>;
    findingsReason?: Record<string, string>;
    triageLevel: string; triageScore: number; aiModel: string; engine: string; modelCard: string; keyImageDataUrl: string; institution?: string;
  };
}

async function handleReportSave(body: SaveBody): Promise<Response> {
  if (!body?.study?.studyUid || !body.report) return fail("Eksik veri");
  const r = body.report;
  const findings = Array.isArray(r.findingsJson) ? r.findingsJson : [];
  const approvals = r.findingsApproval ?? {};
  const reasons = sanitizeReviewReasons(r.findingsReason, approvals);
  const approve = body.action === "approve";
  const all = load<SavedReport[]>(K_REPORTS, []);
  const current = body.reportId ? all.find((x) => x.id === body.reportId) : undefined;
  if (body.reportId && !current) return fail("Rapor bulunamadı", 404);
  if (current?.status === "onaylandi") return fail("Onaylı rapor değiştirilemez. Düzeltme için addendum ekleyin.", 409);

  let approvedAt: string | null = null;
  if (approve) {
    const pending = findings.filter((f) => (approvals[f.id] ?? "bekliyor") === "bekliyor").length;
    if (pending > 0) return fail(`${pending} bulgu henüz gözden geçirilmedi`);
    const missing = missingReviewReasons(findings, approvals, reasons);
    if (missing.length > 0) return fail(`Reddedilen/düzenlenen ${missing.length} bulgu için gerekçe yazılmalı`);
    approvedAt = new Date().toISOString();
  }
  const version = (current?.version ?? 0) + 1;
  let contentHash = "";
  let signatureMeta = "";
  if (approve && approvedAt) {
    contentHash = await sha256(JSON.stringify({ studyUid: body.study.studyUid, technique: r.technique, findingsText: r.findingsText, impression: r.impression, recommendation: r.recommendation, approvals, version, approvedAt }));
    signatureMeta = JSON.stringify({ algo: "SHA-256", method: "Statik demo — tarayıcıda yerel onay", signer: OPERATOR, signedAt: approvedAt, note: "Bu onay kimlik doğrulamaz ve nitelikli elektronik imza değildir." });
  }
  const now = new Date().toISOString();
  const id = current?.id ?? (all.reduce((m, x) => Math.max(m, x.id), 0) + 1);
  const row: SavedReport = {
    id, studyId: id, status: approve ? "onaylandi" : "taslak", version, mode: r.mode,
    clinicalInfo: r.clinicalInfo ?? "", technique: r.technique, findingsText: r.findingsText, impression: r.impression, recommendation: r.recommendation,
    findingsJson: findings, findingsApproval: approvals, findingsReason: reasons, triageLevel: r.triageLevel, triageScore: r.triageScore, aiModel: r.aiModel, engine: r.engine, modelCard: r.modelCard,
    approvedBy: approve ? OPERATOR.fullName : "", doctorTitle: approve ? OPERATOR.title : "", doctorRegNo: approve ? OPERATOR.regNo : "",
    institution: r.institution ?? body.study.institution ?? "", approvedAt, contentHash, signatureMeta,
    keyImageDataUrl: r.keyImageDataUrl ?? "", createdAt: current?.createdAt ?? now, updatedAt: now,
    patientName: body.study.patientName, patientId: body.study.patientId, patientAge: body.study.patientAge, patientSex: body.study.patientSex,
    studyDate: body.study.studyDate, studyUid: body.study.studyUid, modality: body.study.modality, bodyPart: body.study.bodyPart, seriesDescription: body.study.seriesDescription,
  } as SavedReport;
  // Sürüm geçmişi (diff + geri yükleme) — sunucu tarafıyla aynı anlık görüntü biçimi (v2).
  const versions = load<Record<string, DemoVersion[]>>(K_VERSIONS, {});
  const list = versions[id] ?? [];
  list.push({
    id: list.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    versionNo: version,
    action: approve ? "onay" : "kayıt",
    createdByName: `${OPERATOR.title} ${OPERATOR.fullName}`,
    createdAt: now,
    snapshot: JSON.stringify({
      status: row.status, technique: r.technique, findingsText: r.findingsText, impression: r.impression,
      recommendation: r.recommendation, findings: findings.map((f) => ({ id: f.id, label: f.label, slice: f.keySliceNumber, severity: f.severity })),
      approvals, reasons, engine: r.engine, findingsJson: findings,
    }),
  });
  versions[id] = list.slice(-50);
  save(K_VERSIONS, versions);
  const next = current ? all.map((x) => (x.id === id ? row : x)) : [row, ...all];
  // Kota dolarsa anahtar kesit görüntüleri atılıp yeniden denenir.
  if (!save(K_REPORTS, next)) {
    const slim = next.map((x) => ({ ...x, keyImageDataUrl: x.id === id ? x.keyImageDataUrl : "" }));
    if (!save(K_REPORTS, slim)) {
      const slimmer = slim.map((x) => ({ ...x, keyImageDataUrl: "" }));
      if (!save(K_REPORTS, slimmer)) return fail("Tarayıcı depolama alanı dolu; eski raporları silin.", 507);
    }
  }
  return json({ ok: true, reportId: id, studyId: id, status: row.status, version, contentHash, approvedAt, approvedBy: row.approvedBy, doctorTitle: row.doctorTitle, doctorRegNo: row.doctorRegNo });
}

async function route(method: string, url: URL, init?: RequestInit): Promise<Response | null> {
  const p = url.pathname.replace(/\/+$/, "");
  const body = async <T,>(): Promise<T | null> => {
    try { return JSON.parse(String(init?.body ?? "")) as T; } catch { return null; }
  };

  if (p === "/api/analyze" && method === "POST") {
    const b = await body<AnalyzeBody>();
    if (!b) return fail("Geçersiz istek");
    const { buildAnalysis } = await import("@/lib/analyze");
    const out = buildAnalysis(b);
    return out.ok ? json(out.result) : fail(out.error);
  }

  if (p === "/api/reports" && method === "GET") {
    let rows = load<SavedReport[]>(K_REPORTS, []).map((x) => ({ ...x, keyImageDataUrl: "" }));
    const pid = url.searchParams.get("patientId");
    const uid = url.searchParams.get("studyUid");
    if (pid) rows = rows.filter((x) => x.patientId === pid);
    if (uid) rows = rows.filter((x) => x.studyUid === uid);
    return json(rows.slice(0, 100));
  }
  if (p === "/api/reports" && method === "POST") {
    const b = await body<SaveBody>();
    return b ? handleReportSave(b) : fail("Geçersiz istek");
  }
  if (p === "/api/reports/draft-impression" && method === "POST") {
    const b = await body<{ findings?: { label: string; slice: number; category: string; status: string }[] }>();
    const verified = (b?.findings ?? []).filter((f) => (f.status === "onaylandi" || f.status === "duzenlendi") && f.category !== "Sistem" && f.category !== "ROI");
    if (verified.length === 0) return fail("Önce en az bir bulguyu 'Onayla/Düzenlendi' olarak işaretleyin");
    return json({ text: `${verified.map((f, i) => `${i + 1}) ${f.label} (Kesit ${f.slice})`).join("; ")}. Klinik korelasyon önerilir.`, source: "kural" });
  }
  const fh = /^\/api\/reports\/(\d+)\/fhir$/.exec(p);
  if (fh && method === "GET") {
    const rep = load<SavedReport[]>(K_REPORTS, []).find((x) => x.id === Number(fh[1]));
    if (!rep) return fail("Rapor bulunamadı", 404);
    const { buildFhirReport } = await import("@/lib/fhir");
    return new Response(JSON.stringify(buildFhirReport(rep), null, 2), { headers: { "Content-Type": "application/fhir+json; charset=utf-8" } });
  }
  const m = /^\/api\/reports\/(\d+)(\/addenda|\/restore|\/signature)?$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    const all = load<SavedReport[]>(K_REPORTS, []);
    const rep = all.find((x) => x.id === id);
    const addenda = load<Record<string, { id: number; text: string; createdByName: string; createdAt: string }[]>>(K_ADDENDA, {});
    if (!m[2] && method === "GET") {
      if (!rep) return fail("Rapor bulunamadı", 404);
      const stored = load<Record<string, DemoVersion[]>>(K_VERSIONS, {})[id];
      const versions = stored && stored.length
        ? stored.slice().sort((a, b) => b.versionNo - a.versionNo)
        : Array.from({ length: rep.version }, (_, i) => ({ id: i + 1, versionNo: rep.version - i, action: i === 0 && rep.status === "onaylandi" ? "onay" : "kayıt", createdByName: OPERATOR.fullName, createdAt: rep.updatedAt, snapshot: null as string | null }));
      return json({ report: rep, versions, addenda: (addenda[id] ?? []).slice().reverse() });
    }
    if (m[2] === "/addenda" && method === "POST") {
      const b = await body<{ text?: string }>();
      const text = (b?.text ?? "").trim();
      if (text.length < 3 || text.length > 4000) return fail("Addendum metni 3–4000 karakter olmalı");
      if (!rep) return fail("Rapor bulunamadı", 404);
      if (rep.status !== "onaylandi") return fail("Addendum yalnızca onaylı rapora eklenir; taslağı doğrudan düzenleyin");
      const list = addenda[id] ?? [];
      list.push({ id: list.length + 1, text, createdByName: `${OPERATOR.title} ${OPERATOR.fullName}`, createdAt: new Date().toISOString() });
      addenda[id] = list;
      save(K_ADDENDA, addenda);
      return json({ ok: true, id: list.length });
    }
    if (m[2] === "/restore" && method === "POST") {
      const b = await body<{ versionNo?: number }>();
      if (!rep) return fail("Rapor bulunamadı", 404);
      if (rep.status === "onaylandi") return fail("Onaylı rapor geri yüklenemez. Düzeltme için addendum ekleyin.", 409);
      const versionNo = Number(b?.versionNo);
      const stored = load<Record<string, DemoVersion[]>>(K_VERSIONS, {})[id] ?? [];
      const target = stored.find((v) => v.versionNo === versionNo);
      if (!target) return fail("Sürüm bulunamadı", 404);
      const snap = parseReportSnapshot(target.snapshot);
      if (!snap) return fail("Bu sürümün anlık görüntüsü okunamadı; geri yükleme yapılamaz.", 409);
      const hasFindings = Array.isArray(snap.findingsJson);
      const findingsJson = (hasFindings ? snap.findingsJson : rep.findingsJson) as Finding[];
      const approvals = (snap.approvals && typeof snap.approvals === "object" && !Array.isArray(snap.approvals) ? snap.approvals : rep.findingsApproval) as Record<string, FindingApprovalStatus>;
      const reasons = (snap.reasons && typeof snap.reasons === "object" && !Array.isArray(snap.reasons) ? snap.reasons : rep.findingsReason) as Record<string, string>;
      const now2 = new Date().toISOString();
      const newVersion = (rep.version ?? 0) + 1;
      const updated: SavedReport = {
        ...rep, status: "taslak", version: newVersion,
        technique: String(snap.technique ?? ""), findingsText: String(snap.findingsText ?? ""),
        impression: String(snap.impression ?? ""), recommendation: String(snap.recommendation ?? ""),
        findingsJson, findingsApproval: approvals, findingsReason: reasons,
        engine: String(snap.engine ?? rep.engine),
        approvedBy: "", doctorTitle: "", doctorRegNo: "", approvedAt: null, contentHash: "", signatureMeta: "",
        updatedAt: now2,
      } as SavedReport;
      const next = all.map((x) => (x.id === id ? updated : x));
      save(K_REPORTS, next);
      stored.push({
        id: stored.reduce((mm, x) => Math.max(mm, x.id), 0) + 1,
        versionNo: newVersion, action: "geri-yükleme", createdByName: `${OPERATOR.title} ${OPERATOR.fullName}`, createdAt: now2,
        snapshot: JSON.stringify({
          status: "taslak", technique: updated.technique, findingsText: updated.findingsText,
          impression: updated.impression, recommendation: updated.recommendation,
          findings: findingsJson.map((f) => ({ id: f.id, label: f.label, slice: f.keySliceNumber, severity: f.severity })),
          approvals, reasons, engine: updated.engine, findingsJson, restoredFrom: versionNo,
        }),
      });
      const versionsNow = load<Record<string, DemoVersion[]>>(K_VERSIONS, {});
      versionsNow[id] = stored.slice(-50);
      save(K_VERSIONS, versionsNow);
      return json({
        ok: true, version: newVersion, restoredFrom: versionNo,
        technique: updated.technique, findingsText: updated.findingsText, impression: updated.impression, recommendation: updated.recommendation,
        findingsJson, findingsApproval: approvals, findingsReason: reasons, engine: updated.engine,
        findingsPreserved: !hasFindings,
      });
    }
    if (m[2] === "/signature" && (method === "GET" || method === "POST")) {
      // Statik demo imza kaydı: yalnızca tarayıcıdaki denetim izidir; nitelikli imza değildir.
      const sigs = load<Record<string, (Record<string, unknown> & { addendumId?: number })[]>>(K_SIGS, {});
      const list = sigs[id] ?? [];
      if (method === "GET") return json({ qualifiedAvailable: false, records: list });
      if (!rep) return fail("Rapor bulunamadı", 404);
      const b = await body<{ method?: string; addendumId?: number }>();
      const addendumId = b?.addendumId === undefined || b.addendumId === null ? null : Number(b.addendumId);
      let contentHash: string;
      if (addendumId !== null) {
        const adden = (addenda[id] ?? []).find((x) => x.id === addendumId);
        if (!adden) return fail("Ek bulunamadı", 404);
        contentHash = await sha256(JSON.stringify({ reportId: id, addendumId, text: adden.text }));
      } else {
        if (!rep.contentHash) return fail("İmzalanacak onaylı içerik yok (rapor henüz onaylanmadı).", 409);
        contentHash = rep.contentHash;
      }
      const record = {
        reportId: id, studyUid: rep.studyUid, contentHash,
        signerName: OPERATOR.fullName, signerRegNo: OPERATOR.regNo, institution: rep.institution ?? "",
        method: "dahili-anahtar", version: rep.version ?? 0,
        ...(addendumId !== null ? { addendumId } : {}),
        algo: "SHA-256", signedAt: new Date().toISOString(),
      };
      list.push(record);
      sigs[id] = list;
      save(K_SIGS, sigs);
      return json({ record, qualified: false, note: "Statik demo: kayıt yalnız bu tarayıcıda tutulur; NES değildir." });
    }
  }

  if (p === "/api/state") {
    const key = K_STATE + (url.searchParams.get("studyUid") ?? "") + "|" + (url.searchParams.get("seriesKey") ?? "");
    if (method === "GET") return json(load(key, { annotations: [], keyImages: [] }));
    if (method === "PUT") {
      const b = await body<{ studyUid?: string; seriesKey?: string; annotations?: unknown[]; keyImages?: unknown[] }>();
      if (!b?.studyUid || !b.seriesKey) return fail("Eksik veri");
      save(K_STATE + b.studyUid + "|" + b.seriesKey, { annotations: b.annotations ?? [], keyImages: b.keyImages ?? [] });
      return json({ ok: true });
    }
  }

  if (p === "/api/templates") {
    const { SEED } = await import("@/lib/templates");
    const seeded = SEED.map((t, i) => ({ id: i + 1, ...t }));
    const custom = load<{ id: number; name: string; modality: string; bodyPart: string; technique: string; findings: string; impression: string; recommendation: string }[]>(K_TEMPLATES, []);
    if (method === "GET") return json([...seeded, ...custom]);
    if (method === "POST") {
      const b = await body<Record<string, string>>();
      if (!b?.name?.trim()) return fail("Şablon adı gerekli");
      const id = custom.reduce((m, x) => Math.max(m, x.id), 1000) + 1;
      custom.push({ id, name: b.name.trim().slice(0, 120), modality: b.modality ?? "", bodyPart: b.bodyPart ?? "", technique: b.technique ?? "", findings: b.findings ?? "", impression: b.impression ?? "", recommendation: b.recommendation ?? "" });
      save(K_TEMPLATES, custom);
      return json({ ok: true, id });
    }
    if (method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (id <= 1000) return fail("Hazır şablonlar silinemez", 403);
      save(K_TEMPLATES, custom.filter((x) => x.id !== id));
      return json({ ok: true });
    }
  }
  if (p === "/api/triage-queue" && method === "GET") return fail("AI triaj kuyruğu sunucu gerektirir; statik demoda kullanılamaz", 503);
  if ((p === "/api/studies" || p === "/api/notifications") && method === "GET") return json([]);
  return null;
}

if (typeof window !== "undefined" && !(window as unknown as { __apiShim?: boolean }).__apiShim) {
  (window as unknown as { __apiShim?: boolean }).__apiShim = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^\/api\//.test(raw)) {
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      try {
        const res = await route(method, new URL(raw, window.location.origin), init);
        if (res) return res;
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Yerel işlem hatası", 500);
      }
      return fail("Statik demo: bu özellik sunucu gerektirir", 503);
    }
    return orig(input, init);
  };
}

export default function StaticApiShim() {
  return null;
}

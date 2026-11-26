/**
 * Rapor sürüm farkı (r-version) — saf, istemci/sunucu ortak.
 *
 * LCS tabanlı satır farkı; ortak ön/son ekler kırpıldıktan sonra ortadaki
 * bölüm DP ile hizalanır. Patolojik büyüklüklerde (satır sayısı çarpımı
 * > 4M) tüm değişen bloğu del/add çifti olarak basar (hesaplama kilidi olmaz;
 * sonuç yine doğru, yalnız granülerlik kaybolur).
 *
 * Anlık görüntü (snapshot) biçimi: report_versions.snapshot sütunundaki JSON.
 * Eski sürümlerde `findingsJson` olmayabilir; çağıran bunu kontrol etmelidir.
 */
export interface DiffLine { type: "same" | "add" | "del"; text: string }
export interface FieldDiff { field: string; label: string; lines: DiffLine[]; changed: boolean }

const norm = (t: string | null | undefined) => (t ?? "").replace(/\r\n/g, "\n");

export function diffTextLines(a: string, b: string): DiffLine[] {
  const A = norm(a).split("\n");
  const B = norm(b).split("\n");
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const midA = A.slice(start, endA), midB = B.slice(start, endB);
  const out: DiffLine[] = A.slice(0, start).map((text) => ({ type: "same" as const, text }));
  if (midA.length * midB.length > 4_000_000) {
    out.push(...midA.map((text) => ({ type: "del" as const, text })));
    out.push(...midB.map((text) => ({ type: "add" as const, text })));
  } else {
    const m = midA.length, n = midB.length;
    const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) { out.push({ type: "same", text: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: midA[i] }); i++; }
      else { out.push({ type: "add", text: midB[j] }); j++; }
    }
    while (i < m) out.push({ type: "del", text: midA[i++] });
    while (j < n) out.push({ type: "add", text: midB[j++] });
  }
  out.push(...A.slice(endA).map((text) => ({ type: "same" as const, text })));
  return out;
}

export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.type === "add") added++; else if (l.type === "del") removed++; }
  return { added, removed };
}

export interface ReportSnapshotLike {
  status?: string;
  technique?: string;
  findingsText?: string;
  impression?: string;
  recommendation?: string;
  approvals?: unknown;
  reasons?: unknown;
  engine?: string;
  /** Tam bulgu dizisi (yalnız yeni anlık görüntülerde). */
  findingsJson?: unknown;
  [k: string]: unknown;
}

/** report_versions.snapshot metnini güvenle çözer; bozuksa null döner. */
export function parseReportSnapshot(raw: string | null | undefined): ReportSnapshotLike | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as ReportSnapshotLike;
    return null;
  } catch {
    return null;
  }
}

const FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["technique", "Teknik"],
  ["findingsText", "Bulgular"],
  ["impression", "İzlenim"],
  ["recommendation", "Öneri"],
];

/** İki anlık görüntü arasında alan alan fark; yalnız değişen/değişmeyen bilgisi veren satır dizisi. */
export function diffReportSnapshots(a: ReportSnapshotLike | null, b: ReportSnapshotLike | null): FieldDiff[] {
  return FIELDS.map(([field, label]) => {
    const lines = diffTextLines(String(a?.[field] ?? ""), String(b?.[field] ?? ""));
    return { field, label, lines, changed: lines.some((l) => l.type !== "same") };
  });
}

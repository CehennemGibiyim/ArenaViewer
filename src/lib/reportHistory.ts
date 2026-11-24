export interface ReportHistoryFilter {
  patientId?: string | null;
  studyUid?: string | null;
}

export function reportHistoryQueryLimit(filter: ReportHistoryFilter): number | null {
  if (filter.patientId && !filter.studyUid) return null;
  return filter.studyUid ? 100 : 300;
}

export function selectReportHistory<T extends { patientId: string; studyUid: string }>(
  reports: T[],
  filter: ReportHistoryFilter,
  limit = 100
): T[] {
  const matching = reports.filter(
    (report) =>
      (!filter.patientId || report.patientId === filter.patientId) &&
      (!filter.studyUid || report.studyUid === filter.studyUid)
  );
  return matching.slice(0, limit);
}

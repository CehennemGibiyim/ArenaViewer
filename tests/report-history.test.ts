import assert from "node:assert/strict";
import { reportHistoryQueryLimit, selectReportHistory } from "../src/lib/reportHistory";

const reports = Array.from({ length: 350 }, (_, index) => ({
  id: index + 1,
  patientId: "other-patient",
  studyUid: `study-${index + 1}`,
}));
const olderPatientReport = {
  id: 351,
  patientId: "requested-patient",
  studyUid: "older-study",
};
reports.push(olderPatientReport);

const patientFilter = { patientId: "requested-patient" };
const patientLimit = reportHistoryQueryLimit(patientFilter);
const queriedReports = patientLimit === null ? reports : reports.slice(0, patientLimit);
assert.deepEqual(
  selectReportHistory(queriedReports, patientFilter),
  [olderPatientReport],
  "hasta filtresi en yeni 300 kaydın dışındaki raporları da bulmalı"
);
assert.equal(reportHistoryQueryLimit({}), 300, "filtrelenmemiş liste 300 kayıtla sınırlı kalmalı");
assert.equal(reportHistoryQueryLimit({ studyUid: "older-study" }), 100, "tetkik sorgusu 100 kayıtla sınırlı kalmalı");
assert.deepEqual(
  selectReportHistory(reports, { studyUid: "older-study" }),
  [olderPatientReport],
  "tetkik filtresi eşleşen raporu döndürmeli"
);

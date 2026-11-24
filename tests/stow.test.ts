/** STOW-RS istemci sözleşmesi testleri (DB/ağ gerektirmez). */
import { buildReportSr } from "../src/lib/dicomSr";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const base = {
  patientName: "Test^Hasta", patientId: "PID-1", patientSex: "F", patientAge: "45Y",
  studyUid: "1.2.840.10008.5.1.4.1.1.2.1", studyDate: "20260110", institution: "TEST", studyModality: "CT",
  clinicalInfo: "Baş ağrısı", technique: "Non-kontrast BT", findings: "Bulgu yok.", impression: "Normal.",
  recommendation: "—", measurements: "", approvedBy: "Dr Test", doctorTitle: "Uz.", approvedAt: "2026-01-10T12:00:00Z",
};

const sr = buildReportSr(base);
const text = new TextDecoder("latin1").decode(sr);
ok(sr.length > 300 && new TextDecoder("latin1").decode(sr.subarray(128, 132)) === "DICM", "SR paketi DICM imzalı");
ok(text.includes("VERIFIED"), "Onaylı rapor VERIFIED işaretli");
ok(text.includes("SEPARATE") && text.includes("COMPLETE"), "Konteyner bütünlüğü");
const unverified = buildReportSr({ ...base, approvedAt: null });
ok(new TextDecoder("latin1").decode(unverified).includes("UNVERIFIED"), "Onaysız rapor UNVERIFIED");

if (failed) { console.error(`${failed} STOW/SR testi başarısız`); process.exit(1); }
console.log("Tüm STOW/SR testleri geçti.");

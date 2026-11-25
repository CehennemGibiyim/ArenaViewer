/**
 * d-patient-letter: hasta dostu sonuç mektubu.
 *
 * Kapsam: üç dil şablonu, sadeleştirme sözlüğü, okuma düzeyi farkı, tarih biçimi,
 * uzun metin kısaltma, boş alan yedeği, onaysız rapor uyarısı ve düz metin çıktısı.
 */
import {
  LETTER_LANGS, LANG_LABELS, buildPatientLetter, formatLetterDate, letterToText, plainify,
  summarizeText, type LetterInput,
} from "../src/lib/patientLetter";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const base: LetterInput = {
  patientName: "AYŞE YILMAZ",
  studyDate: "2026-02-14",
  modality: "BT",
  bodyPart: "TORAKS",
  findingsText: "Sağ akciğer üst lobda 8 mm nodül ve minimal plevral efüzyon izlendi. Kontrastlanma homojen.",
  impression: "Nodül; malignite açısından klinik korelasyon önerilir.",
  recommendation: "3 ay sonra kontrol BT.",
  institution: "Örnek Hastanesi",
  doctorName: "Dr. Mehmet Kaya",
  doctorTitle: "Radyoloji Uzmanı",
  approved: true,
};

// ── dil şablonları ──
const tr = buildPatientLetter(base, { lang: "tr", level: "sade" });
ok(tr.title.includes("hasta özeti") && tr.greeting === "Sayın AYŞE YILMAZ,", "TR başlık ve hitap");
ok(tr.paragraphs[0].includes("14.02.2026") && tr.paragraphs[0].includes("BT"), "TR giriş paragrafı tarih ve modalite içerir");
ok(tr.paragraphs[1].startsWith("Neler görüldü:"), "TR bulgu başlığı");
ok(tr.paragraphs.some((p) => p.startsWith("Sonucun özeti:")), "TR izlenim başlığı");
ok(tr.paragraphs.some((p) => p.startsWith("Öneriler:") && p.includes("kontrol BT")), "TR öneri satırı");
ok(tr.contact.includes("Örnek Hastanesi") && tr.contact.includes("Radyoloji Uzmanı Dr. Mehmet Kaya"), "TR iletişim satırı hekim ve kurumu içerir");
ok(tr.draftWarning === null, "onaylı raporda taslak uyarısı yok");
ok(tr.important.includes("radyoloji uzmanının onayladığı"), "TR sorumluluk notu");

const en = buildPatientLetter(base, { lang: "en", level: "sade" });
ok(en.greeting.startsWith("Dear ") && en.title.toLowerCase().includes("patient summary"), "EN hitap ve başlık");
ok(en.paragraphs[0].includes("2/14/2026"), `EN tarih biçimi ay/gün/yıl (${formatLetterDate("2026-02-14", "en")})`);
ok(en.paragraphs[1].startsWith("What was seen:"), "EN bulgu başlığı");
ok(en.nextSteps.toLowerCase().includes("physician"), "EN sıradaki adımlar");

const de = buildPatientLetter(base, { lang: "de", level: "sade" });
ok(de.greeting.startsWith("Sehr geehrte") && de.title.includes("Patienteninformation"), "DE hitap ve başlık");
ok(de.paragraphs.some((p) => p.includes("Empfehlungen:")), "DE öneri başlığı");
ok(LETTER_LANGS.length === 3 && LANG_LABELS.de === "Deutsch", "dil listesi ve etiketleri");

// ── sadeleştirme ──
ok(plainify("Nodül ve efüzyon izlendi", "tr", "sade").includes("küçük yumru"), "sade düzeyde 'nodül' günlük karşılığa çevrilir");
ok(plainify("Nodül izlendi", "tr", "standart") === "Nodül izlendi", "standart düzeyde metin değişmez");
ok(plainify("Nodule seen", "en", "sade") === "Nodule seen", "TR sözlüğü diğer dillere uygulanmaz");
ok(plainify("Kontrastlanma homojen", "tr", "sade").includes("boya tutan alan"), "kontrastlanma sadeleşir");
ok(plainify("Malign görünüm", "tr", "sade").includes("kötü huylu"), "malign sadeleşir");
const standard = buildPatientLetter(base, { lang: "tr", level: "standart" });
const sade = buildPatientLetter(base, { lang: "tr", level: "sade" });
ok(standard.paragraphs[1].includes("nodül") && !sade.paragraphs[1].includes("nodül;"), "okuma düzeyi bulgu metnini değiştirir");

// ── tarih ve uzun metin ──
ok(formatLetterDate("2026-02-14T09:30:00", "tr") === "14.02.2026", "ISO tarih TR biçimine çevrilir");
ok(formatLetterDate("14.02.2026", "tr") === "14.02.2026", "tanınmayan biçim olduğu gibi kalır");
ok(formatLetterDate("", "tr") === "", "boş tarih boş döner");
const longText = `${"Bu çok uzun bir bulgu cümlesidir. ".repeat(40)}`;
const summarized = summarizeText(longText, 120);
ok(summarized.length <= 124 && summarized.endsWith("…"), "uzun metin cümle sınırında kısaltılır");
ok(summarizeText("Kısa metin.", 120) === "Kısa metin.", "kısa metin değişmez");
ok(summarizeText("  çok   boşluklu  ", 120) === "çok boşluklu", "boşluklar sadeleşir");

// ── boş alanlar, taslak, düz metin ──
const bare = buildPatientLetter({ ...base, patientName: "", findingsText: "", impression: "", recommendation: "", institution: "", doctorTitle: "" }, { lang: "tr", level: "sade" });
ok(bare.greeting.includes("hasta") && bare.paragraphs[1].includes("ek bilgi yazılmamış"), "boş alanlarda yedek metin kullanılır");
const bareEn = buildPatientLetter({ ...base, patientName: "" }, { lang: "en", level: "sade" });
ok(bareEn.greeting === "Dear patient,", "EN boş isim yedeği");
const draft = buildPatientLetter({ ...base, approved: false }, { lang: "tr", level: "sade" });
ok(draft.draftWarning !== null && draft.draftWarning.includes("TASLAK"), "onaysız rapor taslak olarak işaretlenir");
const noFindings = buildPatientLetter(base, { lang: "tr", level: "sade", includeFindings: false });
ok(!noFindings.paragraphs.some((p) => p.startsWith("Neler görüldü:")), "bulgular kapatılınca bölüm eklenmez");

const text = letterToText(tr);
for (const part of [tr.title, tr.greeting, tr.paragraphs[0], tr.nextSteps, tr.important, tr.disclaimer]) {
  ok(text.includes(part), `düz metinde "${part.slice(0, 24)}…" var`);
}
ok(!letterToText(tr).includes("TASLAK"), "onaylı mektup düz metninde taslak uyarısı yok");
ok(letterToText(draft).includes("⚠"), "taslak uyarısı düz metne eklenir");

if (failed) { console.error(`${failed} hasta mektubu testi başarısız`); process.exit(1); }
console.log("Tüm hasta mektubu testleri geçti.");

/**
 * SEG / RTSTRUCT nesnelerinin PACS'e STOW ile gönderilmeden önceki sunucu doğrulaması.
 * Saf fonksiyon; sunucu (stow rotası) çağırır, testler doğrudan kullanır.
 *
 * Neden kapsamlı: İstemci DICOM baytını kendisi üretir ve istemci güvenilmezdir;
 * sunucu nesneyi yalnız "bu türde bir nesne" olarak kabul ederse PACS'e rastgele
 * bayt yazılabilir. Kapsam: DICOM P10 (DICM) + SOP Class tam eşleşme +
 * Study Instance UID, istemcinin bildirdiği çalışmayla uyuşmak zorunda.
 * İçerik (segment maskesi/kontur geometrisi) doğrulanmaz ve doğrulanamaz.
 */
import * as dicomParser from "dicom-parser";
import { SOP_SEG, SOP_RTSTRUCT } from "./dicomSeg";

export type DerivedKind = "seg" | "rtstruct";

export const derivedKindSopClass: Record<DerivedKind, string> = {
  seg: SOP_SEG,
  rtstruct: SOP_RTSTRUCT,
};

export interface DerivedCheck {
  ok: boolean;
  sopClass?: string;
  sopUid?: string;
  studyUid?: string;
  error?: string;
}

/**
 * DICOM P10 baytının istenen SEG/RTSTRUCT nesnesi olduğunu doğrular.
 * `expectedStudyUid` verilirse nesnenin StudyInstanceUID'si onunla bire bir uyuşmak zorundadır
 * (başka çalışmanın SEG'i bu çalışmanın adıyla PACS'e yazılamaz).
 */
export function validateDerivedDicomBytes(buf: Uint8Array, kind: DerivedKind, expectedStudyUid?: string): DerivedCheck {
  const expectedClass = derivedKindSopClass[kind];
  const label = kind === "seg" ? "DICOM Segmentation (SEG)" : "RT Structure Set (RTSTRUCT)";
  if (buf.length < 132) return { ok: false, error: "DICOM nesnesi çok küçük" };
  if (buf[128] !== 0x44 || buf[129] !== 0x49 || buf[130] !== 0x43 || buf[131] !== 0x4d) {
    return { ok: false, error: "Geçerli DICOM P10 değil (DICM imzası yok)" };
  }
  try {
    const parsed = dicomParser.parseDicom(buf);
    const sopClass = parsed.string("x00080016") ?? "";
    if (sopClass !== expectedClass) {
      return { ok: false, sopClass, error: `Yalnızca ${label} gönderilebilir (gelen: ${sopClass || "bilinmiyor"})` };
    }
    const sopUid = parsed.string("x00080018") ?? "";
    if (!sopUid) return { ok: false, sopClass, error: "SOP Instance UID okunamadı" };
    const studyUid = parsed.string("x0020000d") ?? "";
    if (expectedStudyUid) {
      if (!studyUid) return { ok: false, sopClass, sopUid, error: "Study Instance UID okunamadı" };
      if (studyUid !== expectedStudyUid) {
        return { ok: false, sopClass, sopUid, studyUid, error: "Nesne bildirilen çalışmaya ait değil (Study Instance UID uyuşmuyor)" };
      }
    }
    return { ok: true, sopClass, sopUid, studyUid };
  } catch {
    return { ok: false, error: "DICOM ayrıştırılamadı" };
  }
}

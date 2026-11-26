/**
 * Onay → PACS STOW akışında istemciden gelen TID 1500 ölçüm SR'ını doğrular.
 * Saf fonksiyon; sunucu (stow rotası) çağırır, testler doğrudan kullanır.
 *
 * Neden kapsamlı: İstemci DICOM baytını kendisi üretir ve istemci güvenilmezdir;
 * sunucu nesneyi yalnız "bu akışta üretilen türde bir nesne" olduğuna dair
 * asgari sözleşmeyle kabul eder — Comprehensive SR (SOP Class …88.33) ve geçerli
 * P10 (DICM). İçerik (ölçümler/kodlar) doğrulanmaz ve doğrulanamaz.
 */
import * as dicomParser from "dicom-parser";
import { SOP_COMPREHENSIVE_SR } from "./sr1500";

export interface MeasurementSrCheck {
  ok: boolean;
  sopClass?: string;
  error?: string;
}

/** DICOM P10 baytının TID 1500 ölçüm SR'ı olduğunu doğrular. */
export function validateMeasurementSrBytes(buf: Uint8Array): MeasurementSrCheck {
  if (buf.length < 132) return { ok: false, error: "DICOM nesnesi çok küçük" };
  if (buf[128] !== 0x44 || buf[129] !== 0x49 || buf[130] !== 0x43 || buf[131] !== 0x4d) {
    return { ok: false, error: "Geçerli DICOM P10 değil (DICM imzası yok)" };
  }
  try {
    const parsed = dicomParser.parseDicom(buf, { untilTag: "x00080018" });
    const sopClass = parsed.string("x00080016") ?? "";
    if (sopClass !== SOP_COMPREHENSIVE_SR) {
      return { ok: false, sopClass, error: `Yalnızca Comprehensive SR gönderilebilir (gelen: ${sopClass || "bilinmiyor"})` };
    }
    return { ok: true, sopClass };
  } catch {
    return { ok: false, error: "DICOM ayrıştırılamadı" };
  }
}

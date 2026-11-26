"""Diz MR — menisküs/kıkırdak/kemik segmentasyonu (nnU-Net v2 cascade, araştırma amaçlı).

Model: `aagatti/nnunet_knee` (MIT lisans, OAI-ZIB eğitimi) — Goyal, Ananya vd.,
"Automating Imaging Biomarker Analysis for Knee Osteoarthritis Using an
Open-Source MRI-Based Deep Learning Pipeline", medRxiv 2025.02.21.25322094.

Ağırlıklar depoda GÖMÜLÜ DEĞİLDİR; `python ai-worker/setup_knee_model.py`
ile indirilir (≈5 GB; yalnız gereken checkpoint'ler). Çıkarım nnunetv2'nin
kendi CLI'sı (`nnUNetv2_predict`) ile **ayrı bir süreçte** koşar: model belleği
işlem bitince serbest kalır, worker belleği şişmez.

ÇIKTI 9 YAPININ MASKESİDİR: patella/femur/medial+lateral tibia kıkırdağı,
medial/lateral menisküs, femur/tibia/patella kemiği (etiket 1..9, 0 arka plan).
**Yırtık veya dejenerasyon derecesi sınıflaması YAPILMAZ.** Çıktı araştırma
amaçlıdır; radyoloji uzmanı onayı olmadan klinik olarak kullanılamaz.

UYARI: Model T2 ağırlıklı **sagittal** diz MR ile eğitilmiştir (OAI-ZIB);
farklı sekans/düzlemlerde beklenen kalite düşebilir. Kendini bildirilen Dice:
≈0,84 menisküs / ≈0,86 kıkırdak / ≈0,95 kemik / 0,906 ortalama (prospektif
doğrulama YOKTUR).
"""

import gzip
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np

# Docker/konteyner için ATIK_KNEE_DIR ile değiştirilebilir.
CACHE_DIR = os.environ.get(
    "ATIK_KNEE_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "atikviewer-ai", "knee"),
)
MODELS_DIR = os.path.join(CACHE_DIR, "models")  # nnUNet_results kökü
MODEL_REPO = "aagatti/nnunet_knee"
DATASET_ID = "500"                 # models/Dataset500_KneeMRI
CONFIG = "3d_cascade_fullres"      # düşük-çözünürlük → fullres cascade
FOLD = "1"                         # depoda yalnız fold_1 var
LOWRES_CKPT = os.path.join(
    MODELS_DIR, "Dataset500_KneeMRI",
    "nnUNetTrainer__nnUNetResEncUNetMPlans__3d_lowres", "fold_1", "checkpoint_final.pth",
)
CASCADE_CKPT = os.path.join(
    MODELS_DIR, "Dataset500_KneeMRI",
    "nnUNetTrainer__nnUNetResEncUNetMPlans__3d_cascade_fullres", "fold_1", "checkpoint_final.pth",
)

_lock = threading.Lock()
_state = {"lastRun": None, "lastError": None}


def model_files_ready() -> bool:
    """nnU-Net checkpoint'leri yerelde mevcut mu? (setup tamamlanmış mı)"""
    return os.path.isfile(LOWRES_CKPT) and os.path.isfile(CASCADE_CKPT)


def _device() -> str:
    try:
        import torch  # noqa: PLC0415 — torch zaten gereksinimlerde

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


def run_knee_inference(vol_zyx: np.ndarray, spacing) -> dict:
    """Z,Y,X float32 hacmi segmentlere ayırır.

    spacing: (sz, sy, sx) mm. Dönen sözlük: labels (uint8 bytes, Z*Y*X),
    dims [Z,Y,X], elapsedMs, model. Hata durumunda RuntimeError fırlatır.
    """
    if not model_files_ready():
        raise RuntimeError(
            f"Diz modeli bulunamadı ({LOWRES_CKPT} ve {CASCADE_CKPT}). "
            "Kurulum: python ai-worker/setup_knee_model.py (≈5 GB, MIT lisans)."
        )
    try:
        import nibabel as nib
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("nibabel gerekli (pip install -r ai-worker/requirements.txt)") from e

    dz, dy, dx = (float(v) for v in spacing)
    vol = np.ascontiguousarray(np.asarray(vol_zyx, dtype=np.float32))
    # NIfTI afinine yalnız aralık yazılır; yönelim nnU-Net tarafından voxel
    # uzayında korunur, çıktı girişle aynı voksel düzenindedir.
    affine = np.diag([dz, dy, dx, 1.0]).astype(np.float64)

    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="atik-knee-") as td:
        indir = os.path.join(td, "in")
        outdir = os.path.join(td, "out")
        os.makedirs(indir, exist_ok=True)
        os.makedirs(outdir, exist_ok=True)
        nib.save(nib.Nifti1Image(vol, affine), os.path.join(indir, "case_0000.nii.gz"))

        env = os.environ.copy()
        env["nnUNet_raw"] = os.path.join(td, "raw")
        env["nnUNet_preprocessed"] = os.path.join(td, "pre")
        env["nnUNet_results"] = MODELS_DIR

        predict = shutil.which("nnUNetv2_predict")
        if predict:
            cmd = [predict]
        else:
            # venv bin dizini PATH'te değilse modül yoluyla çağır.
            cmd = [sys.executable, "-m", "nnunetv2.inference.predict_from_raw_data"]
        cmd += [
            "-i", indir,
            "-o", outdir,
            "-d", DATASET_ID,
            "-c", CONFIG,
            "-f", FOLD,
            "-chk", "checkpoint_final.pth",
            "-device", _device(),
        ]
        try:
            proc = subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=int(os.environ.get("ATIK_KNEE_TIMEOUT", "1500")),
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                f"nnU-Net zaman aşımı ({e.timeout} sn). ATIK_KNEE_TIMEOUT ile uzatılabilir."
            ) from e

        out_path = os.path.join(outdir, "case.nii.gz")
        if proc.returncode != 0 or not os.path.isfile(out_path):
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-8:]
            raise RuntimeError(
                "nnU-Net çıkarımı başarısız (kod %s): %s"
                % (proc.returncode, " | ".join(tail) or "çıktı dosyası üretilmedi")
            )
        lab = np.rint(np.asanyarray(nib.load(out_path).dataobj)).astype(np.int16)
        if lab.ndim == 4 and lab.shape[-1] == 1:  # (Z,Y,X,1) olası yazım
            lab = lab[..., 0]
        if lab.shape != vol.shape:
            # nnU-Net özgün geometriyi korur; yine de şekil sapmasına karşı
            # en iyi çabayla en yakın komşu ile giriş şekline getir.
            try:
                import SimpleITK as sitk  # nnunetv2 bağımlılığı — mevcut olmalı

                ri = sitk.ReadImage(out_path)
                ri = sitk.Resample(
                    ri, list(vol.shape)[::-1], sitk.Transform(),
                    sitk.sitkNearestNeighbor, 0, ri.GetPixelID(),
                )
                lab = np.rint(sitk.GetArrayFromImage(ri)).astype(np.int16)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(
                    f"etiket hacmi girişe geri eşlenemedi (çıktı {lab.shape}, girdi {vol.shape}): {e}"
                ) from e
        labels = np.clip(lab, 0, 9).astype(np.uint8)

    elapsed = int((time.time() - t0) * 1000)
    _state["lastRun"] = time.time()
    return {
        "labels": labels.tobytes(),
        "dims": list(labels.shape),
        "elapsedMs": elapsed,
        "model": "nnU-Net Knee MRI Segmentation (aagatti/nnunet_knee, MIT; Goyal et al., medRxiv 2025.02.21.25322094)",
    }

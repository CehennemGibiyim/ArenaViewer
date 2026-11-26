"""nnU-Net diz MR segmentasyon ağırlıklarını indirir (`aagatti/nnunet_knee`, MIT).

Kullanım:
    python ai-worker/setup_knee_model.py

İndirilenler (yalnız gerekenler; `3d_fullres` atlanır çünkü çıkarım cascade
iledir): models/Dataset500_KneeMRI/…3d_lowres + …3d_cascade_fullres
(fold_1, checkpoint_final.pth) + küçük yapılandırma dosyaları ve iki örnek
test dosyası atlanır (test_image.nii.gz ≈307 MB). Toplam ≈1,6 GB (yalnız iki
checkpoint_final.pth; deponun tamamı ≈7,6 GB). Hedef dizin ATIK_KNEE_DIR
(varsayılan ~/.cache/atikviewer-ai/knee).

Lisans ve atıf: ağırlıklar MIT lisanslıdır (depoda ayrı LICENSE dosyası YOK;
huggingface.co/aagatti/nnunet_knee model kartı MIT beyan eder ve atıf ister):

    Goyal, A. vd. (2025). Automating Imaging Biomarker Analysis for Knee
    Osteoarthritis Using an Open-Source MRI-Based Deep Learning Pipeline.
    medRxiv 2025.02.21.25322094. https://doi.org/10.1101/2025.02.21.25322094

Eğitim verisi OAI-ZIB'dir; model T2 ağırlıklı sagittal diz MR için tasarlanmıştır.
Çıktı YAPININ SINIRLARIDIR (segmentasyon); yırtık/dejenerasyon sınıflaması
YOKTUR. Araştırma amaçlıdır; klinik karar için kullanılamaz.
"""

import os
import sys

# Windows konsolları varsayılan olarak UTF-8 değil; Türkçe çıktı bozulmasın.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001
        pass

CACHE_DIR = os.environ.get(
    "ATIK_KNEE_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "atikviewer-ai", "knee"),
)
REPO_ID = "aagatti/nnunet_knee"

ALLOW_PATTERNS = [
    "models/Dataset500_KneeMRI/nnUNetTrainer__nnUNetResEncUNetMPlans__3d_lowres/**",
    "models/Dataset500_KneeMRI/nnUNetTrainer__nnUNetResEncUNetMPlans__3d_cascade_fullres/**",
    "config.json",
    "dataset.json",
    "plans.json",
    "README.md",
    # Örnek test vakası (test_image.nii.gz ≈307 MB + ground_truth ≈0,4 MB) bilinçli
    # olarak atlanır; isterseniz elle indirin:
    #   hf download aagatti/nnunet_knee test_data/test_image.nii.gz --local-dir %USERPROFILE%\.cache\atikviewer-ai\knee
]

EXPECTED_CKPTS = [
    os.path.join(
        CACHE_DIR, "models", "Dataset500_KneeMRI",
        "nnUNetTrainer__nnUNetResEncUNetMPlans__3d_lowres", "fold_1", "checkpoint_final.pth",
    ),
    os.path.join(
        CACHE_DIR, "models", "Dataset500_KneeMRI",
        "nnUNetTrainer__nnUNetResEncUNetMPlans__3d_cascade_fullres", "fold_1", "checkpoint_final.pth",
    ),
]


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub yok; önce: pip install -r ai-worker/requirements.txt", file=sys.stderr)
        return 2

    print(f"nnU-Net diz MR ağırlıkları indiriliyor → {CACHE_DIR}", flush=True)
    print(f"Kaynak: huggingface.co/{REPO_ID} (MIT; OAI-ZIB; ≈1,6 GB)", flush=True)
    snapshot_download(repo_id=REPO_ID, local_dir=CACHE_DIR, allow_patterns=ALLOW_PATTERNS)

    missing = [p for p in EXPECTED_CKPTS if not os.path.isfile(p)]
    if missing:
        print("İNDİRME EKSİK — şu dosyalar yok:", file=sys.stderr)
        for p in missing:
            print(f"  {p}", file=sys.stderr)
        return 1

    for p in EXPECTED_CKPTS:
        mb = os.path.getsize(p) / (1024 * 1024)
        print(f"  ✓ checkpoint: {os.path.basename(os.path.dirname(os.path.dirname(p)))} ({mb:.0f} MB)")
    print()
    print("Kurulum tamam. Atıf (model kartı isteği):")
    print("  Goyal, A. vd. (2025). medRxiv 2025.02.21.25322094 — doi:10.1101/2025.02.21.25322094")
    print("UYARI: çıktı yalnız yapı sınırıdır; yırtık/dejenerasyon tanısı konmaz. Araştırma amaçlıdır.")
    print("İlk çıkarım uzun sürebilir (CPU'da ≈80 sn/hacim + model yükleme).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

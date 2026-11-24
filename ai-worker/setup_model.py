"""MONAI lung_nodule_ct_detection bundle dosyalarını indirir (ücretsiz, Apache-2.0).

Kullanım:
    python ai-worker/setup_model.py

İkinci modeli de indirir: BT beyin ICH (ianpan/ct-head-hemorrhage-detection, MIT,
≈147 MB) → ~/.cache/atikviewer-ai/brain (ai-worker/brain_lib için zorunlu).

Üçüncü model AKCIĞER GRAFİSİ (CXR) içindir ve DEPODA GÖMÜLÜDÜR
(ai-worker/models/cxr_densenet121_medx_320.onnx, Apache-2.0; kaynak:
Harsh-Prajapati54/Medical_X — bildirim: ai-worker/models/NOTICE.md). İndirme
gerekmez; bu betik yalnızca dosyayı ve SHA-256 özetini denetler ve isteğe bağlı
olarak ATIK_CXR_DIR dizinine kopyalar.

Akciğer dosyaları ATIK_MODEL_DIR (varsayılan ~/.cache/atikviewer-ai/model) altına iner:
    model.pt            (≈84 MB, LUNA16 eğitimi RetinaNet+ResNet50-3D)
    inference.json      (bundle ön işleme/yapılandırma — model_lib ile birebir)
    metadata.json
    scripts/*.py        (bundle inferer yardımcıları — model_lib'in import ettiği dosya)

Mevcut ve boyutu doğrulanmış dosyalar atlanır (idempotent).
"""

import hashlib
import os
import shutil
import sys
import urllib.request

# Windows konsolları varsayılan olarak UTF-8 değil; Türkçe çıktı bozulmasın.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001
        pass

BASE = "https://huggingface.co/MONAI/lung_nodule_ct_detection/resolve/main"
MODEL_DIR = os.environ.get(
    "ATIK_MODEL_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "atikviewer-ai", "model"),
)

# ── İkinci model: BT beyin ICH (ianpan/ct-head-hemorrhage-detection, MIT) ──
# Yol brain_lib.CACHE_DIR ile birebir aynı olmalıdır; dosya listesi ve boyutları
# HuggingFace deposundaki LFS boyutlarıyla doğrulanmıştır (7 dosya, ≈147 MB).
BRAIN_REPO = "ianpan/ct-head-hemorrhage-detection"
# Docker/konteyner için ATIK_BRAIN_DIR ile değiştirilebilir (varsayılan: ~/.cache/...).
BRAIN_DIR = os.environ.get(
    "ATIK_BRAIN_DIR",
    os.path.join(os.path.expanduser("~"), ".cache", "atikviewer-ai", "brain"),
)
BRAIN_FILES = [
    ("classifier/model.safetensors", 122_429_448),
    ("sequence/model.safetensors", 11_098_536),
    ("segmentation/fold0.safetensors", 5_498_088),
    ("segmentation/fold1.safetensors", 5_498_088),
    ("segmentation/fold2.safetensors", 5_498_088),
    ("segmentation/fold3.safetensors", 5_498_088),
    ("segmentation/fold4.safetensors", 5_498_088),
]

# (uzak yol, yerel ad, beklenen bayt; None ise boyut kontrolü yapılmaz)
FILES = [
    ("models/model.pt", "model.pt", 83709381),
    ("configs/inference.json", "inference.json", None),
    ("configs/metadata.json", "metadata.json", None),
    ("scripts/detection_inferer.py", os.path.join("scripts", "detection_inferer.py"), None),
    ("scripts/detection_saver.py", os.path.join("scripts", "detection_saver.py"), None),
    ("scripts/evaluator.py", os.path.join("scripts", "evaluator.py"), None),
    # NOT: scripts/__init__.py BİLEREK indirilmez; upstream dosya indirilmemiş
    # trainer.py'yi import ettiği için model yüklemeyi bozar. scripts/ bir
    # "namespace package" olarak çalışır (doğrulanmış durum).
]


def download(url: str, dest: str) -> None:
    tmp = dest + ".part"
    print(f"  indiriliyor: {url}", flush=True)
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, dest)


def setup_brain() -> int:
    """BT beyin ICH ağırlıklarını indirir (idempotent).

    Mevcut ve boyutu doğrulanmış dosyalar atlanır; hatalı boyutlu dosya önce
    silinir. huggingface_hub gereklidir (requirements.txt) — yalnızca indirme
    anında import edilir ki akciğer paketi tek başına da çalışabilsin.
    Eksik/hatalı dosya sayısını döndürür (0 = tamam).
    """
    os.makedirs(BRAIN_DIR, exist_ok=True)
    missing = 0
    for remote, size in BRAIN_FILES:
        dest = os.path.join(BRAIN_DIR, *remote.split("/"))
        if os.path.isfile(dest):
            actual = os.path.getsize(dest)
            if actual == size:
                print(f"  atlandı (mevcut): {remote} ({actual} bayt)", flush=True)
                continue
            print(f"  boyut uyuşmuyor ({actual} != {size}), yeniden indiriliyor: {remote}", flush=True)
            try:
                os.remove(dest)
            except OSError:
                pass
        try:
            from huggingface_hub import hf_hub_download

            hf_hub_download(repo_id=BRAIN_REPO, filename=remote, local_dir=BRAIN_DIR)
        except Exception as e:  # noqa: BLE001
            print(f"  HATA: {remote} indirilemedi: {e}", file=sys.stderr, flush=True)
            missing += 1
            continue
        if not os.path.isfile(dest) or os.path.getsize(dest) != size:
            print(f"  HATA: {remote} boyutu tutmuyor", file=sys.stderr, flush=True)
            missing += 1

    if missing:
        print(f"Beyin modeli: {missing} dosya eksik/hatalı.", file=sys.stderr, flush=True)
    else:
        print(f"Beyin modeli hazır: {BRAIN_DIR}", flush=True)
    return missing


# ── Üçüncü model: CXR sınıflandırma (depoda gömülü ONNX) ─────────────
CXR_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "cxr_densenet121_medx_320.onnx")
CXR_SHA256 = "5471902106c5b7d8c7f40b7fdfa6b64d13a3f7ea12694d3979c5848391d1949b"
CXR_BYTES = 28_270_117


def setup_cxr(verbose: bool = True) -> int:
    """Gömülü CXR ONNX'unu denetler; 0 = tamam, 1 = eksik/hatalı.

    `CXR_MODEL_PATH` tanımlıysa o dosyayı kullanır; aksi halde depodaki gömülü
    dosyaya işaret eder. ATIK_CXR_DIR tanımlıysa dosyanın bir kopyasını oraya
    yazar (worker önce o dizine bakar).
    """
    path = os.environ.get("CXR_MODEL_PATH", "").strip() or CXR_MODEL
    if not os.path.isfile(path):
        print(f"HATA: CXR modeli bulunamadı: {path}", file=sys.stderr, flush=True)
        return 1
    actual = os.path.getsize(path)
    if actual != CXR_BYTES:
        print(f"HATA: CXR modeli boyutu tutmuyor ({actual} != {CXR_BYTES})", file=sys.stderr, flush=True)
        return 1
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    if digest != CXR_SHA256:
        print(f"HATA: CXR modeli sha256 tutmuyor\n  beklenen {CXR_SHA256}\n  gelen   {digest}", file=sys.stderr, flush=True)
        return 1
    if verbose:
        print(f"CXR modeli hazir: {path} ({actual} bayt, sha256={digest[:12]}…)", flush=True)

    cache_dir = os.environ.get("ATIK_CXR_DIR", "").strip()
    if cache_dir and os.path.abspath(cache_dir) != os.path.dirname(os.path.abspath(path)):
        os.makedirs(cache_dir, exist_ok=True)
        dest = os.path.join(cache_dir, os.path.basename(path))
        if not (os.path.isfile(dest) and os.path.getsize(dest) == actual):
            try:
                shutil.copyfile(path, dest)
                print(f"  kopyalandı: {dest}", flush=True)
            except OSError as e:  # noqa: BLE001
                print(f"  UYARI: ATIK_CXR_DIR kopyalaması yapılamadı: {e}", file=sys.stderr, flush=True)
    return 0


def main() -> int:
    os.makedirs(MODEL_DIR, exist_ok=True)
    missing = 0
    for remote, local, size in FILES:
        dest = os.path.join(MODEL_DIR, local)
        if os.path.isfile(dest):
            actual = os.path.getsize(dest)
            if size is None or actual == size:
                print(f"  atlandı (mevcut): {local} ({actual} bayt)", flush=True)
                continue
            print(f"  boyut uyuşmuyor ({actual} != {size}), yeniden indiriliyor: {local}", flush=True)
        os.makedirs(os.path.dirname(dest) or MODEL_DIR, exist_ok=True)
        try:
            download(f"{BASE}/{remote}", dest)
        except Exception as e:  # noqa: BLE001
            print(f"  HATA: {local} indirilemedi: {e}", file=sys.stderr, flush=True)
            missing += 1
            continue
        actual = os.path.getsize(dest)
        if size is not None and actual != size:
            print(f"  HATA: {local} boyutu tutmuyor ({actual} != {size})", file=sys.stderr, flush=True)
            missing += 1

    if missing:
        print(f"{missing} dosya eksik/hatalı.", file=sys.stderr)
        return 1

    # Bütünlük: model.pt SHA-256 özetini yaz (kayıt için)
    model = os.path.join(MODEL_DIR, "model.pt")
    h = hashlib.sha256()
    with open(model, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    print(f"Tamam. model.pt sha256={h.hexdigest()}", flush=True)
    print(f"Model dizini: {MODEL_DIR}", flush=True)

    # İkinci model: BT beyin ICH ağırlıkları (ai-worker/brain_lib kullanır)
    brain_missing = setup_brain()
    # Üçüncü model: CXR (depoda gömülü; yalnızca denetlenir)
    cxr_missing = setup_cxr()
    return 1 if (brain_missing or cxr_missing) else 0


if __name__ == "__main__":
    raise SystemExit(main())

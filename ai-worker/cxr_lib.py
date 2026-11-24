"""Akciğer grafisi (CXR) sınıflandırma + ısı haritası — yerel ONNX çıkarımı.

Model: Harsh-Prajapati54/Medical_X (Apache-2.0), DenseNet121 + 14 sınıflı kafa,
NIH ChestX-ray14 eğitimi. Ağırlık bu depoda: ai-worker/models/cxr_densenet121_medx_320.onnx
(kaynak ve lisans bildirimi için ai-worker/models/NOTICE.md).

Çıkarım TAMAMEN yerel çalışır; hasta verisi dışarı gönderilmez, ücret yoktur.
SONUÇ KLİNİK DEĞERDEĞİLDİR: her bulgu aday niteliğindedir ve radyoloji uzmanı
onayı olmadan kullanılamaz.

Girdi/çıktı sözleşmesi:
  girdi : 2B gri piksel dizisi (serbest ölçekli; pencereleme TARAYICIDA yapılmaz,
          model ön işleme burada sabit kurallarla yapar)
  çıktı : sınıf başına olasılık (sigmoid) + sınıfa özel ısı haritası (64×64,
          0–255 gri, base64)

Ön işleme (modelin eğitildiği 8-bit PNG varsayımına sabitlenir):
  1) %1 / %99 persentilini kırpıp 0–255'e ayarla (üretici/kalibrasyon farkını
     telafi eder; klinik bir normalizasyon DEĞİLDİR),
  2) 320×320'e bilinear yeniden örnekle,
  3) RGB üç kanalına aynısını tekrarla,
  4) ImageNet mean/std ile normalize et.
"""

from __future__ import annotations

import base64
import io
import os
import sys
import threading

import numpy as np

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001
        pass

MODEL_NAME = "cxr_densenet121_medx_320.onnx"
# Kaynak dosyanın bilinen boyutu (tam sayı bayt); NOTICE.md'deki sha256 ile çapraz kontrol edilir.
EXPECTED_BYTES = 28_270_117

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_SIZE = 320
HEAT_SIZE = 64

# Üst kaynağın src/predict.py::ALL_LABELS sırasıyla (indeks sözleşmesidir).
CLASS_NAMES = [
    "Atelectasis",
    "Cardiomegaly",
    "Effusion",
    "Infiltration",
    "Mass",
    "Nodule",
    "Pneumonia",
    "Pneumothorax",
    "Consolidation",
    "Edema",
    "Emphysema",
    "Fibrosis",
    "Pleural_Thickening",
    "Hernia",
]

# Türkçe rapor etiketleri (sıra CLASS_NAMES ile birebir).
CLASS_TR = [
    "Atelektazi",
    "Kardiyomegali",
    "Effüzyon",
    "İnfiltrat",
    "Kütle",
    "Nodül",
    "Pnömoni",
    "Pnömotoraks",
    "Konsolidasyon",
    "Ödem",
    "Amfizem",
    "Fibrozis",
    "Plevral Kalınlaşma",
    "Herniasyon",
]

# Sinir başına karar eşiği: üst kaynağın results/validation_metrics.csv
# (doğrulama split'i üzerinde F1 maksimizasyonu ile bulunan eşikler).
THRESHOLDS = [
    0.50,   # Atelectasis
    0.53,   # Cardiomegaly
    0.59,   # Effusion
    0.54,   # Infiltration
    0.51,   # Mass
    0.50,   # Nodule
    0.36,   # Pneumonia
    0.47,   # Pneumothorax
    0.51,   # Consolidation
    0.55,   # Edema
    0.47,   # Emphysema
    0.46,   # Fibrosis
    0.47,   # Pleural_Thickening
    0.53,   # Hernia
]

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

STATE = {"session": None}
_lock = threading.Lock()


def model_path() -> str:
    """Ortam değişkeni → yerel önbellek → depoda gömülü dosya sırasıyla."""
    override = os.environ.get("CXR_MODEL_PATH", "").strip()
    if override:
        return override
    cache_dir = os.environ.get(
        "ATIK_CXR_DIR",
        os.path.join(os.path.expanduser("~"), ".cache", "atikviewer-ai", "cxr"),
    )
    cached = os.path.join(cache_dir, MODEL_NAME)
    if os.path.exists(cached):
        return cached
    return os.path.join(HERE, "models", MODEL_NAME)


def model_ready() -> bool:
    path = model_path()
    return os.path.isfile(path) and os.path.getsize(path) == EXPECTED_BYTES


def model_status() -> dict:
    path = model_path()
    return {
        "modelFile": model_ready(),
        "path": path,
        "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
    }


def get_session():
    """Tek InferenceSession (CPU); ilk çağrıda yüklenir. onnxruntime gereklidir."""
    if STATE["session"] is None:
        with _lock:
            if STATE["session"] is None:
                import onnxruntime as ort

                sess = ort.InferenceSession(model_path(), providers=["CPUExecutionProvider"])
                STATE["session"] = sess
    return STATE["session"]


def preprocess(gray: np.ndarray) -> np.ndarray:
    """2B gri diziyi model girdisine çevirir: (1,3,320,320) float32."""
    from PIL import Image

    arr = np.asarray(gray, np.float32)
    if arr.ndim != 2 or min(arr.shape) < 8:
        raise ValueError(f"Geçersiz grafi boyutu: {arr.shape}")
    lo, hi = np.percentile(arr, [1.0, 99.0])
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-6:
        raise ValueError("Görüntü kontrastı yok (sabit/dasenmiş piksel)")
    scaled = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    img = Image.fromarray(np.round(scaled * 255.0).astype(np.uint8), mode="L")
    small = img.resize((IMAGE_SIZE, IMAGE_SIZE), Image.BILINEAR)
    a = np.asarray(small, np.float32) / 255.0
    rgb = np.stack([a, a, a], axis=-1)                      # (H,W,3)
    rgb = (rgb - MEAN) / STD                                # ImageNet
    return rgb.transpose(2, 0, 1)[None].astype(np.float32)


def _quantize_heat(cam: np.ndarray) -> np.ndarray:
    """(h,w) float ısı haritasını 64×64, 0–255 greye indirger."""
    from PIL import Image

    lo, hi = float(cam.min()), float(cam.max())
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-9:
        return np.zeros((HEAT_SIZE, HEAT_SIZE), np.uint8)
    norm = np.clip((cam - lo) / (hi - lo), 0.0, 1.0)
    img = Image.fromarray(np.round(norm * 255.0).astype(np.uint8), mode="L")
    small = img.resize((HEAT_SIZE, HEAT_SIZE), Image.BILINEAR)
    return np.asarray(small, np.uint8)


def _b64(data: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(data).tobytes()).decode("ascii")


def run_inference(gray: np.ndarray, max_heats: int = 3) -> dict:
    """Bir grafide 14 sınıflık olasılık + pozitif sınıfların ısı haritası döndürür."""
    import time

    t0 = time.time()
    x = preprocess(gray)
    sess = get_session()
    zero_idx = np.zeros(1, np.int64)
    logits = sess.run(None, {"input": x, "class_idx": zero_idx})[0][0]
    probs = 1.0 / (1.0 + np.exp(-np.clip(logits.astype(np.float64), -60.0, 60.0)))

    order = np.argsort(-probs)
    positive = []
    for idx in order:
        p = float(probs[idx])
        if p >= THRESHOLDS[int(idx)]:
            positive.append(int(idx))
        if len(positive) >= 6:
            break

    heats = []
    for idx in positive[:max_heats]:
        cam = sess.run(None, {"input": x, "class_idx": np.array([idx], np.int64)})[1][0]
        heats.append({
            "index": int(idx),
            "name": CLASS_NAMES[int(idx)],
            "w": HEAT_SIZE,
            "h": HEAT_SIZE,
            "b64": _b64(_quantize_heat(cam)),
        })

    elapsed = int((time.time() - t0) * 1000)
    top = int(order[0])
    return {
        "scores": [
            {
                "index": i,
                "name": CLASS_NAMES[i],
                "labelTr": CLASS_TR[i],
                "prob": round(float(probs[i]), 4),
                "threshold": THRESHOLDS[i],
                "positive": bool(probs[i] >= THRESHOLDS[i]),
            }
            for i in range(len(CLASS_NAMES))
        ],
        "top": {"index": top, "name": CLASS_NAMES[top], "prob": round(float(probs[top]), 4)},
        "heats": heats,
        "elapsedMs": elapsed,
        "model": "Medical_X DenseNet121 (NIH ChestX-ray14, Apache-2.0)",
        "imageSize": IMAGE_SIZE,
    }


def verify_model() -> dict:
    """Yüklenen oturumun girdi/çıktı şemasını ve ısı haritası aralığını denetler."""
    sess = get_session()
    x = np.zeros((1, 3, IMAGE_SIZE, IMAGE_SIZE), np.float32)
    logits, cam = sess.run(None, {"input": x, "class_idx": np.zeros(1, np.int64)})
    return {
        "inputs": [(i.name, list(i.shape)) for i in sess.get_inputs()],
        "outputs": [(o.name, list(o.shape)) for o in sess.get_outputs()],
        "logitsShape": list(logits.shape),
        "camShape": list(cam.shape),
        "ok": logits.shape[-1] == len(CLASS_NAMES),
    }

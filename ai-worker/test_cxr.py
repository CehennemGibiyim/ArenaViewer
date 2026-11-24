"""CXR model kütüphanesi birim testi (ai-worker/cxr_lib.py).

Ağ/bağımlılık GEREKTİRMEZ: depodaki ONNX ile sentetik bir akciğer grafisi üretilir.
Çalıştırma:
    python ai-worker/test_cxr.py            # veya  .venv\\Scripts\\python ai-worker\\test_cxr.py

Bu betik npm test zincirinin parçası DEĞİLDİR (Python tarafı); TypeScript tarafındaki
muadili tests/cxr-model.test.ts'dir.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001
        pass

import numpy as np  # noqa: E402

import cxr_lib  # noqa: E402


def make_chest(size: int = 512) -> np.ndarray:
    """Torasik oval + iki akciğer alanı + kosta deseni içeren sentetik PA grafi."""
    yy, xx = np.mgrid[0:size, 0:size]
    u = xx / size
    v = yy / size
    img = np.full((size, size), 25.0, np.float32)

    body = ((u - 0.5) / 0.42) ** 2 + ((v - 0.52) / 0.5) ** 2 < 1.0
    img[body] = 90.0
    lung_l = ((u - 0.34) / 0.14) ** 2 + ((v - 0.42) / 0.26) ** 2 < 1.0
    lung_r = ((u - 0.66) / 0.145) ** 2 + ((v - 0.42) / 0.27) ** 2 < 1.0
    img[lung_l | lung_r] = 55.0
    # kosta yayılar
    ribs = np.abs(np.sin((v + u * 0.12) * 40.0)) > 0.93
    img[(lung_l | lung_r) & ribs] += 45.0
    # kalp gölgesi
    heart = ((u - 0.55) / 0.13) ** 2 + ((v - 0.58) / 0.15) ** 2 < 1.0
    img[heart] = 120.0
    rng = np.random.default_rng(3)
    img = img + rng.normal(0, 4, img.shape).astype(np.float32)
    return np.clip(img, 0, 255)


def main() -> int:
    failed = 0

    def ok(cond: bool, msg: str) -> None:
        nonlocal failed
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            failed += 1

    ok(cxr_lib.model_ready(), f"Model dosyası bulundu: {cxr_lib.model_path()}")
    status = cxr_lib.verify_model()
    ok(status["ok"], f"Oturum şeması: girdi {status['inputs']} / çıktı {status['outputs']}")

    gray = make_chest()
    out = cxr_lib.run_inference(gray)
    ok(len(out["scores"]) == 14, "14 sınıflık olasılık üretildi")
    ok(all(0.0 <= s["prob"] <= 1.0 for s in out["scores"]), "Olasılıklar [0,1]")
    ok(len(out["heats"]) == min(3, sum(1 for s in out["scores"] if s["positive"])), "Isı haritası sayısı pozitif sınıfla uyumlu")
    for h in out["heats"]:
        ok(h["w"] == 64 and h["h"] == 64 and len(h["b64"]) > 0, f"Isı haritası 64×64 base64 ({h['name']})")

    # Sabit ön işleme: aynı girdi → aynı sonuç (kararsızlık yok).
    again = cxr_lib.run_inference(gray)
    ok([s["prob"] for s in again["scores"]] == [s["prob"] for s in out["scores"]], "Ön işleme/çıkarım tekrarlanabilir")

    # Boş/dasenmiş girdi reddedilir (sessiz sahte sonuç üretmez).
    try:
        cxr_lib.preprocess(np.zeros((64, 64), np.float32))
        ok(False, "Sabit görüntü reddedilmeliydi")
    except ValueError:
        ok(True, "Sabit görüntü reddedildi")
    try:
        cxr_lib.preprocess(np.zeros((4, 4), np.float32))
        ok(False, "Küçük görüntü reddedilmeliydi")
    except ValueError:
        ok(True, "Çok küçük görüntü reddedildi")

    # Eşikler kaynakla uyumlu ve sıralama tutarlı.
    ok(cxr_lib.THRESHOLDS[6] == 0.36 and cxr_lib.THRESHOLDS[2] == 0.59, "Sınıf eşikleri kaynak CSV ile uyumlu")
    ok(len(cxr_lib.CLASS_NAMES) == len(cxr_lib.CLASS_TR) == 14, "Türkçe etiketler aynı sırada")

    print(f"\n{len(out['scores'])} sınıf · pozitif: {[s['name'] for s in out['scores'] if s['positive']]}")
    print("Model çıktıları aday niteliğindedir; radyoloji uzmanı onayı olmadan geçerli değildir.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

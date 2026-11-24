"""CXR uçtan uca probu: worker /infer?protocol=cxr çağrısı (yalnızca 127.0.0.1).

Ağ/bağımlılık GEREKTİRMEZ; worker'ın önce çalışıyor olması gerekir:
    python ai-worker/server.py
    python ai-worker/test_cxr_e2e.py

Gövde biçimi üretimdekiyle birebir aynıdır: gzip(float32 LE, Z=1,Y,X).
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_cxr import make_chest  # noqa: E402

WORKER = os.environ.get("AI_WORKER_URL", "http://127.0.0.1:8787")


def post(gray: np.ndarray) -> dict:
    body = gzip.compress(np.ascontiguousarray(gray, dtype="<f4").tobytes())
    h, w = gray.shape
    url = f"{WORKER}/infer?dims=1,{h},{w}&spacing=1,1,1&protocol=cxr"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    gray = make_chest(768)
    t0 = time.time()
    out = post(gray)
    failed = 0

    def ok(cond: bool, msg: str) -> None:
        nonlocal failed
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            failed += 1

    ok(len(out.get("scores", [])) == 14, "Yanıtta 14 sınıflık olasılık var")
    ok(all(0.0 <= s["prob"] <= 1.0 for s in out["scores"]), "Olasılıklar [0,1]")
    ok(isinstance(out.get("heats"), list), "Isı haritası listesi var")
    ok(len(out["heats"]) == min(3, sum(1 for s in out["scores"] if s["positive"])), "Isı haritası sayısı pozitif sayısıyla uyumlu")
    ok(out.get("model", "").startswith("Medical_X"), "Model tanımı yanıtta")
    print(f"   {time.time() - t0:.1f}s · pozitif: {[s['name'] for s in out['scores'] if s['positive']]}")

    # Hatalı protokol reddedilir.
    try:
        req = urllib.request.Request(f"{WORKER}/infer?dims=1,64,64&spacing=1,1,1&protocol=xyz", data=b"", method="POST")
        urllib.request.urlopen(req, timeout=5)
        ok(False, "Bilinmeyen protokol reddedilmeliydi")
    except urllib.error.HTTPError as e:
        ok(e.code == 400, "Bilinmeyen protokol 400 döndürür")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

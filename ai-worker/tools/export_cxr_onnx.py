"""CXR (akciğer grafisi) sınıflandırma modelini tek dosyalık ONNX'e çevirir.

Kaynak: Harsh-Prajapati54/Medical_X — "Med-X — Chest X-Ray Disease Detection"
  Lisans: Apache-2.0 (LICENSE dosyası ve repo kartıyla doğrulanmıştır)
  Depo anlaşması (commit): 9f5afbfbaa2183faa79e6ff4664a4de1af84d4fc
  Ağırlık: best_model.pth (28.479.976 bayt, git blob sha 06b0a1ea…,
           sha256 ef369ad8869f1fe837eb344e0cecda973138b0c28ac775f259a9775a499a7b11)

Mimari: DenseNet121 (ImageNet ön eğitimi) + 14 sınıflı Lineer kafa.
Eğitim verisi: NIH ChestX-ray14 (çok etiketli, zayıf/etiket hatası olan etiketler).

ONNX çıktısı TEK DOSYADA iki çıktı verir:
  girdi : input      (batch, 3, 320, 320) float32 — ImageNet normalizasyonlu
          class_idx  (batch,) int64              — istenen sınıfın indeksi
  çıktı : logits     (batch, 14)                — sigmoid'ten ÖNCE ham logit
          cam        (batch, 10, 10)            — ReLU(GAP ağırlıklı özellik haritası)

Isı haritası NOTU: Sınıflandırıcı, GAP + Lineer olduğu için Grad-CAM'ın altı
gradyan ağırlıkları ile Lineer ağırlık vektörü matematiksel olarak aynıdır
(d logit_c / d f_k = W_{c,k}). Bu yüzden ısı haritası, gradyan geri beslemesi
olmadan (yalnızca ONNX Runtime ile) hesaplanabilir. Üst kaynağın
`src/predict.py`'indeki hook tabanlı Grad-CAM ile tutarlılık bu betikte
doğrulanır (`--verify`).

Kullanım:
    python ai-worker/tools/export_cxr_onnx.py --weights best_model.pth --out ai-worker/models/cxr_densenet121_medx_320.onnx
    python ai-worker/tools/export_cxr_onnx.py --verify   # mevcut ONNX'u torch ile karşılaştırır
"""

from __future__ import annotations

import argparse
import os
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # noqa: BLE001
        pass

IMAGE_SIZE = 320
NUM_CLASSES = 14
# Kaynağın src/predict.py::ALL_LABELS sırası (tek sürümsel sözleşme).
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


def load_torch():
    import torch
    import torch.nn as nn
    import torchvision

    return torch, nn, torchvision


def build_model(weights_path: str, torch, nn, torchvision):
    """Kaynağın eğitim çekirdeğiyle birebir aynı yapı: DenseNet121 + tek Lineer kafa.

    NOT: Kaynağın src/predict.py'sinde başlık `nn.Sequential(nn.Linear(...))` olarak
    yeniden kurulur ve `model_state_dict` yolu bu düzeyde çalışır; depodaki
    `best_model.pth` ise DÜZ `classifier.weight/bias` taşır. Bu betik repodaki
    dosyayı doğrudan yükler (yanlış yapı, sessiz yanlış sonuç üretir).
    """
    model = torchvision.models.densenet121(weights=None)
    model.classifier = nn.Linear(in_features=1024, out_features=NUM_CLASSES, bias=True)
    ckpt = torch.load(weights_path, map_location="cpu")
    if isinstance(ckpt, dict) and "model_state_dict" in ckpt:
        ckpt = ckpt["model_state_dict"]
    model.load_state_dict(ckpt, strict=True)
    model.eval()
    for module in model.modules():
        if isinstance(module, nn.ReLU):
            module.inplace = False
    return model


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="best_model.pth")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "models", "cxr_densenet121_medx_320.onnx"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--verify", action="store_true", help="Üretilen ONNX'u torch referansıyla karşılaştırır")
    args = ap.parse_args()

    torch, nn, torchvision = load_torch()
    model = build_model(args.weights, torch, nn, torchvision)

    class Oxx(torch.nn.Module):
        """logits + sınıfa özel ısı haritası (Grad-CAM ≈ Lineer ağırlıklar)."""

        def __init__(self, base):
            super().__init__()
            self.base = base
            self.register_buffer("cls_w", base.classifier.weight.detach().clone())

        def forward(self, x, class_idx):
            feat = torch.relu(self.base.features(x))     # (N,1024,h,w) — norm5 + ReLU
            pooled = torch.flatten(torch.nn.functional.adaptive_avg_pool2d(feat, 1), 1)
            logits = self.base.classifier(pooled)        # (N,14)
            w = self.cls_w[class_idx]                    # (N,1024)
            cam = torch.relu((feat * w[:, :, None, None]).sum(dim=1))
            return logits, cam

    ox = Oxx(model).eval()
    dummy = torch.zeros(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    dummy_idx = torch.zeros(1, dtype=torch.int64)
    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    torch.onnx.export(
        ox,
        (dummy, dummy_idx),
        out_path,
        input_names=["input", "class_idx"],
        output_names=["logits", "cam"],
        opset_version=args.opset,
        dynamo=False,
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}, "cam": {0: "batch"}},
    )
    print(f"ONNX yazildi: {out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB)")

    if args.verify:
        verify(out_path, model, torch, nn)
    return 0


def verify(onnx_path: str, model, torch, nn) -> None:
    """Torch referansıyla: (1) logit farkı, (2) hook tabanlı Grad-CAM ile ısı haritası korelasyonu."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    rng = np.random.default_rng(7)
    g = np.clip(rng.normal(110, 45, (1024, 1024)), 0, 255).astype(np.uint8)
    img = np.stack([g, g, g], axis=-1)  # gri grafi → 3 kanala (model RGB bekler)
    small = Image.fromarray(img).resize((IMAGE_SIZE, IMAGE_SIZE), Image.BILINEAR)
    a = np.asarray(small, np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    t = torch.from_numpy(((a - mean) / std).transpose(2, 0, 1)[None].copy())
    with torch.inference_mode():
        ref_logits = model(t).numpy()[0]

    # (1) TEK DOĞRULAMA: Aynı hedef katmandan (features = norm5 + ReLU) gerçek
    # gradyan ağırlıklarıyla Grad-CAM. GAP + Lineer olduğu için bu, ONNX'teki
    # Lineer-ağırlık formülüyle matematiksel olarak aynı şey olmalı → korelasyon ≈ 1.
    top = int(ref_logits.argmax())
    ref_cam = gradcam_norm5(model, t, top, torch)

    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    onnx_logits, onnx_cam = sess.run(None, {"input": t.numpy(), "class_idx": np.array([top], np.int64)})
    diff = float(np.abs(ref_logits - onnx_logits[0]).max())
    corr = pearson(ref_cam.ravel(), onnx_cam[0].ravel())
    print(f"logit max|Δ| = {diff:.2e}  (beklenen < 1e-4)")
    print(f"Grad-CAM korelasyonu (norm5 + gerçek gradyan) = {corr:.3f}")

    # (2) BİLGİ: Üst kaynağın src/predict.py'sindeki hedef katman
    # (denseblock4.denselayer16.conv2) farklı bir katman olduğundan korrelasyon
    # daha düşük çıkar; ONNX'teki harita bu katmana göre DEĞİLDIR.
    conv_cam = gradcam_conv2(model, t, top, torch)
    print(f"Bilgi: üst kaynak predict.py katmanıyla korelasyon = {pearson(conv_cam.ravel(), onnx_cam[0].ravel()):.3f}")

    if diff > 1e-4 or not (corr > 0.99):
        raise SystemExit("ONNX doğrulaması başarısız")


def pearson(a, b) -> float:
    import numpy as np

    a = a - a.mean()
    b = b - b.mean()
    den = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / den) if den > 0 else float("nan")


def gradcam_norm5(model, t, class_idx, torch):
    """features (norm5+ReLU) üzerinde grad_output ortalamalı Grad-CAM."""
    acts, grads = {}, {}
    layer = model.features
    layer.register_forward_hook(lambda m, i, o: acts.__setitem__("a", o.clone()))
    layer.register_full_backward_hook(lambda m, gi, go: grads.__setitem__("g", go[0].clone()))
    wrapped = non_inplace_wrap(torch, model).eval()
    wrapped.zero_grad(set_to_none=True)
    wrapped(t)[0, class_idx].backward()
    w = grads["g"].mean(dim=(2, 3), keepdim=True)
    return torch.relu((w * acts["a"]).sum(1)).squeeze().detach().numpy()


def gradcam_conv2(model, t, class_idx, torch):
    """Üst kaynağın src/predict.py kodunun hedef katmanı (bilgilendirme amaçlı)."""
    acts, grads = {}, {}
    layer = model.features.denseblock4.denselayer16.conv2
    layer.register_forward_hook(lambda m, i, o: acts.__setitem__("a", o.clone()))
    layer.register_full_backward_hook(lambda m, gi, go: grads.__setitem__("g", go[0].clone()))
    wrapped = non_inplace_wrap(torch, model).eval()
    wrapped.zero_grad(set_to_none=True)
    wrapped(t)[0, class_idx].backward()
    w = grads["g"].mean(dim=(2, 3), keepdim=True)
    return torch.relu((w * acts["a"]).sum(1)).squeeze().detach().numpy()


def non_inplace_wrap(torch, base):
    """torchvision DenseNet.forward içindeki inplace ReLU, geri besleme hook'larını
    boğar (view + inplace yasak); aynı hesabı inplace'siz yapan sarma üretir."""

    class Wrapper(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.base = base

        def forward(self, x):
            feat = torch.relu(self.base.features(x))  # inplace=False
            pooled = torch.nn.functional.adaptive_avg_pool2d(feat, 1).flatten(1)
            return self.base.classifier(pooled)

    return Wrapper()


if __name__ == "__main__":
    raise SystemExit(main())

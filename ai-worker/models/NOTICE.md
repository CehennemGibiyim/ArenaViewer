# CXR (akciğer grafisi) model ağırlığı — kaynak ve lisans bildirimi

Bu dizindeki `cxr_densenet121_medx_320.onnx`, açık kaynaklı bir proje olan
**Harsh-Prajapati54/Medical_X** ("Med-X — Chest X-Ray Disease Detection")
projesinin eğitilmiş ağırlıklarından **türetilmiştir**.

| Öğe | Değer |
|---|---|
| Üst kaynak | https://github.com/Harsh-Prajapati54/Medical_X |
| Lisans | **Apache-2.0** (tam metin: `LICENSE.Medical_X.txt`) |
| Kaynak commit | `9f5afbfbaa2183faa79e6ff4664a4de1af84d4fc` (2026-10-06) |
| Kaynak ağırlık dosyası | `best_model.pth` (28.479.976 bayt) |
| Kaynak blob sha | `06b0a1ea2426fb09798249483048909e348d6951` |
| Kaynak sha256 | `ef369ad8869f1fe837eb344e0cecda973138b0c28ac775f259a9775a499a7b11` |
| Türetilen ONNX | `cxr_densenet121_medx_320.onnx` (28.270.117 bayt) |
| ONNX sha256 | `5471902106c5b7d8c7f40b7fdfa6b64d13a3f7ea12694d3979c5848391d1949b` |

## Nasıl üretildi

`ai-worker/tools/export_cxr_onnx.py` betiği kaynak `.pth` dosyasını yükler,
DenseNet121 + 14 sınıflı Lineer kafa yapısını kurar ve tek bir ONNX grafiğine
çıkarır. Grafiğin **iki çıktısı** vardır:

- `logits` — 14 sınıfın sigmoid'ten önceki ham çıktısı;
- `cam` — istenen sınıfa ait ısı haritası (10×10, normalize edilmemiş).

Ağırlıkların orijinalliği betikle doğrulanır:

```
python ai-worker/tools/export_cxr_onnx.py --weights best_model.pth --verify
```

Çıktı (bu depo için alınan):

```
logit max|Δ| = 8.34e-07  (beklenen < 1e-4)
Grad-CAM korelasyonu (norm5 + gerçek gradyan) = 0.995
```

Yani ONNX, PyTorch referansına sayısal olarak birebir; ısı haritası da aynı
katman üzerinde **gerçek gradyan ağırlıklarıyla** hesaplanan Grad-CAM ile
%99,5 korelasyonludur.

### Neden gradyan geri beslemesi gerekmiyor?

Mimari, `features → ReLU → Global Average Pooling → Linear(1024→14)` olduğu
için Grad-CAM'ın altı gradyan ağırlıkları `∂logit_c/∂f_k = W_{c,k}` olur. Bu
nedenle ısı haritası, ağır bir otograd gerektirmeden yalnızca ONNX Runtime ile
hesaplanabilir (betikte bu denklik doğrulanmıştır).

> Not: Üst kaynağın `src/predict.py` betiği ısı haritası için
> `denseblock4.denselayer16.conv2` katmanını kullanır. Biz, son birleştirilmiş
> özellik haritasını (`features`/`norm5`) hedef alıyoruz; bu katman
> mimarisinin doğal hedefidir ve üst kaynağın kendi README'sinde de
> "Grad-CAM target layer: model.features.norm5" olarak yazılır.

## Sorumluluk reddi (üst kaynaktan alıntı)

> **Not a medical device.** This is a research and learning project. It must not
> be used for diagnosis or any clinical decision.

Model NIH ChestX-ray14 (112.120 grafi) üzerinde eğitilmiştir; etiketler rapor
metinlerinden NLP ile çıkarılmıştır (zayıf etiketleme). Klinik doğrulama
yapılmamıştır. Uygulamadaki tüm bulgular **aday** niteliğindedir ve radyoloji
uzmanı onayı olmadan geçerli değildir.

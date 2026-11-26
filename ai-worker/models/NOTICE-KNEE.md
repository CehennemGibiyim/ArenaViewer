# Diz MR segmentasyon modeli — kaynak ve lisans bildirimi

Bu depo, diz MR segmentasyonu için **önceden eğitilmiş ağırlık barındırmaz**.
Kullanıcı `python ai-worker/setup_knee_model.py` çalıştırdığında aşağıdaki
kaynaktan indirilir; bildirimi burada tutulur.

| Öğe | Değer |
|---|---|
| Kaynak | https://huggingface.co/aagatti/nnunet_knee |
| Lisans | **MIT** (model kartında beyan edilir; depoda ayrıca LICENSE dosyası yoktur) |
| Sürüm | 1.0 (model kartı, 2025) |
| SHA (indirme anı) | `6ccfbd6c5756c8f203f8f0170305cfb0d7bb3221` (2026-11-26 listelendi) |
| Checkpoint'ler | yalnız `Dataset500_KneeMRI/…3d_lowres/fold_1/checkpoint_final.pth` ve `…3d_cascade_fullres/fold_1/checkpoint_final.pth` indirilir (≈5 GB; `3d_fullres` atlanır) |
| Eğitim verisi | OAI-ZIB (yalnız akademik/araştırma erişimli; kullanıcı indirdiğinde ayrı şartlara tabidir) |
| Çerçeve | nnU-Net v2 (Apache-2.0) — `requirements.txt` üzerinden kurulur |

## Atıf

    Goyal, A., Belibi, F., Sahani, V., Pedersen, R., Vainberg, Y., Williams, A.,
    Chu, C., Haddock, B., Gold, G., Chaudhari, A., Kogan, F., Gatti, A. (2025).
    Automating Imaging Biomarker Analysis for Knee Osteoarthritis Using an
    Open-Source MRI-Based Deep Learning Pipeline. medRxiv 2025.02.21.25322094.
    https://doi.org/10.1101/2025.02.21.25322094

## Sınırlar

Çıktı **yalnız anatomik yapı sınırıdır** (medial/lateral menisküs, 4 kıkırdak
bölgesi, femur/tibia/patella kemiği; etiket 1..9). Yırtık veya dejenerasyon
derecesi **sınıflamaz**. Model T2 ağırlıklı **sagittal** diz MR ile
eğitilmiştir; başka sekans/düzlemlerde kalite düşer. Kendini bildirilen Dice:
≈0,84 menisküs / ≈0,86 kıkırdak / ≈0,95 kemik / 0,906 ortalama; **prospektif
klinik doğrulaması yoktur**. Araştırma amaçlıdır; radyoloji uzmanı onayı
olmadan klinik olarak kullanılamaz; tıbbi cihaz değildir.

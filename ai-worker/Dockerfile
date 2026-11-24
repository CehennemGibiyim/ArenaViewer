# ATIKVIEWER yerel derin AI worker'ı (torch CPU + MONAI + ICH modelleri).
# Kullanım: docker compose --profile ai up --build -d
# GPU için: taban image olarak nvidia/cuda:* veya CUDA'lı torch index'i kullanın.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ATIK_WORKER_HOST=0.0.0.0 \
    ATIK_WORKER_PORT=8787 \
    ATIK_MODEL_DIR=/models/model \
    ATIK_BRAIN_DIR=/models/brain

# torch CPU tekerlekleri daha küçüktür; libgomp1 OpenMP için gereklidir.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
  && pip install -r requirements.txt

COPY . .

VOLUME ["/models"]
EXPOSE 8787

# İlk açılışta iki modeli (~231 MB) indirir; ATIK_SKIP_SETUP=1 ile atlanabilir
# (modeller önceden /models volume'üne konmuşsa).
CMD ["sh", "-c", "if [ \"${ATIK_SKIP_SETUP:-0}\" != \"1\" ]; then python setup_model.py; fi; exec python server.py"]

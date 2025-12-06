FROM python:3.10-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
# Install dependencies into the system environment (no venv needed in container)
RUN uv pip install --system -r pyproject.toml

# Pre-download MegaDetector v1000 (Cedar)
RUN curl -L -o md_v1000.pt https://huggingface.co/boquila/megadetector-v1000/resolve/main/MDv1000-cedar.bq

COPY . .

CMD ["python", "main.py"]

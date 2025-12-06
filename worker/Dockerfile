FROM ultralytics/yolov5:latest
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app



COPY pyproject.toml .
# Install dependencies into the system environment (no venv needed in container)
RUN uv pip install --system -r pyproject.toml

# Pre-download MegaDetector v1000 (Cedar)
RUN curl -L -o md_v1000.pt https://huggingface.co/boquila/megadetector-v1000/resolve/main/MDv1000-cedar.bq

COPY . .

CMD ["python", "main.py"]

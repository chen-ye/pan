FROM ultralytics/yolov5:latest
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app



COPY pyproject.toml .
# Install dependencies into the system environment (no venv needed in container)
RUN uv pip install --system -r pyproject.toml


# Dependencies installed via pyproject.toml


COPY . .

CMD ["python", "main.py"]

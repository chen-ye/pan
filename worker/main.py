import os
import sys

# Ensure shared libraries (e.g. Homebrew FFmpeg) are discoverable by ld.so before loading C extensions.
BREW_LIB = "/home/linuxbrew/.linuxbrew/lib"
if os.path.isdir(BREW_LIB):
    current_ld = os.environ.get("LD_LIBRARY_PATH", "")
    if sys.argv and sys.argv[0] != "-c" and BREW_LIB not in current_ld.split(":") and os.environ.get("_PAN_REEXEC") != "1":
        new_env = os.environ.copy()
        new_env["LD_LIBRARY_PATH"] = f"{BREW_LIB}:{current_ld}".strip(":")
        new_env["_PAN_REEXEC"] = "1"
        os.execve(sys.executable, [sys.executable, *sys.argv], new_env)

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

import torch
from detector import VideoProcessor
from flask import Flask, Response, jsonify, request, stream_with_context

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pan-worker")

app = Flask(__name__)

DATA_DIR = os.environ.get("DATA_DIR", "/data")
MODEL_VERSION = os.environ.get("MODEL_VERSION", "MDv1000-redwood")

processor: VideoProcessor | None = None
try:
    processor = VideoProcessor(model_version=MODEL_VERSION)
except Exception as e:  # noqa: BLE001
    logger.error("Failed to initialize VideoProcessor: %s", e)


@app.route("/process", methods=["POST"])
def handle_process() -> tuple[Response, int] | Response:
    if processor is None:
        return jsonify({"error": "VideoProcessor model not loaded"}), 500

    data: dict[str, Any] = request.get_json(silent=True) or {}
    rel_path = data.get("path")
    if not rel_path:
        return jsonify({"error": "No path provided"}), 400

    video_path = Path(DATA_DIR) / rel_path

    def generate():
        for chunk in processor.process_video_stream(video_path, rel_path=rel_path):
            yield json.dumps(chunk) + "\n"
            sys.stdout.flush()

    response = Response(stream_with_context(generate()), mimetype="application/x-ndjson")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.route("/status", methods=["GET"])
def status() -> Response:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    return jsonify({
        "status": "ready" if processor is not None else "error",
        "device": device,
        "model": MODEL_VERSION,
        "engine": "torchcodec",
    })


@app.route("/stats", methods=["GET"])
def handle_stats() -> Response:
    stats: dict[str, Any] = {}
    if torch.cuda.is_available():
        stats["gpu_name"] = torch.cuda.get_device_name(0)
        free, total = torch.cuda.mem_get_info(0)
        stats["memory_free"] = free
        stats["memory_total"] = total
        stats["memory_used"] = total - free

        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if result.returncode == 0:
                stats["utilization"] = int(result.stdout.strip().split("\n")[0])
        except (subprocess.SubprocessError, OSError, ValueError) as err:
            logger.debug("nvidia-smi error: %s", err)
    else:
        stats["error"] = "No CUDA device found"

    return jsonify(stats)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

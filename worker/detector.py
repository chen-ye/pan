"""Deep module for video detection using torchcodec and MegaDetector."""

import json
import logging
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import torch
import torchvision.transforms.functional as TF
from megadetector.detection import run_detector
from torchcodec.decoders import VideoDecoder

logger = logging.getLogger(__name__)

CLASS_MAPPING: dict[Any, str] = {
    1: "animal",
    2: "person",
    3: "vehicle",
    "1": "animal",
    "2": "person",
    "3": "vehicle",
}


def extract_detections_from_batch(
    batch_results: list[dict[str, Any]],
    fps: float,
    conf_threshold: float,
) -> list[dict[str, Any]]:
    """Parse raw MegaDetector batch detections into Pan schema."""
    extracted: list[dict[str, Any]] = []
    for res in batch_results:
        frame_num = int(res["file"])
        if res.get("detections"):
            for d in res["detections"]:
                conf = float(d["conf"])
                if conf > conf_threshold:
                    cat_id = d["category"]
                    class_name = CLASS_MAPPING.get(cat_id, f"unknown_{cat_id}")
                    x, y, w, h = d["bbox"]
                    bbox = [float(x), float(y), float(x + w), float(y + h)]
                    timestamp = float(frame_num / fps) if fps > 0 else 0.0
                    extracted.append({
                        "frame": frame_num,
                        "timestamp": round(timestamp, 3),
                        "category": class_name,
                        "conf": round(conf, 4),
                        "bbox": [round(coord, 5) for coord in bbox],
                    })
    return extracted


def save_atomic_json(json_path: Path, data: dict[str, Any]) -> None:
    """Save dictionary to JSON atomically using a PID-based temporary file."""
    tmp_path = Path(f"{json_path}.tmp.{os.getpid()}")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        tmp_path.replace(json_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


class VideoProcessor:
    """Encapsulates torchcodec frame decoding, PyTorch resizing, and MegaDetector inference."""

    def __init__(
        self,
        model_version: str = "MDv1000-redwood",
        device: str | None = None,
    ) -> None:
        self.model_version = model_version
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")

        force_cpu = self.device == "cpu"
        logger.info("Loading MegaDetector model '%s' (device: %s)...", self.model_version, self.device)
        self.model = run_detector.load_detector(self.model_version, force_cpu=force_cpu)
        logger.info("MegaDetector model loaded successfully.")

    def process_video_stream(
        self,
        video_path: str | Path,
        rel_path: str | None = None,
        batch_size: int = 32,
        conf_threshold: float = 0.2,
        frame_fps: float = 4.0,
        target_size: int = 1280,
    ) -> Iterator[dict[str, Any]]:
        """Process a video file, yielding NDJSON status dicts as processing advances."""
        target_file = Path(video_path).resolve()
        relative_video_name = rel_path or target_file.name

        if not target_file.exists():
            yield {"error": f"File not found: {video_path}"}
            return

        logger.info("Starting processing for %s...", target_file)
        yield {"status": "starting", "path": str(target_file)}

        try:
            decoder = VideoDecoder(str(target_file), seek_mode="approximate", dimension_order="NHWC")
        except Exception as err:  # noqa: BLE001
            logger.error("Failed to open video decoder for %s: %s", target_file, err)
            yield {"error": f"Failed to open video decoder: {err}"}
            return

        meta = decoder.metadata
        fps = float(meta.average_fps or 0.0)
        total_frames = int(meta.num_frames or 0)
        width = int(meta.width or 0)
        height = int(meta.height or 0)

        if fps <= 0.0:
            yield {"error": f"Invalid video fps: {fps}"}
            return

        frame_interval = max(int(fps / frame_fps), 1)
        if total_frames <= 0:
            total_frames = 1000

        indices = list(range(0, total_frames, frame_interval))
        total_sample_frames = len(indices)

        results_list: list[dict[str, Any]] = []
        processed_count = 0

        for i in range(0, total_sample_frames, batch_size):
            chunk_indices = indices[i : i + batch_size]
            try:
                frame_batch = decoder.get_frames_at(chunk_indices)
            except Exception as err:  # noqa: BLE001
                logger.error("Failed decoding frames at indices %s: %s", chunk_indices[:3], err)
                continue

            raw_frames = frame_batch.data  # shape: (B, H, W, 3), uint8 RGB
            b, h, w, _ = raw_frames.shape

            max_dim = max(h, w)
            if max_dim > target_size:
                scale = target_size / max_dim
                new_w = int(w * scale)
                new_h = int(h * scale)
                tensor_chw = raw_frames.permute(0, 3, 1, 2)
                resized_tensor = TF.resize(tensor_chw, [new_h, new_w], antialias=True)
                batch_np = resized_tensor.permute(0, 2, 3, 1).cpu().numpy()
            else:
                batch_np = raw_frames.cpu().numpy()

            images_list = [batch_np[idx] for idx in range(b)]
            batch_results = self.model.generate_detections_one_batch(images_list, chunk_indices[:b])
            detections = extract_detections_from_batch(batch_results, fps, conf_threshold)
            results_list.extend(detections)

            processed_count += len(chunk_indices)
            progress = min(processed_count / max(total_sample_frames, 1), 1.0)
            yield {
                "status": "progress",
                "progress": round(progress, 3),
                "frame": chunk_indices[-1],
                "total_frames": total_frames,
            }

        json_path = Path(f"{target_file}.json")
        output_data = {
            "video": relative_video_name,
            "metadata": {
                "fps": round(fps, 2),
                "total_frames": total_frames,
                "width": width,
                "height": height,
            },
            "detections": results_list,
        }

        try:
            save_atomic_json(json_path, output_data)
            logger.info("Saved results to %s (%d detections).", json_path, len(results_list))
            yield {
                "status": "complete",
                "output": str(json_path),
                "detections_count": len(results_list),
                "detections": results_list,
            }
        except Exception as err:  # noqa: BLE001
            logger.error("Failed to save JSON sidecar %s: %s", json_path, err)
            yield {"error": f"Failed to save results: {err}"}

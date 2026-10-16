"""Deep module for video detection using torchcodec and torchvision-accelerated MegaDetector."""

import json
import logging
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torchvision.transforms.functional as TF
from megadetector.detection import run_detector
from torchcodec.decoders import VideoDecoder
from torchvision import ops

logger = logging.getLogger(__name__)

CLASS_MAPPING: dict[Any, str] = {
    1: "animal",
    2: "person",
    3: "vehicle",
    "1": "animal",
    "2": "person",
    "3": "vehicle",
}


class TorchVisionMegaDetector:
    """Torchvision-based MegaDetector implementation operating directly on GPU tensors.

    Follows the same general shape and interface as PTDetector (same configuration
    attributes, same generate_detections_one_batch contract, same output schema),
    but executes all aspect-ratio scaling, letterbox padding, model inference,
    and batched NMS entirely in PyTorch/Torchvision without host-RAM/OpenCV roundtrips.
    """

    def __init__(
        self,
        model_version: str = "MDv1000-redwood",
        device: str | torch.device | None = None,
        default_image_size: int = 1280,
        iou_threshold: float = 0.45,
        max_det: int = 300,
    ) -> None:
        self.model_version = model_version
        if device is None:
            self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        elif isinstance(device, str):
            self.device = torch.device(device)
        else:
            self.device = device

        force_cpu = self.device.type == "cpu"
        logger.info(
            "Loading MegaDetector model '%s' (device: %s)...",
            self.model_version,
            self.device,
        )
        base_detector = run_detector.load_detector(self.model_version, force_cpu=force_cpu)

        # Extract underlying YOLOv5 DetectionModel
        self.model = base_detector.model.to(self.device).eval()
        self.default_image_size = getattr(base_detector, "default_image_size", default_image_size)
        self.letterbox_stride = getattr(base_detector, "letterbox_stride", 64)
        self.iou_threshold = iou_threshold
        self.max_det = max_det

        logger.info(
            "TorchVisionMegaDetector ready: device=%s, image_size=%d, stride=%d",
            self.device,
            self.default_image_size,
            self.letterbox_stride,
        )

    def preprocess(
        self,
        frames: torch.Tensor | list[Any],
    ) -> tuple[torch.Tensor, float, tuple[int, int], tuple[int, int]]:
        """Preprocess batch of frames to padded letterbox tensor on device using torchvision.

        Returns:
            Tuple of (normalized_batch_tensor, scale_ratio, (pad_left, pad_top), (orig_h, orig_w))
        """
        if isinstance(frames, torch.Tensor):
            if frames.ndim == 3:
                # Shape (H, W, C) -> unsqueeze to (1, C, H, W)
                orig_h, orig_w = frames.shape[0], frames.shape[1]
                x = frames.unsqueeze(0).permute(0, 3, 1, 2)
            elif frames.ndim == 4:
                if frames.shape[-1] == 3:
                    # Shape (B, H, W, 3) -> (B, 3, H, W)
                    orig_h, orig_w = frames.shape[1], frames.shape[2]
                    x = frames.permute(0, 3, 1, 2)
                else:
                    # Shape (B, 3, H, W)
                    orig_h, orig_w = frames.shape[2], frames.shape[3]
                    x = frames
            else:
                raise ValueError(f"Unsupported tensor shape: {frames.shape}")
            x = x.to(self.device)
        elif isinstance(frames, list):
            tensors: list[torch.Tensor] = []
            for item in frames:
                if isinstance(item, np.ndarray):
                    t = torch.from_numpy(item)
                    if t.ndim == 3 and t.shape[-1] == 3:
                        t = t.permute(2, 0, 1)
                    tensors.append(t)
                elif hasattr(item, "convert"):  # PIL Image
                    t = TF.to_tensor(item)
                    t = (t * 255.0).to(torch.uint8)
                    tensors.append(t)
                elif isinstance(item, torch.Tensor):
                    t = item
                    if t.ndim == 3 and t.shape[-1] == 3:
                        t = t.permute(2, 0, 1)
                    tensors.append(t)
                else:
                    raise TypeError(f"Unsupported frame type in list: {type(item)}")
            if not tensors:
                raise ValueError("Cannot preprocess empty frames list")
            x = torch.stack(tensors).to(self.device)
            orig_h, orig_w = x.shape[2], x.shape[3]
        else:
            raise TypeError(f"Unsupported frames input type: {type(frames)}")

        # Calculate scale ratio to preserve aspect ratio
        scale = min(self.default_image_size / orig_h, self.default_image_size / orig_w)
        new_h = round(orig_h * scale)
        new_w = round(orig_w * scale)

        # Resize on GPU using torchvision
        x_resized = TF.resize(
            x,
            [new_h, new_w],
            interpolation=TF.InterpolationMode.BILINEAR,
            antialias=True,
        )

        # Compute letterbox padding to multiple of letterbox_stride
        pad_h = (self.letterbox_stride - (new_h % self.letterbox_stride)) % self.letterbox_stride
        pad_w = (self.letterbox_stride - (new_w % self.letterbox_stride)) % self.letterbox_stride
        top = pad_h // 2
        bottom = pad_h - top
        left = pad_w // 2
        right = pad_w - left

        # Pad with standard YOLO background gray (fill=114)
        x_padded = TF.pad(x_resized, [left, top, right, bottom], fill=114)

        # Normalize uint8 to float32 [0.0, 1.0]
        x_norm = x_padded.to(dtype=torch.float32) / 255.0

        return x_norm, scale, (left, top), (orig_h, orig_w)

    def postprocess(
        self,
        preds: torch.Tensor,
        scale: float,
        pad: tuple[int, int],
        orig_shape: tuple[int, int],
        image_ids: list[Any] | None = None,
        detection_threshold: float = 0.00001,
    ) -> list[dict[str, Any]]:
        """Postprocess raw model predictions using torchvision batched NMS."""
        left, top = pad
        orig_h, orig_w = orig_shape
        batch_size = preds.shape[0]
        results: list[dict[str, Any]] = []

        for i in range(batch_size):
            img_id = str(image_ids[i]) if image_ids and i < len(image_ids) else f"index_{i}"
            p = preds[i]  # shape: (num_anchors, 5 + num_classes)

            obj_conf = p[:, 4]
            class_probs = p[:, 5:]
            scores = class_probs * obj_conf.unsqueeze(1)
            best_scores, best_classes = scores.max(dim=1)

            mask = best_scores > detection_threshold
            if not mask.any():
                results.append({
                    "file": img_id,
                    "max_detection_conf": 0.0,
                    "detections": [],
                    "failure": None,
                })
                continue

            valid_boxes = p[mask, :4]
            valid_scores = best_scores[mask]
            valid_classes = best_classes[mask]

            # Convert YOLO [center_x, center_y, width, height] -> [x1, y1, x2, y2]
            x1 = valid_boxes[:, 0] - valid_boxes[:, 2] / 2.0
            y1 = valid_boxes[:, 1] - valid_boxes[:, 3] / 2.0
            x2 = valid_boxes[:, 0] + valid_boxes[:, 2] / 2.0
            y2 = valid_boxes[:, 1] + valid_boxes[:, 3] / 2.0
            boxes_xyxy = torch.stack([x1, y1, x2, y2], dim=1)

            # Batched NMS on GPU
            keep = ops.batched_nms(
                boxes_xyxy,
                valid_scores,
                valid_classes,
                iou_threshold=self.iou_threshold,
            )
            keep = keep[: self.max_det]

            kept_boxes = boxes_xyxy[keep].clone()
            kept_scores = valid_scores[keep]
            kept_classes = valid_classes[keep]

            # Invert letterbox padding and scaling back to original frame dimensions
            kept_boxes[:, [0, 2]] -= left
            kept_boxes[:, [1, 3]] -= top
            kept_boxes[:, :4] /= scale

            # Normalize to [0.0, 1.0] relative to original image size
            norm_x = (kept_boxes[:, 0] / orig_w).clamp(0.0, 1.0)
            norm_y = (kept_boxes[:, 1] / orig_h).clamp(0.0, 1.0)
            norm_w = ((kept_boxes[:, 2] - kept_boxes[:, 0]) / orig_w).clamp(0.0, 1.0)
            norm_h = ((kept_boxes[:, 3] - kept_boxes[:, 1]) / orig_h).clamp(0.0, 1.0)

            detections: list[dict[str, Any]] = []
            max_conf = 0.0

            for det_idx in range(len(keep)):
                conf = round(float(kept_scores[det_idx].item()), 4)
                cls_id = str(int(kept_classes[det_idx].item()) + 1)
                bbox = [
                    round(float(norm_x[det_idx].item()), 5),
                    round(float(norm_y[det_idx].item()), 5),
                    round(float(norm_w[det_idx].item()), 5),
                    round(float(norm_h[det_idx].item()), 5),
                ]
                detections.append({
                    "category": cls_id,
                    "conf": conf,
                    "bbox": bbox,
                })
                max_conf = max(max_conf, conf)

            results.append({
                "file": img_id,
                "max_detection_conf": round(max_conf, 4),
                "detections": detections,
                "failure": None,
            })

        return results

    def generate_detections_one_batch(
        self,
        frames: torch.Tensor | list[Any],
        image_ids: list[Any] | None = None,
        detection_threshold: float = 0.00001,
    ) -> list[dict[str, Any]]:
        """Run detector on a batch of frames, matching PTDetector interface."""
        x_norm, scale, (left, top), (orig_h, orig_w) = self.preprocess(frames)
        with torch.inference_mode():
            raw_out = self.model(x_norm)
            preds = raw_out[0] if isinstance(raw_out, (list, tuple)) else raw_out

        return self.postprocess(
            preds,
            scale=scale,
            pad=(left, top),
            orig_shape=(orig_h, orig_w),
            image_ids=image_ids,
            detection_threshold=detection_threshold,
        )


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
    """Encapsulates torchcodec frame decoding and Torchvision MegaDetector inference."""

    def __init__(
        self,
        model_version: str = "MDv1000-redwood",
        device: str | None = None,
    ) -> None:
        self.model_version = model_version
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.detector = TorchVisionMegaDetector(
            model_version=self.model_version,
            device=self.device,
        )

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

            # Pure GPU pipeline: feed decoded tensor directly to TorchVisionMegaDetector
            raw_frames = frame_batch.data  # shape: (B, H, W, 3), uint8 RGB tensor
            batch_results = self.detector.generate_detections_one_batch(
                raw_frames,
                image_ids=chunk_indices,
                detection_threshold=conf_threshold,
            )
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

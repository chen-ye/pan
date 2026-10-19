"""Deep module for video detection using NVIDIA DALI hardware decoding and TorchVision MegaDetector."""

import json
import logging
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torchvision.transforms.functional as TF
from megadetector.detection import run_detector
from nvidia.dali import fn, pipeline_def
from torchvision import ops

logger = logging.getLogger(__name__)


class DaliVideoDecoder:
    """Hardware-accelerated video decoder using NVIDIA DALI and NVDEC."""

    def __init__(
        self,
        video_path: str | Path,
        step: int = 6,
        batch_size: int = 32,
        device_id: int = 0,
    ) -> None:
        self.video_path = str(Path(video_path).resolve())
        self.step = max(int(step), 1)
        self.batch_size = batch_size
        self.device_id = device_id

        # Define DALI graph using modern experimental video reader with NVDEC
        @pipeline_def(batch_size=self.batch_size, num_threads=4, device_id=self.device_id)
        def video_pipe():
            outputs = fn.experimental.readers.video(
                filenames=[self.video_path],
                sequence_length=1,
                step=self.step,
                enable_frame_num="scalar",
                enable_timestamps=True,
                device="gpu",
            )
            return outputs[0], outputs[1], outputs[2]

        self.pipe = video_pipe()
        self.pipe.build()

        epoch_dict = self.pipe.epoch_size()
        self.total_samples = next(iter(epoch_dict.values())) if epoch_dict else 0
        self.total_batches = (self.total_samples + self.batch_size - 1) // self.batch_size if self.total_samples > 0 else 0
        self._samples_read = 0
        self.is_partial = False
        self.partial_reason: str | None = None

    @property
    def samples_read(self) -> int:
        return self._samples_read

    def __iter__(self) -> "DaliVideoDecoder":
        return self

    def __next__(self) -> tuple[torch.Tensor, list[int], list[float]]:
        if self._samples_read >= self.total_samples:
            raise StopIteration

        try:
            out = self.pipe.run()
        except RuntimeError as e:
            err_str = str(e)
            if ("av_bsf_receive_packet" in err_str or "Critical error in pipeline" in err_str) and self._samples_read > 0:
                self.is_partial = True
                self.partial_reason = "corrupt_trailing_packet"
                logger.warning(
                    "Corrupt EOF/trailing packet encountered on %s after %d/%d frames; stopping gracefully (partial=True).",
                    self.video_path,
                    self._samples_read,
                    self.total_samples,
                )
                raise StopIteration from None
            raise

        raw_frames = torch.from_dlpack(out[0].as_tensor()).squeeze(1)  # shape: (B, H, W, 3) uint8 in VRAM
        raw_fnums = torch.from_dlpack(out[1].as_tensor()).squeeze(-1)
        raw_ts = torch.from_dlpack(out[2].as_tensor()).squeeze(-1)

        valid_count = min(self.batch_size, self.total_samples - self._samples_read)
        self._samples_read += valid_count

        frames = raw_frames[:valid_count]
        fnums = [int(n.item()) for n in raw_fnums[:valid_count]]
        timestamps = [round(float(t.item()), 3) for t in raw_ts[:valid_count]]

        return frames, fnums, timestamps

    def close(self) -> None:
        """Release DALI pipeline and terminate background C++ prefetch worker threads."""
        pipe = getattr(self, "pipe", None)
        if pipe is not None:
            self.pipe = None
            try:
                if hasattr(pipe, "_shutdown"):
                    pipe._shutdown()
                del pipe
            except Exception as err:  # noqa: BLE001
                logger.debug("DALI pipeline cleanup error: %s", err)

    def __del__(self) -> None:
        self.close()


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
        fp16: bool = True,
    ) -> None:
        self.model_version = model_version
        if device is None:
            self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        elif isinstance(device, str):
            self.device = torch.device(device)
        else:
            self.device = device

        self.fp16 = bool(fp16 and self.device.type == "cuda")
        force_cpu = self.device.type == "cpu"
        logger.info(
            "Loading MegaDetector model '%s' (device: %s, fp16: %s)...",
            self.model_version,
            self.device,
            self.fp16,
        )
        base_detector = run_detector.load_detector(self.model_version, force_cpu=force_cpu)

        # Extract underlying YOLOv5 DetectionModel
        self.model = base_detector.model.to(self.device).eval()
        if self.fp16:
            self.model = self.model.half()

        self.default_image_size = getattr(base_detector, "default_image_size", default_image_size)
        self.letterbox_stride = getattr(base_detector, "letterbox_stride", 64)
        self.iou_threshold = iou_threshold
        self.max_det = max_det
        self.categories = self._init_categories()

        logger.info(
            "TorchVisionMegaDetector ready: device=%s, fp16=%s, image_size=%d, stride=%d, categories=%s",
            self.device,
            self.fp16,
            self.default_image_size,
            self.letterbox_stride,
            self.categories,
        )

    def _init_categories(self) -> dict[str, str]:
        """Dynamically extract category mapping from model weights with standard fallback."""
        names = getattr(self.model, "names", None)
        if isinstance(names, dict):
            min_k = min(names.keys()) if names else 0
            offset = 1 if min_k == 0 else 0
            return {str(k + offset): str(v) for k, v in names.items()}
        if isinstance(names, (list, tuple)):
            return {str(i + 1): str(v) for i, v in enumerate(names)}
        return {"1": "animal", "2": "person", "3": "vehicle"}

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

        # Normalize uint8 to float16 (if fp16) or float32 [0.0, 1.0]
        target_dtype = torch.float16 if self.fp16 else torch.float32
        x_norm = x_padded.to(dtype=target_dtype) / 255.0

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
        if preds.dtype == torch.float16:
            preds = preds.float()
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
    conf_threshold: float,
    timestamps: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Parse raw MegaDetector batch detections into MegaDetector schema."""
    extracted: list[dict[str, Any]] = []
    for i_res, res in enumerate(batch_results):
        frame_num = int(res["file"])
        ts = timestamps[i_res] if timestamps and i_res < len(timestamps) else 0.0
        if res.get("detections"):
            for d in res["detections"]:
                conf = float(d["conf"])
                if conf > conf_threshold:
                    cat_id = str(d["category"])
                    x, y, w, h = d["bbox"]
                    extracted.append({
                        "category": cat_id,
                        "conf": round(conf, 4),
                        "bbox": [round(float(c), 5) for c in (x, y, w, h)],
                        "frame_number": frame_num,
                        "timestamp": round(ts, 3),
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


def resolve_batch_size(
    requested: int | str | None = "auto",
    device: str | torch.device = "cuda:0",
) -> int:
    """Dynamically resolve optimal batch size based on real-time available GPU VRAM.

    Heuristic based on empirical RTX 3090 benchmarks:
    - free VRAM >= 16.0 GB: 64 (optimal throughput sweet spot; ~29.8 FPS)
    - 10.0 <= free VRAM < 16.0 GB: 32 (standard safe; ~28.2 FPS, ~7.5 GB allocation)
    - 6.0 <= free VRAM < 10.0 GB: 16 (moderate headroom; ~3.5 GB allocation)
    - free VRAM < 6.0 GB: 8 (low memory fallback)
    """
    if requested is not None and not (isinstance(requested, str) and requested.lower() == "auto"):
        try:
            val = int(requested)
            if val > 0:
                return val
        except (ValueError, TypeError):
            pass

    dev = torch.device(device) if isinstance(device, str) else device
    if dev.type != "cuda" or not torch.cuda.is_available():
        return 4

    try:
        dev_idx = dev.index if dev.index is not None else 0
        free_bytes, _ = torch.cuda.mem_get_info(dev_idx)
        reserved_bytes = torch.cuda.memory_reserved(dev_idx)
        allocated_bytes = torch.cuda.memory_allocated(dev_idx)
        reusable_bytes = max(reserved_bytes - allocated_bytes, 0)
        effective_free_bytes = free_bytes + reusable_bytes
        free_gb = effective_free_bytes / (1024**3)

        if free_gb >= 15.0:
            return 64
        if free_gb >= 9.0:
            return 32
        if free_gb >= 5.0:
            return 16
        return 8
    except Exception as err:  # noqa: BLE001
        logger.debug("Failed to query CUDA memory info: %s; falling back to batch size 64", err)
        return 64


class VideoProcessor:
    """Encapsulates NVIDIA DALI NVDEC frame decoding and Torchvision MegaDetector inference."""

    def __init__(
        self,
        model_version: str = "MDv1000-redwood",
        device: str | torch.device | None = None,
        fp16: bool = True,
        batch_size: int | str = "auto",
    ) -> None:
        self.model_version = model_version
        if device is None:
            self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        elif isinstance(device, str):
            self.device = torch.device(device)
        else:
            self.device = device
        self.device_id = (self.device.index or 0) if self.device.type == "cuda" else -1
        self.fp16 = fp16
        self.default_batch_size = batch_size
        self.detector = TorchVisionMegaDetector(
            model_version=self.model_version,
            device=self.device,
            fp16=self.fp16,
        )

    def process_video_stream(
        self,
        video_path: str | Path,
        rel_path: str | None = None,
        base_dir: str | Path | None = None,
        batch_size: int | str | None = None,
        conf_threshold: float = 0.2,
        frame_fps: float = 4.0,
        target_size: int = 1280,
    ) -> Iterator[dict[str, Any]]:
        """Process a video file, yielding NDJSON status dicts as processing advances."""
        target_file = Path(video_path).resolve()
        if rel_path:
            relative_video_name = rel_path
        elif base_dir:
            base_path = Path(base_dir).resolve()
            if base_path in target_file.parents:
                relative_video_name = str(target_file.relative_to(base_path))
            else:
                relative_video_name = target_file.name
        else:
            relative_video_name = target_file.name

        if not target_file.exists():
            yield {"error": f"File not found: {video_path}"}
            return

        current_batch_size = resolve_batch_size(
            batch_size if batch_size is not None else self.default_batch_size,
            self.device,
        )

        logger.info(
            "Starting DALI NVDEC processing for %s (batch_size=%d)...",
            target_file,
            current_batch_size,
        )

        step = max(int(12.0 / frame_fps), 1)
        max_oom_retries = 2

        for attempt in range(max_oom_retries + 1):
            decoder = None
            try:
                try:
                    decoder = DaliVideoDecoder(
                        target_file,
                        step=step,
                        batch_size=current_batch_size,
                        device_id=max(self.device_id, 0),
                    )
                except Exception as err:  # noqa: BLE001
                    logger.error("Failed to open DALI video decoder for %s: %s", target_file, err)
                    yield {"error": f"Failed to open DALI video decoder: {err}"}
                    return

                total_sample_frames = decoder.total_samples
                if total_sample_frames == 0:
                    yield {"error": f"Video contains 0 decodeable samples: {target_file}"}
                    return

                yield {
                    "status": "starting",
                    "path": str(target_file),
                    "total_samples": total_sample_frames,
                    "total_frames": total_sample_frames * step,
                    "batch_size": current_batch_size,
                }

                results_list: list[dict[str, Any]] = []
                width = 0
                height = 0
                last_frame_num = 0
                last_timestamp = 0.0
                oom_occurred = False

                try:
                    for frames, fnums, timestamps in decoder:
                        if width == 0:
                            height = frames.shape[1]
                            width = frames.shape[2]

                        batch_results = self.detector.generate_detections_one_batch(
                            frames,
                            image_ids=fnums,
                            detection_threshold=conf_threshold,
                        )
                        detections = extract_detections_from_batch(
                            batch_results,
                            conf_threshold=conf_threshold,
                            timestamps=timestamps,
                        )
                        results_list.extend(detections)

                        last_frame_num = fnums[-1]
                        last_timestamp = timestamps[-1]

                        progress = min(decoder.samples_read / max(total_sample_frames, 1), 1.0)
                        yield {
                            "status": "progress",
                            "progress": round(progress, 3),
                            "frame": last_frame_num,
                            "batch_samples": len(fnums),
                            "total_frames": total_sample_frames * step,
                        }
                except (torch.cuda.OutOfMemoryError, RuntimeError) as err:
                    err_str = str(err)
                    if (
                        ("out of memory" in err_str.lower() or "cuda out of memory" in err_str.lower())
                        and attempt < max_oom_retries
                        and current_batch_size > 8
                    ):
                        oom_occurred = True
                        torch.cuda.empty_cache()
                        new_batch = max(current_batch_size // 2, 8)
                        logger.warning(
                            "CUDA OOM on %s at batch_size=%d. Reducing batch_size to %d and retrying (attempt %d/%d)...",
                            target_file.name,
                            current_batch_size,
                            new_batch,
                            attempt + 1,
                            max_oom_retries,
                        )
                        current_batch_size = new_batch
                        break
                    logger.error("Error during inference on %s: %s", target_file, err)
                    yield {"error": f"Error during inference: {err}"}
                    return

                if oom_occurred:
                    continue

                fps = round(last_frame_num / last_timestamp, 2) if last_timestamp > 0 else 12.0
                json_path = Path(f"{target_file}.json")
                is_partial = decoder.is_partial or (0 < decoder.samples_read < total_sample_frames)
                image_entry: dict[str, Any] = {
                    "file": relative_video_name,
                    "frame_rate": fps,
                    "total_frames": last_frame_num + 1,
                    "width": width,
                    "height": height,
                    "detections": results_list,
                }
                if is_partial:
                    image_entry["partial"] = True
                    if decoder.partial_reason:
                        image_entry["partial_reason"] = decoder.partial_reason

                output_data = {
                    "info": {
                        "format_version": "1.6",
                        "detector": self.model_version,
                        "detection_completion_time": datetime.now(UTC).isoformat(),
                        "detector_metadata": {
                            "image_size": target_size,
                            "typical_detection_threshold": conf_threshold,
                            "precision": "fp16" if getattr(self.detector, "fp16", False) else "fp32",
                            "batch_size": current_batch_size,
                        },
                    },
                    "detection_categories": getattr(
                        self.detector,
                        "categories",
                        {"1": "animal", "2": "person", "3": "vehicle"},
                    ),
                    "images": [image_entry],
                }

                try:
                    save_atomic_json(json_path, output_data)
                    logger.info(
                        "Saved results to %s (%d detections, partial=%s, batch_size=%d).",
                        json_path,
                        len(results_list),
                        is_partial,
                        current_batch_size,
                    )
                    yield {
                        "status": "complete",
                        "output": str(json_path),
                        "detections_count": len(results_list),
                        "partial": is_partial,
                        "result_data": output_data,
                        "detections": results_list,
                        "batch_size": current_batch_size,
                    }
                except Exception as err:  # noqa: BLE001
                    logger.error("Failed to save JSON sidecar %s: %s", json_path, err)
                    yield {"error": f"Failed to save results: {err}"}
                break
            finally:
                if decoder is not None:
                    decoder.close()

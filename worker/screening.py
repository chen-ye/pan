"""Screening and progressive multi-pass blank detection engine for Pan NVR.

Manages progressive stride screening (e.g. Stride 24 -> Stride 4 -> Stride 1),
early-exit triage, deterministic frame range filtering, and atomic sidecar augmentation.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class EvaluatedRange:
    """Represents a range of evaluated frames at a constant stride."""

    stride: int
    start: int
    end: int

    def contains(self, fnum: int) -> bool:
        """Return True if fnum was evaluated in this range."""
        if not (self.start <= fnum <= self.end):
            return False
        return (fnum - self.start) % self.stride == 0

    def to_dict(self) -> dict[str, int]:
        return {"stride": self.stride, "start": self.start, "end": self.end}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvaluatedRange:
        return cls(
            stride=int(data.get("stride", 1)),
            start=int(data.get("start", 0)),
            end=int(data.get("end", 0)),
        )


@dataclass
class ScreeningState:
    """Semantic status and progression tracking for a video sidecar."""

    status: str = "blank"  # "detected" | "blank" | "annotated"
    strides_completed: list[int] = field(default_factory=list)
    max_stride_evaluated: int = 24
    early_exit: bool = False
    early_exit_frame: int | None = None
    evaluated_ranges: list[EvaluatedRange] = field(default_factory=list)

    def is_certified_blank(self, min_stride: int = 1) -> bool:
        """Return True if video has 0 detections and was evaluated down to min_stride."""
        return self.status == "blank" and min_stride in self.strides_completed

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": "1.0",
            "status": self.status,
            "strides_completed": list(self.strides_completed),
            "max_stride_evaluated": self.max_stride_evaluated,
            "early_exit": self.early_exit,
            "early_exit_frame": self.early_exit_frame,
            "evaluated_ranges": [r.to_dict() for r in self.evaluated_ranges],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScreeningState:
        raw_ranges = data.get("evaluated_ranges", [])
        ranges = [EvaluatedRange.from_dict(r) for r in raw_ranges]
        return cls(
            status=str(data.get("status", "blank")),
            strides_completed=[int(s) for s in data.get("strides_completed", [])],
            max_stride_evaluated=int(data.get("max_stride_evaluated", 24)),
            early_exit=bool(data.get("early_exit", False)),
            early_exit_frame=data.get("early_exit_frame"),
            evaluated_ranges=ranges,
        )


def is_frame_evaluated(fnum: int, evaluated_ranges: list[EvaluatedRange]) -> bool:
    """Return True if fnum falls within any evaluated range."""
    return any(r.contains(fnum) for r in evaluated_ranges)


def compact_ranges(ranges: list[EvaluatedRange], total_frames: int | None = None) -> list[EvaluatedRange]:
    """Compacts range descriptors by removing ranges fully subsumed by finer complete strides."""
    if not ranges:
        return []

    # Sort ranges by stride ascending (finest first)
    sorted_ranges = sorted(ranges, key=lambda r: (r.stride, r.start, -r.end))
    compacted: list[EvaluatedRange] = []

    for r in sorted_ranges:
        # Check if already covered by an existing finer range
        subsumed = False
        for c in compacted:
            if c.start <= r.start and c.end >= r.end and (r.stride % c.stride == 0):
                subsumed = True
                break
        if not subsumed:
            compacted.append(r)

    return compacted


class SidecarScreeningManager:
    """Loads, verifies, updates, and atomically saves MegaDetector sidecars with screening metadata."""

    @staticmethod
    def load_sidecar(json_path: str | Path) -> tuple[dict[str, Any] | None, ScreeningState | None]:
        """Load sidecar JSON and extract its screening state.
        
        If sidecar exists without a screening block (e.g. legacy or prior full pass),
        infers screening state from detections and metadata.
        """
        p = Path(json_path)
        if not p.exists() or p.stat().st_size == 0:
            return None, None

        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as err:
            logger.warning("Failed to parse sidecar %s: %s", p, err)
            return None, None

        screening_dict = data.get("info", {}).get("screening")
        if screening_dict and isinstance(screening_dict, dict):
            return data, ScreeningState.from_dict(screening_dict)

        # Infer state from existing MegaDetector sidecar
        images = data.get("images", [])
        img = images[0] if images else {}
        detections = img.get("detections", [])
        is_partial = bool(img.get("partial", False))
        total_f = img.get("total_frames", 0)

        if len(detections) > 0:
            status = "detected" if is_partial else "annotated"
        else:
            status = "blank"

        inferred = ScreeningState(
            status=status,
            strides_completed=[4] if not is_partial else [],
            max_stride_evaluated=4,
            early_exit=is_partial,
            early_exit_frame=detections[0].get("frame") if (is_partial and detections) else None,
            evaluated_ranges=[EvaluatedRange(stride=4, start=0, end=max(total_f - 1, 0))] if total_f > 0 else [],
        )
        return data, inferred

    @staticmethod
    def merge_and_save_sidecar(
        json_path: str | Path,
        relative_video_name: str,
        width: int,
        height: int,
        fps: float,
        total_frames: int,
        new_detections: list[dict[str, Any]],
        new_range: EvaluatedRange | None,
        stride: int,
        early_exit: bool,
        early_exit_frame: int | None,
        conf_threshold: float,
        model_version: str = "MDv1000-redwood",
        is_annotation_pass: bool = False,
    ) -> dict[str, Any]:
        """Merge new detections with existing sidecar data and atomically write back to disk."""
        target_json = Path(json_path).resolve()
        existing_data, existing_state = SidecarScreeningManager.load_sidecar(target_json)

        all_detections: list[dict[str, Any]] = []
        if existing_data:
            existing_images = existing_data.get("images", [])
            if existing_images:
                all_detections.extend(existing_images[0].get("detections", []))

        # Append new detections
        all_detections.extend(new_detections)

        # Deduplicate detections by frame, category, and bbox (with 3-decimal rounding)
        seen_keys: set[tuple[int, str, float, float, float, float]] = set()
        deduped: list[dict[str, Any]] = []
        for d in all_detections:
            f = int(d.get("frame", 0))
            c = str(d.get("category", "1"))
            bbox = d.get("bbox", [0, 0, 0, 0])
            key = (
                f,
                c,
                round(float(bbox[0]), 3),
                round(float(bbox[1]), 3),
                round(float(bbox[2]), 3),
                round(float(bbox[3]), 3),
            )
            if key not in seen_keys:
                seen_keys.add(key)
                deduped.append(d)

        # Sort detections by frame number
        deduped.sort(key=lambda d: (int(d.get("frame", 0)), float(d.get("timestamp", 0.0))))

        # Update screening state
        ranges: list[EvaluatedRange] = []
        strides_completed: list[int] = []

        if existing_state:
            ranges.extend(existing_state.evaluated_ranges)
            strides_completed.extend(existing_state.strides_completed)

        if new_range is not None:
            ranges.append(new_range)

        if not early_exit and stride not in strides_completed:
            strides_completed.append(stride)
            strides_completed.sort(reverse=True)

        compacted_ranges = compact_ranges(ranges, total_frames=total_frames)

        # Determine semantic status
        if is_annotation_pass:
            status = "annotated" if not early_exit else "detected"
        elif len(deduped) > 0:
            status = "detected"
        else:
            status = "blank"

        final_state = ScreeningState(
            status=status,
            strides_completed=strides_completed,
            max_stride_evaluated=min(strides_completed) if strides_completed else stride,
            early_exit=early_exit,
            early_exit_frame=early_exit_frame,
            evaluated_ranges=compacted_ranges,
        )

        image_entry: dict[str, Any] = {
            "file": relative_video_name,
            "frame_rate": fps,
            "total_frames": total_frames,
            "width": width,
            "height": height,
            "detections": deduped,
        }

        # Set partial flag for Pan UI compatibility
        if early_exit:
            image_entry["partial"] = True
            image_entry["partial_reason"] = "screening_early_exit"
            image_entry["early_exit"] = True
        else:
            image_entry["partial"] = False

        output_data: dict[str, Any] = {
            "info": {
                "format_version": "1.6",
                "detector": model_version,
                "detection_completion_time": datetime.now(UTC).isoformat(),
                "detector_metadata": {
                    "image_size": 1280,
                    "typical_detection_threshold": conf_threshold,
                    "precision": "fp16",
                },
                "screening": final_state.to_dict(),
            },
            "detection_categories": {
                "1": "animal",
                "2": "person",
                "3": "vehicle",
            },
            "images": [image_entry],
        }

        # Save atomically
        temp_file = target_json.with_suffix(f"{target_json.suffix}.tmp.{datetime.now().timestamp()}")
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(output_data, f, indent=2)
        temp_file.replace(target_json)

        return output_data

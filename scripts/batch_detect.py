#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "flask>=3.0.0",
#     "megadetector>=5.0.0",
#     "pandas>=2.0.0",
#     "pillow>=10.0.0",
#     "psutil>=5.9.0",
#     "requests>=2.31.0",
#     "torch>=2.0.0",
#     "torchcodec>=0.17.0",
#     "torchvision>=0.15.0",
#     "tqdm>=4.66.0",
#     "ultralytics>=8.0.0",
#     "nvidia-dali-cuda120>=2.0.0",
# ]
# ///
"""Batch MegaDetector video processing CLI for Pan NVR.

Processes video files using NVIDIA DALI NVDEC for hardware frame decoding and
TorchVision MegaDetector for GPU inference, matching Pan UI's exact metadata format.
"""

import os
import sys

# Ensure shared libraries (e.g. Homebrew FFmpeg) are discoverable by ld.so before loading C extensions.
BREW_LIB = "/home/linuxbrew/.linuxbrew/lib"
if os.path.isdir(BREW_LIB):
    current_ld = os.environ.get("LD_LIBRARY_PATH", "")
    if BREW_LIB not in current_ld.split(":") and os.environ.get("_PAN_REEXEC") != "1":
        new_env = os.environ.copy()
        new_env["LD_LIBRARY_PATH"] = f"{BREW_LIB}:{current_ld}".strip(":")
        new_env["_PAN_REEXEC"] = "1"
        os.execve(sys.executable, [sys.executable, *sys.argv], new_env)

import argparse
import json
import logging
import shutil
import time
from pathlib import Path
from typing import Any

import torch
from tqdm import tqdm

sys.path.append(str(Path(__file__).resolve().parent.parent / "worker"))
from detector import DaliVideoDecoder, TorchVisionMegaDetector

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pan-batch-detect")

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

CLASS_MAPPING: dict[Any, str] = {
    1: "animal",
    2: "person",
    3: "vehicle",
    "1": "animal",
    "2": "person",
    "3": "vehicle",
}


class VideoItem:
    """Represents a discovered video and its pre-checked processing status."""

    def __init__(self, path: Path, already_processed: bool) -> None:
        self.path = path
        self.already_processed = already_processed


def fast_scan_video_library(
    paths: list[str],
    recursive: bool = True,
) -> list[VideoItem]:
    """Scan directory trees using os.scandir for high performance over SMB mounts.

    Identifies video files and checks corresponding sidecars in a single directory pass,
    avoiding thousands of remote stat roundtrips over the network.
    """
    items: list[VideoItem] = []
    seen: set[str] = set()

    def scan_dir(dir_path: str) -> None:
        try:
            entries: list[os.DirEntry[str]] = []
            with os.scandir(dir_path) as it:
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    entries.append(entry)
        except (PermissionError, OSError) as err:
            logger.debug("Cannot scan directory %s: %s", dir_path, err)
            return

        subdirs: list[str] = []
        video_entries: list[os.DirEntry[str]] = []
        json_filenames: set[str] = set()

        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if recursive:
                        subdirs.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    name_lower = entry.name.lower()
                    if name_lower.endswith(tuple(VIDEO_EXTENSIONS)):
                        video_entries.append(entry)
                    elif name_lower.endswith(".json"):
                        try:
                            if entry.stat().st_size > 0:
                                json_filenames.add(entry.name)
                        except OSError:
                            pass
            except OSError:
                continue

        for v_entry in video_entries:
            if v_entry.path in seen:
                continue
            seen.add(v_entry.path)

            v_name = v_entry.name
            v_stem = os.path.splitext(v_name)[0]
            is_processed = (f"{v_name}.json" in json_filenames) or (f"{v_stem}.json" in json_filenames)

            items.append(VideoItem(Path(v_entry.path), is_processed))

        for subdir in subdirs:
            scan_dir(subdir)

    for p_str in paths:
        p = Path(p_str).expanduser().resolve()
        if not p.exists():
            parent = Path(p_str).expanduser().parent
            pattern = Path(p_str).name
            if parent.exists() and ("*" in pattern or "?" in pattern):
                matched = parent.rglob(pattern) if recursive else parent.glob(pattern)
                for f in matched:
                    if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS:
                        f_str = str(f.resolve())
                        if f_str not in seen:
                            seen.add(f_str)
                            sidecar = Path(f"{f}.json")
                            is_proc = sidecar.exists() and sidecar.stat().st_size > 0
                            items.append(VideoItem(f.resolve(), is_proc))
                continue
            logger.warning("Path does not exist: %s", p_str)
            continue

        if p.is_file():
            p_str = str(p)
            if p.suffix.lower() in VIDEO_EXTENSIONS and p_str not in seen:
                seen.add(p_str)
                sidecar = Path(f"{p}.json")
                is_proc = sidecar.exists() and sidecar.stat().st_size > 0
                items.append(VideoItem(p, is_proc))
        elif p.is_dir():
            scan_dir(str(p))

    items.sort(key=lambda item: str(item.path))
    return items


def move_file_and_sidecars(
    src_video: Path,
    dest_dir: Path,
    base_dir: Path | None = None,
) -> Path:
    """Move a video and its corresponding sidecar files (.json, .m3u8) to dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)

    if base_dir and base_dir in src_video.parents:
        rel_sub = src_video.relative_to(base_dir).parent
        target_dir = dest_dir / rel_sub
        target_dir.mkdir(parents=True, exist_ok=True)
    else:
        target_dir = dest_dir

    target_video = target_dir / src_video.name
    if target_video != src_video:
        shutil.move(str(src_video), str(target_video))

    # Move sidecar JSON if it exists
    src_json = Path(f"{src_video}.json")
    target_json = Path(f"{target_video}.json")
    if src_json.exists() and src_json != target_json:
        shutil.move(str(src_json), str(target_json))

    legacy_json = src_video.with_suffix(".json")
    target_legacy_json = target_video.with_suffix(".json")
    if legacy_json.exists() and legacy_json != src_json and legacy_json != target_legacy_json:
        shutil.move(str(legacy_json), str(target_legacy_json))

    src_m3u8 = Path(f"{src_video}.m3u8")
    target_m3u8 = Path(f"{target_video}.m3u8")
    if src_m3u8.exists() and src_m3u8 != target_m3u8:
        shutil.move(str(src_m3u8), str(target_m3u8))

    return target_video


def extract_detections_from_model_batch(
    batch_results: list[dict[str, Any]],
    conf_threshold: float,
    timestamps: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Parse raw MegaDetector batch detections into Pan's schema."""
    extracted: list[dict[str, Any]] = []
    for i_res, res in enumerate(batch_results):
        frame_num = int(res["file"])
        ts = timestamps[i_res] if timestamps and i_res < len(timestamps) else 0.0
        if res.get("detections"):
            for d in res["detections"]:
                conf = float(d["conf"])
                if conf > conf_threshold:
                    cat_id = d["category"]
                    class_name = CLASS_MAPPING.get(cat_id, f"unknown_{cat_id}")
                    x, y, w, h = d["bbox"]
                    bbox = [float(x), float(y), float(x + w), float(y + h)]
                    extracted.append({
                        "frame": frame_num,
                        "timestamp": round(ts, 3),
                        "category": class_name,
                        "conf": round(conf, 4),
                        "bbox": [round(coord, 5) for coord in bbox],
                    })
    return extracted


def process_video_with_dali(
    video_path: Path,
    model: TorchVisionMegaDetector,
    base_dir: Path | None,
    batch_size: int = 32,
    conf_threshold: float = 0.2,
    target_size: int = 1280,
    frame_fps: float = 4.0,
    pbar_frames: tqdm | None = None,
) -> tuple[dict[str, Any], int]:
    """Process video using NVIDIA DALI NVDEC as the sole decoder and GPU MegaDetector for inference."""
    step = max(int(12.0 / frame_fps), 1)
    decoder = DaliVideoDecoder(video_path, step=step, batch_size=batch_size, device_id=0)

    if decoder.total_samples == 0:
        raise ValueError(f"Unable to read video frames with DALI: {video_path}")

    if pbar_frames is not None:
        pbar_frames.reset(total=decoder.total_samples)
        pbar_frames.set_description(f"Frames [DALI NVDEC]: {video_path.name[:25]}")

    results_list: list[dict[str, Any]] = []
    width = 0
    height = 0
    last_frame_num = 0
    last_timestamp = 0.0

    for frames, fnums, timestamps in decoder:
        if width == 0:
            height = frames.shape[1]
            width = frames.shape[2]

        batch_results = model.generate_detections_one_batch(
            frames,
            image_ids=fnums,
            detection_threshold=conf_threshold,
        )
        detections = extract_detections_from_model_batch(
            batch_results,
            conf_threshold=conf_threshold,
            timestamps=timestamps,
        )
        results_list.extend(detections)

        last_frame_num = fnums[-1]
        last_timestamp = timestamps[-1]

        if pbar_frames is not None:
            pbar_frames.update(len(fnums))

    if base_dir and base_dir in video_path.parents:
        rel_path = str(video_path.relative_to(base_dir))
    else:
        rel_path = video_path.name

    fps = round(last_frame_num / last_timestamp, 2) if last_timestamp > 0 else 12.0
    is_partial = decoder.is_partial or (0 < decoder.samples_read < decoder.total_samples)
    result_data = {
        "video": rel_path,
        "metadata": {
            "fps": fps,
            "total_frames": last_frame_num + 1,
            "width": width,
            "height": height,
            "partial": is_partial,
        },
        "partial": is_partial,
        "detections": results_list,
    }
    if is_partial and decoder.partial_reason:
        result_data["metadata"]["partial_reason"] = decoder.partial_reason
        result_data["partial_reason"] = decoder.partial_reason

    return result_data, len(results_list)


def save_detection_json(video_path: Path, data: dict[str, Any]) -> Path:
    """Save the detection result atomically as <video_path>.json."""
    json_path = Path(f"{video_path}.json")
    tmp_path = Path(f"{video_path}.json.tmp.{os.getpid()}")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        tmp_path.replace(json_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
    return json_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch MegaDetector video processor matching Pan NVR format (using NVIDIA DALI NVDEC).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        default=[],
        help="Video files or directories to process.",
    )
    parser.add_argument(
        "-i",
        "--input",
        dest="inputs",
        action="append",
        default=[],
        help="Additional input video file or directory (can be specified multiple times).",
    )
    parser.add_argument(
        "-r",
        "--recursive",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Recursively scan directories for video files.",
    )
    parser.add_argument(
        "--skip-existing",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Skip videos that already have a valid .json sidecar.",
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force re-processing of all videos, ignoring existing sidecars (overrides --skip-existing).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Inference frame batch size.",
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.2,
        help="Confidence threshold for detections.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="MDv1000-redwood",
        help="MegaDetector model version or path (e.g. MDv1000-redwood, MDV5A).",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="",
        help="Device to use for inference ('cuda', 'cpu', or '' for auto-detect).",
    )
    parser.add_argument(
        "--target-size",
        type=int,
        default=1280,
        help="Max frame dimension to resize to for inference.",
    )
    parser.add_argument(
        "--frame-fps",
        type=float,
        default=4.0,
        help="Target sampling rate (fps) to extract frames for detection.",
    )
    parser.add_argument(
        "--base-dir",
        type=str,
        default="",
        help="Base directory for computing relative video paths in JSON. Defaults to /mnt/y/NVR if applicable.",
    )
    parser.add_argument(
        "--move-blank-to",
        type=str,
        default="",
        help="Optional destination directory to move videos and sidecars with 0 detections.",
    )
    parser.add_argument(
        "--move-detected-to",
        type=str,
        default="",
        help="Optional destination directory to move videos and sidecars with >=1 detection.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview files to process and actions to take without running inference or moving files.",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_paths = list(args.paths) + list(args.inputs)
    if not input_paths:
        default_dir = Path("/mnt/y/NVR/NVR-unprocessed")
        if default_dir.exists():
            logger.info("No paths specified; defaulting to %s", default_dir)
            input_paths = [str(default_dir)]
        else:
            logger.error("No input files or directories specified. See --help.")
            sys.exit(1)

    base_dir: Path | None = None
    if args.base_dir:
        base_dir = Path(args.base_dir).expanduser().resolve()
    elif Path("/mnt/y/NVR").exists():
        base_dir = Path("/mnt/y/NVR").resolve()

    logger.info("Scanning video library (fast scandir)...")
    start_scan = time.time()
    discovered_items = fast_scan_video_library(input_paths, recursive=args.recursive)
    scan_time = time.time() - start_scan

    if not discovered_items:
        logger.warning("No video files found matching the specified inputs.")
        sys.exit(0)

    logger.info("Discovered %d video file(s) in %.2fs.", len(discovered_items), scan_time)

    skip_existing = args.skip_existing and not args.force
    videos_to_process: list[Path] = []
    skipped_count = 0

    for item in discovered_items:
        if skip_existing and item.already_processed:
            skipped_count += 1
        else:
            videos_to_process.append(item.path)

    logger.info(
        "Queue summary: %d to process, %d already processed (skipped).",
        len(videos_to_process),
        skipped_count,
    )

    if args.dry_run:
        logger.info("[DRY RUN] Previewing %d file(s) to process:", len(videos_to_process))
        for v in videos_to_process[:20]:
            print(f"  - {v}")
        if len(videos_to_process) > 20:
            print(f"  ... and {len(videos_to_process) - 20} more videos.")
        if args.move_blank_to:
            logger.info("[DRY RUN] Videos with 0 detections would be moved to: %s", args.move_blank_to)
        if args.move_detected_to:
            logger.info("[DRY RUN] Videos with >=1 detection would be moved to: %s", args.move_detected_to)
        sys.exit(0)

    if not videos_to_process:
        logger.info("All videos are already processed. Nothing to do.")
        sys.exit(0)

    target_device: torch.device
    if args.device:
        if args.device.lower() == "cpu":
            target_device = torch.device("cpu")
            logger.info("Using CPU as requested.")
        elif args.device.lower().startswith("cuda"):
            if not torch.cuda.is_available():
                logger.error("CUDA requested but not available.")
                sys.exit(1)
            target_device = torch.device(args.device)
            logger.info("Using GPU: %s (%s)", torch.cuda.get_device_name(0), args.device)
        else:
            target_device = torch.device(args.device)
    elif torch.cuda.is_available():
        target_device = torch.device("cuda:0")
        logger.info("Using GPU: %s", torch.cuda.get_device_name(0))
    else:
        target_device = torch.device("cpu")
        logger.info("CUDA not available. Using CPU.")

    logger.info("Decoder backend: NVIDIA DALI (hardware NVDEC)")
    logger.info("Inference engine: TorchVisionMegaDetector (pure GPU tensor pipeline)")

    logger.info("Loading MegaDetector model '%s'...", args.model)
    start_load = time.time()
    try:
        model = TorchVisionMegaDetector(
            model_version=args.model,
            device=target_device,
            default_image_size=args.target_size,
        )
        logger.info("Model loaded successfully in %.2fs.", time.time() - start_load)
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to load MegaDetector model: %s", e)
        sys.exit(1)

    move_blank_dir = Path(args.move_blank_to).expanduser().resolve() if args.move_blank_to else None
    move_detected_dir = (
        Path(args.move_detected_to).expanduser().resolve() if args.move_detected_to else None
    )

    processed_count = 0
    blank_count = 0
    detected_count = 0
    partial_count = 0
    total_detections = 0
    error_count = 0
    start_time = time.time()

    pbar_videos = tqdm(videos_to_process, desc="Videos", unit="vid")
    pbar_frames = tqdm(total=0, desc="Frames", unit="frame", leave=False)

    try:
        for video_path in pbar_videos:
            pbar_videos.set_postfix_str(video_path.name[:25])
            try:
                data, det_count = process_video_with_dali(
                    video_path=video_path,
                    model=model,
                    base_dir=base_dir,
                    batch_size=args.batch_size,
                    conf_threshold=args.conf,
                    target_size=args.target_size,
                    frame_fps=args.frame_fps,
                    pbar_frames=pbar_frames,
                )
                save_detection_json(video_path, data)
                processed_count += 1
                total_detections += det_count
                if data.get("partial"):
                    partial_count += 1

                if det_count == 0:
                    blank_count += 1
                    if move_blank_dir:
                        dest = move_file_and_sidecars(video_path, move_blank_dir, base_dir=base_dir)
                        logger.info("Moved blank video to %s", dest)
                else:
                    detected_count += 1
                    if move_detected_dir:
                        dest = move_file_and_sidecars(video_path, move_detected_dir, base_dir=base_dir)
                        logger.info("Moved detected video to %s", dest)

            except Exception as e:  # noqa: BLE001
                error_count += 1
                logger.error("Error processing %s via DALI: %s", video_path, e)

    except KeyboardInterrupt:
        logger.warning("\nProcessing interrupted by user (Ctrl+C). Exiting...")
    finally:
        pbar_frames.close()
        pbar_videos.close()

    elapsed = time.time() - start_time
    logger.info("=" * 60)
    logger.info("BATCH PROCESSING SUMMARY (%.2fs)", elapsed)
    logger.info("Total scanned:      %d", len(discovered_items))
    logger.info("Already processed:  %d (skipped)", skipped_count)
    logger.info("Newly processed:    %d", processed_count)
    logger.info("  - Fully decoded:  %d", processed_count - partial_count)
    logger.info("  - Partial (corrupt EOF): %d", partial_count)
    logger.info("  - Blank (0 det):  %d", blank_count)
    logger.info("  - Detections:     %d (%d total objects)", detected_count, total_detections)
    if error_count > 0:
        logger.warning("  - Errors:         %d", error_count)
    logger.info("=" * 60)


if __name__ == "__main__":
    main()

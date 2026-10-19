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
TorchVision MegaDetector for GPU inference, with a high-throughput multi-pass BFS
screening funnel and post-screening annotation pass.
"""

import argparse
import concurrent.futures
import logging
import os
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

# Ensure shared libraries (e.g. Homebrew FFmpeg) are discoverable by ld.so before loading C extensions.
BREW_LIB = "/home/linuxbrew/.linuxbrew/lib"
if __name__ == "__main__" and os.path.isdir(BREW_LIB):
    current_ld = os.environ.get("LD_LIBRARY_PATH", "")
    if BREW_LIB not in current_ld.split(":") and os.environ.get("_PAN_REEXEC") != "1":
        new_env = os.environ.copy()
        new_env["LD_LIBRARY_PATH"] = f"{BREW_LIB}:{current_ld}".strip(":")
        new_env["_PAN_REEXEC"] = "1"
        os.execve(sys.executable, [sys.executable, *sys.argv], new_env)

import torch
from tqdm import tqdm

sys.path.append(str(Path(__file__).resolve().parent.parent / "worker"))
from detector import VideoProcessor
from screening import (
    ScreeningState,
    SidecarScreeningManager,
)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pan-batch-detect")

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


class VfsPrewarmer:
    """Pre-warms upcoming videos in a background daemon thread to populate rclone VFS cache."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def prewarm(self, path: Path) -> None:
        self.stop()
        self._stop_event.clear()

        def _worker() -> None:
            try:
                with open(path, "rb") as f:
                    chunk_size = 8 * 1024 * 1024  # 8MB chunk
                    while not self._stop_event.is_set():
                        data = f.read(chunk_size)
                        if not data:
                            break
            except Exception as err:  # noqa: BLE001
                logger.debug("VFS prewarmer read error on %s: %s", path, err)

        self._thread = threading.Thread(target=_worker, daemon=True, name="vfs-prewarmer")
        self._thread.start()

    def stop(self) -> None:
        if self._thread and self._thread.is_alive():
            self._stop_event.set()
            self._thread.join(timeout=0.2)


class VideoItem:
    """Represents a discovered video and its screening state."""

    def __init__(
        self,
        path: Path,
        sidecar_path: Path | None = None,
        already_processed: bool = False,
        screening_state: ScreeningState | None = None,
    ) -> None:
        self.path = path
        self.sidecar_path = sidecar_path or Path(f"{path}.json")
        self.already_processed = already_processed
        self.screening_state = screening_state


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
            sidecar_file: Path | None = None
            if f"{v_name}.json" in json_filenames:
                sidecar_file = Path(v_entry.path).parent / f"{v_name}.json"
            elif f"{v_stem}.json" in json_filenames:
                sidecar_file = Path(v_entry.path).parent / f"{v_stem}.json"

            is_processed = sidecar_file is not None
            items.append(
                VideoItem(
                    path=Path(v_entry.path),
                    sidecar_path=sidecar_file or Path(f"{v_entry.path}.json"),
                    already_processed=is_processed,
                )
            )

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
                            items.append(VideoItem(f.resolve(), sidecar_path=sidecar, already_processed=is_proc))
                continue
            logger.warning("Path does not exist: %s", p_str)
            continue

        if p.is_file():
            p_str = str(p)
            if p.suffix.lower() in VIDEO_EXTENSIONS and p_str not in seen:
                seen.add(p_str)
                sidecar = Path(f"{p}.json")
                is_proc = sidecar.exists() and sidecar.stat().st_size > 0
                items.append(VideoItem(p, sidecar_path=sidecar, already_processed=is_proc))
        elif p.is_dir():
            scan_dir(str(p))

    items.sort(key=lambda item: str(item.path))
    return items


def populate_screening_states(items: list[VideoItem]) -> None:
    """Load screening states for all discovered items in parallel."""
    items_with_sidecars = [it for it in items if it.already_processed]
    if not items_with_sidecars:
        return

    def _load(it: VideoItem) -> None:
        try:
            _, state = SidecarScreeningManager.load_sidecar(it.sidecar_path)
            it.screening_state = state
        except Exception as err:  # noqa: BLE001
            logger.debug("Failed to read screening state for %s: %s", it.sidecar_path, err)

    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        list(executor.map(_load, items_with_sidecars))


def has_completed_stride_or_finer(state: ScreeningState | None, target_stride: int) -> bool:
    """Check if state has already been evaluated across full video at target_stride or finer."""
    if not state or not state.strides_completed:
        return False
    return min(state.strides_completed) <= target_stride


def get_pass_candidates(
    items: list[VideoItem],
    strides: list[int],
    pass_index: int,
    force: bool = False,
) -> list[VideoItem]:
    """Determine eligible videos for a screening pass at the given stride index."""
    if pass_index >= len(strides):
        return []
    stride = strides[pass_index]
    candidates: list[VideoItem] = []
    for it in items:
        if force:
            candidates.append(it)
            continue

        state = it.screening_state
        if state is None:
            # Completely unprocessed: eligible for Pass 1 only
            if pass_index == 0:
                candidates.append(it)
            continue

        if state.status == "annotated":
            continue

        if state.status == "detected":
            # Detected videos wait for annotation phase
            continue

        if state.status == "blank":
            # Must have completed previous stride if this is not Pass 1
            if pass_index > 0:
                prev_stride = strides[pass_index - 1]
                if not has_completed_stride_or_finer(state, prev_stride):
                    continue

            # Must not have already completed this stride or finer
            if has_completed_stride_or_finer(state, stride):
                continue

            candidates.append(it)

    return candidates


def get_annotation_candidates(
    items: list[VideoItem],
    force: bool = False,
) -> list[VideoItem]:
    """Determine videos that have detections and need full annotation backfill."""
    candidates: list[VideoItem] = []
    for it in items:
        if force:
            candidates.append(it)
            continue

        state = it.screening_state
        if state is None:
            continue

        if state.status == "annotated":
            continue

        if state.status == "detected" or state.early_exit:
            candidates.append(it)

    return candidates


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


def process_single_video(
    processor: VideoProcessor,
    item: VideoItem,
    step: int | None,
    early_exit: bool,
    is_annotation_pass: bool,
    base_dir: Path | None,
    batch_size: int | str,
    conf: float,
    target_size: int,
    pbar_frames: tqdm,
    prewarmer: VfsPrewarmer,
    next_item: VideoItem | None,
) -> dict[str, Any]:
    """Execute inference on a single video with network retries and state updates."""
    video_path = item.path
    if next_item is not None:
        prewarmer.prewarm(next_item.path)

    max_net_retries = 10
    net_retry_count = 0

    ranges_to_skip = item.screening_state.evaluated_ranges if item.screening_state else None

    while True:
        try:
            det_count = 0
            result_data: dict[str, Any] = {}
            is_error = False
            err_msg = ""
            final_status = ""
            is_early_exit = False

            for chunk in processor.process_video_stream(
                video_path=video_path,
                base_dir=base_dir,
                batch_size=batch_size,
                conf_threshold=conf,
                target_size=target_size,
                step=step,
                early_exit=early_exit,
                screening_ranges=ranges_to_skip,
                is_annotation_pass=is_annotation_pass,
            ):
                status = chunk.get("status")
                if status == "starting":
                    total_samples = chunk.get("total_samples", 0)
                    active_b = chunk.get("batch_size", batch_size)
                    pbar_frames.reset(total=total_samples)
                    pbar_frames.set_description(f"Frames [DALI b={active_b}]: {video_path.name[:20]}")
                elif status == "progress":
                    pbar_frames.update(chunk.get("batch_samples", 0))
                elif status == "early_exit":
                    is_early_exit = True
                elif status == "skipped":
                    reason = chunk.get("reason", "empty")
                    logger.warning("Skipped %s (%s)", video_path.name, reason)
                    return {
                        "success": True,
                        "skipped": True,
                        "reason": reason,
                        "screening_status": "skipped",
                        "detections_count": 0,
                    }
                elif status == "complete":
                    det_count = chunk.get("detections_count", 0)
                    result_data = chunk.get("result_data", {})
                    final_status = chunk.get("screening_status", "")
                    active_b = chunk.get("batch_size", batch_size)
                    logger.info(
                        "Finished %s: %d detections (status=%s, early_exit=%s, batch=%s)",
                        video_path.name,
                        det_count,
                        final_status,
                        chunk.get("early_exit", False),
                        active_b,
                    )
                    sys.stdout.flush()
                    sys.stderr.flush()
                elif "error" in chunk:
                    is_error = True
                    err_msg = chunk["error"]

            if is_error:
                raise RuntimeError(err_msg)

            # Update item's screening state in-memory
            screening_dict = result_data.get("info", {}).get("screening")
            if screening_dict:
                item.screening_state = ScreeningState.from_dict(screening_dict)
            item.already_processed = True

            return {
                "success": True,
                "detections_count": det_count,
                "screening_status": final_status,
                "early_exit": is_early_exit,
                "partial": result_data.get("images", [{}])[0].get("partial", False),
                "result_data": result_data,
            }

        except Exception as e:  # noqa: BLE001
            err_str = str(e)
            is_net_error = (
                "Host is down" in err_str
                or "Network is unreachable" in err_str
                or "Connection reset" in err_str
                or "Input/output error" in err_str
                or "No such device" in err_str
            )
            if is_net_error and net_retry_count < max_net_retries:
                net_retry_count += 1
                wait_sec = min(15 * net_retry_count, 120)
                logger.warning(
                    "Storage network error on %s (%s). Waiting %ds for mount recovery (retry %d/%d)...",
                    video_path.name,
                    err_str.splitlines()[-1] if err_str else "Host down",
                    wait_sec,
                    net_retry_count,
                    max_net_retries,
                )
                time.sleep(wait_sec)
                continue

            logger.error("Error processing %s: %s", video_path, e)
            return {"success": False, "error": str(e)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch MegaDetector video processor with Multi-Pass BFS Screening (NVIDIA DALI NVDEC).",
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
        help="Skip videos that already have completed screening/annotation.",
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force re-processing of all videos, ignoring existing sidecars (overrides --skip-existing).",
    )
    parser.add_argument(
        "--strides",
        type=str,
        default="24,4,1",
        help="Comma-separated strides for multi-pass BFS screening (e.g. '24,4,1').",
    )
    parser.add_argument(
        "--annotate-stride",
        type=int,
        default=4,
        help="Target frame stride for post-screening annotation backfill pass.",
    )
    parser.add_argument(
        "--skip-annotation",
        action="store_true",
        help="Only run screening passes; skip the post-screening annotation backfill pass.",
    )
    parser.add_argument(
        "--stage",
        type=str,
        choices=["auto", "1", "2", "3", "annotate", "legacy"],
        default="auto",
        help="Execution stage: 'auto' runs full BFS funnel, '1'/'2'/'3' runs specific pass, 'annotate' runs annotation backfill, 'legacy' runs single-pass detect.",
    )
    parser.add_argument(
        "--early-exit",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable early exit on first positive detection during screening passes.",
    )
    parser.add_argument(
        "--batch-size",
        type=lambda v: v if str(v).lower() == "auto" else int(v),
        default="auto",
        help="Inference frame batch size (integer or 'auto' for dynamic VRAM sizing).",
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
        help="Target sampling rate (fps) for legacy single-pass mode.",
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
        help="Optional destination directory to move videos and sidecars with 0 detections (certified blanks).",
    )
    parser.add_argument(
        "--move-detected-to",
        type=str,
        default="",
        help="Optional destination directory to move videos and sidecars with >=1 detection (annotated).",
    )
    parser.add_argument(
        "--no-fp16",
        dest="fp16",
        action="store_false",
        default=True,
        help="Disable FP16 half-precision inference and force FP32.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview queues and passes without executing inference or modifying files.",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_paths = list(args.paths) + list(args.inputs)
    if not input_paths:
        for candidate in [Path("/data/NVR-unprocessed"), Path("/mnt/y/NVR/NVR-unprocessed")]:
            if candidate.exists():
                logger.info("No paths specified; defaulting to %s", candidate)
                input_paths = [str(candidate)]
                break
        if not input_paths:
            logger.error("No input files or directories specified. See --help.")
            sys.exit(1)

    base_dir: Path | None = None
    if args.base_dir:
        base_dir = Path(args.base_dir).expanduser().resolve()
    elif Path("/data").exists():
        base_dir = Path("/data").resolve()
    elif Path("/mnt/y/NVR").exists():
        base_dir = Path("/mnt/y/NVR").resolve()

    logger.info("Scanning video library (fast scandir)...")
    start_scan = time.time()
    discovered_items = fast_scan_video_library(input_paths, recursive=args.recursive)
    scan_time = time.time() - start_scan

    if not discovered_items:
        logger.warning("No video files found matching the specified inputs.")
        sys.exit(0)

    logger.info("Discovered %d video file(s) in %.2fs. Loading sidecar metadata...", len(discovered_items), scan_time)
    start_load_meta = time.time()
    populate_screening_states(discovered_items)
    logger.info("Loaded sidecar metadata in %.2fs.", time.time() - start_load_meta)

    # Parse screening strides
    strides: list[int] = []
    for s_str in args.strides.split(","):
        s_str = s_str.strip()
        if s_str:
            try:
                val = int(s_str)
                if val > 0:
                    strides.append(val)
            except ValueError:
                logger.warning("Invalid stride value ignored: %s", s_str)
    if not strides:
        strides = [24, 4, 1]

    # Queue breakdowns
    p1_candidates = get_pass_candidates(discovered_items, strides=strides, pass_index=0, force=args.force)
    p2_candidates = (
        get_pass_candidates(discovered_items, strides=strides, pass_index=1, force=args.force)
        if len(strides) > 1
        else []
    )
    p3_candidates = (
        get_pass_candidates(discovered_items, strides=strides, pass_index=2, force=args.force)
        if len(strides) > 2
        else []
    )
    anno_candidates = get_annotation_candidates(discovered_items, force=args.force)

    certified_blanks = [
        it
        for it in discovered_items
        if it.screening_state
        and it.screening_state.status == "blank"
        and all(has_completed_stride_or_finer(it.screening_state, s) for s in strides)
    ]
    annotated_videos = [
        it for it in discovered_items if it.screening_state and it.screening_state.status == "annotated"
    ]

    logger.info(
        "Library status: %d certified blank, %d fully annotated, %d detected (awaiting annotation).",
        len(certified_blanks),
        len(annotated_videos),
        len(anno_candidates),
    )
    logger.info(
        "Funnel queues: Pass 1 (stride %d): %d | Pass 2 (stride %d): %d | Pass 3 (stride %d): %d | Annotation: %d",
        strides[0],
        len(p1_candidates),
        strides[1] if len(strides) > 1 else 0,
        len(p2_candidates),
        strides[2] if len(strides) > 2 else 0,
        len(p3_candidates),
        len(anno_candidates),
    )

    if args.dry_run:
        logger.info("[DRY RUN] Stage selected: %s", args.stage)
        logger.info("[DRY RUN] Strides: %s | Annotate stride: %d", strides, args.annotate_stride)
        if p1_candidates:
            logger.info("  Pass 1 sample candidates (stride %d):", strides[0])
            for it in p1_candidates[:5]:
                print(f"    - {it.path.name}")
        if p2_candidates:
            logger.info("  Pass 2 sample candidates (stride %d):", strides[1])
            for it in p2_candidates[:5]:
                print(f"    - {it.path.name}")
        if p3_candidates:
            logger.info("  Pass 3 sample candidates (stride %d):", strides[2])
            for it in p3_candidates[:5]:
                print(f"    - {it.path.name}")
        if anno_candidates:
            logger.info("  Annotation sample candidates:")
            for it in anno_candidates[:5]:
                print(f"    - {it.path.name}")
        sys.exit(0)

    # Initialize GPU / inference device
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

    use_fp16 = bool(args.fp16 and target_device.type == "cuda")
    logger.info("Decoder backend: NVIDIA DALI (hardware NVDEC)")
    logger.info("Inference engine: TorchVisionMegaDetector (fp16=%s)", use_fp16)

    logger.info("Initializing VideoProcessor with model '%s' (batch_size=%s)...", args.model, args.batch_size)
    start_load = time.time()
    try:
        processor = VideoProcessor(
            model_version=args.model,
            device=target_device,
            fp16=use_fp16,
            batch_size=args.batch_size,
        )
        logger.info("VideoProcessor ready in %.2fs.", time.time() - start_load)
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to initialize VideoProcessor: %s", e)
        sys.exit(1)

    move_blank_dir = Path(args.move_blank_to).expanduser().resolve() if args.move_blank_to else None
    move_detected_dir = (
        Path(args.move_detected_to).expanduser().resolve() if args.move_detected_to else None
    )

    prewarmer = VfsPrewarmer()
    pbar_frames = tqdm(total=0, desc="Frames", unit="frame", leave=False)
    start_time = time.time()

    # Track metrics across passes
    pass_metrics: dict[str, dict[str, int]] = {}

    def run_pass(
        queue: list[VideoItem],
        pass_name: str,
        step: int | None,
        early_exit: bool,
        is_annotation: bool,
    ) -> None:
        if not queue:
            logger.info("=== %s: 0 videos in queue. Skipping. ===", pass_name)
            return

        logger.info("=== %s: Processing %d video(s) (stride=%s, early_exit=%s) ===", pass_name, len(queue), step, early_exit)
        metrics = {"processed": 0, "blank": 0, "detected": 0, "annotated": 0, "skipped": 0, "errors": 0}

        pbar_vids = tqdm(queue, desc=pass_name, unit="vid")
        try:
            for i_vid, item in enumerate(pbar_vids):
                pbar_vids.set_postfix_str(item.path.name[:25])
                next_item = queue[i_vid + 1] if i_vid + 1 < len(queue) else None

                res = process_single_video(
                    processor=processor,
                    item=item,
                    step=step,
                    early_exit=early_exit,
                    is_annotation_pass=is_annotation,
                    base_dir=base_dir,
                    batch_size=args.batch_size,
                    conf=args.conf,
                    target_size=args.target_size,
                    pbar_frames=pbar_frames,
                    prewarmer=prewarmer,
                    next_item=next_item,
                )

                if res.get("skipped"):
                    metrics["skipped"] += 1
                elif res.get("success"):
                    metrics["processed"] += 1
                    status = res.get("screening_status", "")
                    if status == "blank":
                        metrics["blank"] += 1
                    elif status == "detected":
                        metrics["detected"] += 1
                    elif status == "annotated":
                        metrics["annotated"] += 1
                else:
                    metrics["errors"] += 1

        finally:
            pbar_vids.close()

        pass_metrics[pass_name] = metrics

    try:
        if args.stage == "legacy":
            # Legacy single-pass mode
            legacy_queue = [it for it in discovered_items if args.force or not it.already_processed]
            legacy_step = max(int(12.0 / args.frame_fps), 1)
            run_pass(
                legacy_queue,
                pass_name="Legacy Detect",
                step=legacy_step,
                early_exit=False,
                is_annotation=False,
            )
        else:
            # Multi-Pass BFS Screening Funnel
            stages_to_run: list[tuple[str, int, int]] = []
            if args.stage == "auto":
                for idx, stride in enumerate(strides):
                    stages_to_run.append((f"Pass {idx + 1}/{len(strides)} (Stride {stride})", idx, stride))
            elif args.stage in {"1", "2", "3"}:
                pass_idx = int(args.stage) - 1
                if pass_idx < len(strides):
                    stages_to_run.append((f"Pass {args.stage} (Stride {strides[pass_idx]})", pass_idx, strides[pass_idx]))
                else:
                    logger.error("Requested stage '%s' exceeds configured strides %s.", args.stage, strides)
                    sys.exit(1)

            # Execute scheduled screening passes
            for pass_title, pass_idx, stride in stages_to_run:
                # Re-evaluate candidates dynamically from current states
                candidates = get_pass_candidates(discovered_items, strides=strides, pass_index=pass_idx, force=args.force)
                run_pass(
                    candidates,
                    pass_name=pass_title,
                    step=stride,
                    early_exit=args.early_exit,
                    is_annotation=False,
                )

            # Check for certified blanks to move if requested
            if move_blank_dir and (args.stage in {"auto", "3"} or len(strides) == 1):
                logger.info("Moving certified blank videos to %s...", move_blank_dir)
                moved_blanks = 0
                for it in discovered_items:
                    if (
                        it.screening_state
                        and it.screening_state.status == "blank"
                        and all(has_completed_stride_or_finer(it.screening_state, s) for s in strides)
                    ):
                        move_file_and_sidecars(it.path, move_blank_dir, base_dir=base_dir)
                        moved_blanks += 1
                logger.info("Moved %d certified blank video(s).", moved_blanks)

            # Annotation Phase
            should_run_annotation = (args.stage == "auto" and not args.skip_annotation) or (args.stage == "annotate")
            if should_run_annotation:
                anno_candidates = get_annotation_candidates(discovered_items, force=args.force)
                run_pass(
                    anno_candidates,
                    pass_name=f"Annotation Phase (Stride {args.annotate_stride})",
                    step=args.annotate_stride,
                    early_exit=False,
                    is_annotation_pass=True,
                )

                if move_detected_dir:
                    logger.info("Moving annotated videos to %s...", move_detected_dir)
                    moved_det = 0
                    for it in discovered_items:
                        if it.screening_state and it.screening_state.status in {"annotated", "detected"}:
                            move_file_and_sidecars(it.path, move_detected_dir, base_dir=base_dir)
                            moved_det += 1
                    logger.info("Moved %d detected/annotated video(s).", moved_det)

    except KeyboardInterrupt:
        logger.warning("\nProcessing interrupted by user (Ctrl+C). Cleaned up gracefully.")
    finally:
        prewarmer.stop()
        pbar_frames.close()

    elapsed = time.time() - start_time
    logger.info("=" * 60)
    logger.info("MULTI-PASS BFS SCREENING SUMMARY (%.2fs)", elapsed)
    logger.info("Total videos discovered: %d", len(discovered_items))
    for p_name, metrics in pass_metrics.items():
        logger.info(
            "  %s: %d processed | %d blank, %d detected, %d annotated, %d skipped, %d errors",
            p_name,
            metrics["processed"],
            metrics["blank"],
            metrics["detected"],
            metrics["annotated"],
            metrics.get("skipped", 0),
            metrics["errors"],
        )
    logger.info("=" * 60)


if __name__ == "__main__":
    main()

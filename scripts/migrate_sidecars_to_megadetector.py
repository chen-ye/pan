#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "jsonschema>=4.0.0",
#     "tqdm>=4.66.0",
# ]
# ///
"""One-time migration script to convert Pan legacy JSON sidecars to standard MegaDetector v1.6 format.

Scans video sidecars, converts legacy [x1, y1, x2, y2] bounding boxes to normalized
[x_min, y_min, width, height], maps category strings to integer IDs, wraps
metadata and detections inside standard MegaDetector 'info', 'detection_categories',
and 'images' keys, validates against schema, and atomically overwrites files.
"""

import argparse
import json
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pan-migrate-megadetector")

DEFAULT_CATEGORIES: dict[str, str] = {
    "1": "animal",
    "2": "person",
    "3": "vehicle",
}

CATEGORY_NAME_TO_ID: dict[str, str] = {
    "animal": "1",
    "person": "2",
    "vehicle": "3",
    "1": "1",
    "2": "2",
    "3": "3",
}


def load_validator(schema_path: Path) -> Draft202012Validator:
    """Load and prepare JSON schema validator."""
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file not found at {schema_path}")
    with open(schema_path, "r", encoding="utf-8") as f:
        schema = json.load(f)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def scan_sidecar_files(paths: list[str], recursive: bool = True) -> list[Path]:
    """Fast directory scan for video sidecar JSON files, skipping non-sidecars."""
    sidecar_files: list[Path] = []
    seen: set[str] = set()

    def scan_dir(dir_path: str) -> None:
        try:
            with os.scandir(dir_path) as it:
                subdirs: list[str] = []
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if recursive:
                                subdirs.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            name_lower = entry.name.lower()
                            if name_lower.endswith(".json"):
                                if name_lower.startswith("image_recognition_file"):
                                    continue
                                if entry.path not in seen:
                                    seen.add(entry.path)
                                    sidecar_files.append(Path(entry.path))
                    except OSError:
                        continue
                for s in subdirs:
                    scan_dir(s)
        except (PermissionError, OSError) as err:
            logger.debug("Cannot scan directory %s: %s", dir_path, err)

    for p_str in paths:
        p = Path(p_str).expanduser().resolve()
        if not p.exists():
            logger.warning("Path does not exist: %s", p_str)
            continue
        if p.is_file():
            if p.suffix.lower() == ".json" and not p.name.startswith("image_recognition_file"):
                p_str_res = str(p)
                if p_str_res not in seen:
                    seen.add(p_str_res)
                    sidecar_files.append(p)
        elif p.is_dir():
            scan_dir(str(p))

    sidecar_files.sort()
    return sidecar_files


def is_already_megadetector(data: dict[str, Any]) -> bool:
    """Check if data dictionary already adheres to the MegaDetector format."""
    return (
        isinstance(data.get("images"), list)
        and len(data["images"]) > 0
        and isinstance(data.get("info"), dict)
        and isinstance(data.get("detection_categories"), dict)
    )


def convert_legacy_to_megadetector(
    legacy_data: dict[str, Any],
    file_path: Path,
) -> dict[str, Any]:
    """Convert a legacy Pan sidecar dictionary into standard MegaDetector format."""
    video_rel = legacy_data.get("video")
    if not video_rel:
        video_rel = file_path.name
        video_rel = video_rel.removesuffix(".json")

    metadata = legacy_data.get("metadata") or {}
    fps = float(metadata.get("fps", 12.0))
    total_frames = int(metadata.get("total_frames", 0))
    width = int(metadata.get("width", 1920))
    height = int(metadata.get("height", 1080))
    is_partial = bool(legacy_data.get("partial", metadata.get("partial", False)))
    partial_reason = legacy_data.get("partial_reason", metadata.get("partial_reason"))

    # Convert detections
    raw_detections = legacy_data.get("detections") or []
    converted_detections: list[dict[str, Any]] = []

    for d in raw_detections:
        raw_cat = str(d.get("category", "1")).lower()
        cat_id = CATEGORY_NAME_TO_ID.get(raw_cat, "1")

        conf = float(d.get("conf", 0.0))
        frame_num = int(d.get("frame_number", d.get("frame", 0)))
        ts = round(float(d.get("timestamp", 0.0)), 3)

        raw_box = d.get("bbox", [0.0, 0.0, 0.0, 0.0])
        x1 = max(0.0, min(1.0, float(raw_box[0])))
        y1 = max(0.0, min(1.0, float(raw_box[1])))
        x2 = max(0.0, min(1.0, float(raw_box[2])))
        y2 = max(0.0, min(1.0, float(raw_box[3])))

        w = max(0.0, min(1.0 - x1, x2 - x1))
        h = max(0.0, min(1.0 - y1, y2 - y1))

        converted_detections.append({
            "category": cat_id,
            "conf": round(conf, 4),
            "bbox": [round(x1, 5), round(y1, 5), round(w, 5), round(h, 5)],
            "frame_number": frame_num,
            "timestamp": ts,
        })

    # Determine completion time from file modification time
    try:
        mtime = file_path.stat().st_mtime
        comp_time = datetime.fromtimestamp(mtime, tz=UTC).isoformat()
    except OSError:
        comp_time = datetime.now(UTC).isoformat()

    image_entry: dict[str, Any] = {
        "file": str(video_rel),
        "frame_rate": round(fps, 2),
        "total_frames": total_frames,
        "width": width,
        "height": height,
        "detections": converted_detections,
    }
    if is_partial:
        image_entry["partial"] = True
        if partial_reason:
            image_entry["partial_reason"] = str(partial_reason)

    return {
        "info": {
            "format_version": "1.6",
            "detector": str(metadata.get("model", "MDv1000-redwood")),
            "detection_completion_time": comp_time,
            "detector_metadata": {
                "image_size": width if width > 0 else 1280,
                "typical_detection_threshold": 0.2,
            },
        },
        "detection_categories": DEFAULT_CATEGORIES,
        "images": [image_entry],
    }


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate Pan legacy JSON sidecars to official MegaDetector v1.6 format.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        default=[],
        help="Directories or files to process.",
    )
    parser.add_argument(
        "--schema",
        type=str,
        default=str(Path(__file__).resolve().parent.parent / "schemas" / "pan-sidecar.megadetector.schema.json"),
        help="Path to MegaDetector JSON schema.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate migration without modifying files on disk.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate sidecars against schema, do not perform conversions.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-conversion even if already in MegaDetector format.",
    )
    parser.add_argument(
        "--clean-empty",
        action="store_true",
        help="Delete empty 0-byte sidecar files so videos can be freshly re-processed.",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=0,
        help="Limit processing to first N discovered files (0 for unlimited).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_paths = list(args.paths)
    if not input_paths:
        default_dir = Path("/mnt/y/NVR/NVR-unprocessed")
        if default_dir.exists():
            input_paths = [str(default_dir)]
        else:
            logger.error("No input files or directories specified and /mnt/y/NVR/NVR-unprocessed not found.")
            sys.exit(1)

    schema_path = Path(args.schema).resolve()
    logger.info("Loading MegaDetector schema from %s...", schema_path)
    validator = load_validator(schema_path)

    logger.info("Scanning for sidecar JSON files in %s...", input_paths)
    sidecars = scan_sidecar_files(input_paths, recursive=True)
    if args.max_files > 0:
        sidecars = sidecars[:args.max_files]

    logger.info("Found %d sidecar JSON file(s).", len(sidecars))
    if not sidecars:
        logger.info("Nothing to do.")
        return

    migrated_count = 0
    already_compatible_count = 0
    empty_count = 0
    cleaned_count = 0
    invalid_count = 0
    error_count = 0

    pbar = tqdm(sidecars, desc="Migrating", unit="file")
    for file_path in pbar:
        pbar.set_postfix_str(file_path.name[:25])
        try:
            if file_path.stat().st_size == 0:
                empty_count += 1
                if args.clean_empty and not args.dry_run:
                    file_path.unlink(missing_ok=True)
                    cleaned_count += 1
                continue

            with open(file_path, "r", encoding="utf-8") as f:
                content = json.load(f)

            if is_already_megadetector(content) and not args.force:
                errors = list(validator.iter_errors(content))
                if errors:
                    invalid_count += 1
                    logger.warning("File %s already has images format but failed validation: %s", file_path.name, errors[0].message)
                else:
                    already_compatible_count += 1
                continue

            if args.validate_only:
                invalid_count += 1
                logger.info("Legacy format detected in %s (validate-only mode).", file_path.name)
                continue

            # Convert to MegaDetector format
            converted = convert_legacy_to_megadetector(content, file_path)

            # Validate converted structure
            errors = list(validator.iter_errors(converted))
            if errors:
                invalid_count += 1
                logger.error("Converted output for %s failed schema validation: %s", file_path.name, errors[0].message)
                continue

            if not args.dry_run:
                save_atomic_json(file_path, converted)

            migrated_count += 1

        except Exception as err:  # noqa: BLE001
            error_count += 1
            logger.error("Error processing %s: %s", file_path.name, err)

    logger.info("=" * 60)
    logger.info("MIGRATION SUMMARY")
    logger.info("Total files checked:       %d", len(sidecars))
    logger.info("Already compatible:       %d", already_compatible_count)
    logger.info("Successfully migrated:    %d%s", migrated_count, " (DRY RUN)" if args.dry_run else "")
    logger.info("Empty stub files (0-byte): %d%s", empty_count, f" (cleaned {cleaned_count})" if cleaned_count else "")
    logger.info("Validation errors:        %d", invalid_count)
    logger.info("Read/parse errors:        %d", error_count)
    logger.info("=" * 60)


if __name__ == "__main__":
    main()

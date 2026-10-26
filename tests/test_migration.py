"""Unit tests for migrate_sidecars_to_megadetector.py."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

try:
    from jsonschema import Draft202012Validator
except ImportError:
    Draft202012Validator = None

from migrate_sidecars_to_megadetector import (
    convert_legacy_to_megadetector,
    is_already_megadetector,
)


class TestSidecarMigration(unittest.TestCase):
    def setUp(self):
        self.schema_path = (
            Path(__file__).resolve().parent.parent
            / "schemas"
            / "pan-sidecar.megadetector.schema.json"
        )
        if Draft202012Validator is not None:
            with open(self.schema_path, "r", encoding="utf-8") as f:
                schema = json.load(f)
            self.validator = Draft202012Validator(schema)
        else:
            self.validator = None

    def validate_if_available(self, data):
        if self.validator:
            errors = list(self.validator.iter_errors(data))
            self.assertEqual(len(errors), 0, f"Validation errors: {errors}")

    def test_legacy_flat_detections_migration(self):
        legacy = {
            "video": "Backyard_00_20260502214230.mp4",
            "metadata": {
                "fps": 12.0,
                "total_frames": 1200,
                "width": 1920,
                "height": 1080,
            },
            "detections": [
                {
                    "category": "1",  # numeric ID
                    "conf": 0.95,
                    "frame": 24,
                    "bbox": [192, 108, 384, 324],  # corner coordinates [x1, y1, x2, y2]
                },
                {
                    "category": "person",  # string name
                    "conf": 0.85,
                    "frame": 48,
                    "bbox": [0.1, 0.2, 0.3, 0.4],  # already normalized corners
                },
            ],
        }

        with tempfile.NamedTemporaryFile(suffix=".json") as tmp:
            tmp_path = Path(tmp.name)
            converted = convert_legacy_to_megadetector(legacy, tmp_path)

        # Validate against schema if jsonschema is installed
        self.validate_if_available(converted)

        self.assertTrue(is_already_megadetector(converted))
        self.assertEqual(converted["detection_categories"], {"1": "animal", "2": "person", "3": "vehicle"})

        dets = converted["images"][0]["detections"]
        self.assertEqual(len(dets), 2)
        # First detection: category '1'
        self.assertEqual(dets[0]["category"], "1")
        self.assertEqual(dets[0]["bbox"], [0.1, 0.1, 0.1, 0.2])

        # Second detection: 'person' -> category '2'
        self.assertEqual(dets[1]["category"], "2")
        self.assertEqual(dets[1]["bbox"], [0.1, 0.2, 0.2, 0.2])

    def test_legacy_annotations_format_migration(self):
        legacy = {
            "video": "Backyard_00_20240724142323.mp4",
            "categories": {
                "0": "animal",
                "1": "person",
                "2": "vehicle",
            },
            "metadata": {
                "fps": 2.0,
                "total_frames": 200,
                "width": 3840,
                "height": 2160,
            },
            "annotations": [
                {
                    "img_id": "100",
                    "bbox": [[0, 540, 384, 1080]],
                    "category": [0],  # 0 is animal
                    "confidence": [0.91],
                },
                {
                    "img_id": "150",
                    "bbox": [[384, 0, 768, 540]],
                    "category": [1],  # 1 is person
                    "confidence": [0.82],
                },
            ],
        }

        with tempfile.NamedTemporaryFile(suffix=".json") as tmp:
            tmp_path = Path(tmp.name)
            converted = convert_legacy_to_megadetector(legacy, tmp_path)

        # Validate against schema if jsonschema is installed
        self.validate_if_available(converted)

        self.assertTrue(is_already_megadetector(converted))
        dets = converted["images"][0]["detections"]
        self.assertEqual(len(dets), 2)
        # Animal mapped to '1'
        self.assertEqual(dets[0]["category"], "1")
        self.assertEqual(dets[0]["bbox"], [0.0, 0.25, 0.1, 0.25])
        # Person mapped to '2'
        self.assertEqual(dets[1]["category"], "2")
        self.assertEqual(dets[1]["bbox"], [0.1, 0.0, 0.1, 0.25])


if __name__ == "__main__":
    unittest.main()

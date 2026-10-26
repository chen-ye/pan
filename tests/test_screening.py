"""Unit tests for screening, range filtering, compaction, and sidecar management."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))

from screening import (
    EvaluatedRange,
    SidecarScreeningManager,
    compact_ranges,
    is_frame_evaluated,
)


class TestEvaluatedRange(unittest.TestCase):
    def test_contains_stride_24(self):
        r = EvaluatedRange(stride=24, start=0, end=144)
        self.assertTrue(r.contains(0))
        self.assertTrue(r.contains(24))
        self.assertTrue(r.contains(48))
        self.assertTrue(r.contains(120))
        self.assertTrue(r.contains(144))

        # Off stride
        self.assertFalse(r.contains(4))
        self.assertFalse(r.contains(8))
        self.assertFalse(r.contains(23))
        self.assertFalse(r.contains(25))

        # Out of bounds
        self.assertFalse(r.contains(168))
        self.assertFalse(r.contains(-24))

    def test_contains_with_offset(self):
        r = EvaluatedRange(stride=4, start=4, end=20)
        self.assertTrue(r.contains(4))
        self.assertTrue(r.contains(8))
        self.assertTrue(r.contains(12))
        self.assertTrue(r.contains(16))
        self.assertTrue(r.contains(20))

        self.assertFalse(r.contains(0))
        self.assertFalse(r.contains(24))
        self.assertFalse(r.contains(6))


class TestRangeFilteringAndCompaction(unittest.TestCase):
    def test_multi_range_evaluation(self):
        # Video had Pass 1 exit early at 144, then Pass 2 evaluated up to 500
        ranges = [
            EvaluatedRange(stride=24, start=0, end=144),
            EvaluatedRange(stride=4, start=0, end=48),
        ]
        # Evaluated in stride 4
        self.assertTrue(is_frame_evaluated(0, ranges))
        self.assertTrue(is_frame_evaluated(4, ranges))
        self.assertTrue(is_frame_evaluated(24, ranges))
        self.assertTrue(is_frame_evaluated(48, ranges))

        # Evaluated in stride 24 only
        self.assertTrue(is_frame_evaluated(72, ranges))
        self.assertTrue(is_frame_evaluated(96, ranges))
        self.assertTrue(is_frame_evaluated(120, ranges))
        self.assertTrue(is_frame_evaluated(144, ranges))

        # Unevaluated frames
        self.assertFalse(is_frame_evaluated(52, ranges))
        self.assertFalse(is_frame_evaluated(148, ranges))
        self.assertFalse(is_frame_evaluated(168, ranges))  # past 144!

    def test_compact_ranges(self):
        # Stride 4 across entire video subsumes Stride 24
        ranges = [
            EvaluatedRange(stride=24, start=0, end=24216),
            EvaluatedRange(stride=4, start=0, end=24220),
        ]
        compacted = compact_ranges(ranges, total_frames=24223)
        self.assertEqual(len(compacted), 1)
        self.assertEqual(compacted[0].stride, 4)
        self.assertEqual(compacted[0].end, 24220)

    def test_compact_ranges_keeps_distinct(self):
        # Stride 4 up to 100 does NOT subsume Stride 24 up to 5000
        ranges = [
            EvaluatedRange(stride=24, start=0, end=5000),
            EvaluatedRange(stride=4, start=0, end=100),
        ]
        compacted = compact_ranges(ranges)
        self.assertEqual(len(compacted), 2)


class TestSidecarScreeningManager(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        self.json_path = Path(self.test_dir.name) / "test_video.mp4.json"

    def tearDown(self):
        self.test_dir.cleanup()

    def test_pass_1_early_exit(self):
        # Pass 1 finds a detection at frame 48 and early-exits
        detection = {
            "category": "1",
            "conf": 0.85,
            "bbox": [0.1, 0.2, 0.3, 0.4],
            "frame": 48,
            "timestamp": 1.92,
        }
        r = EvaluatedRange(stride=24, start=0, end=48)
        output = SidecarScreeningManager.merge_and_save_sidecar(
            json_path=self.json_path,
            relative_video_name="test_video.mp4",
            width=2560,
            height=1440,
            fps=25.0,
            total_frames=24223,
            new_detections=[detection],
            new_range=r,
            stride=24,
            early_exit=True,
            early_exit_frame=48,
            conf_threshold=0.2,
        )

        self.assertEqual(output["info"]["screening"]["status"], "detected")
        self.assertTrue(output["info"]["screening"]["early_exit"])
        self.assertEqual(output["info"]["screening"]["early_exit_frame"], 48)
        self.assertTrue(output["images"][0]["partial"])
        self.assertEqual(len(output["images"][0]["detections"]), 1)

        # Reload from disk
        loaded_data, loaded_state = SidecarScreeningManager.load_sidecar(self.json_path)
        self.assertIsNotNone(loaded_data)
        self.assertEqual(loaded_state.status, "detected")
        self.assertTrue(loaded_state.early_exit)
        self.assertEqual(loaded_state.early_exit_frame, 48)

    def test_pass_1_blank_to_pass_2_blank(self):
        # Pass 1: runs to EOF with 0 detections
        r1 = EvaluatedRange(stride=24, start=0, end=24216)
        output1 = SidecarScreeningManager.merge_and_save_sidecar(
            json_path=self.json_path,
            relative_video_name="test_video.mp4",
            width=2560,
            height=1440,
            fps=25.0,
            total_frames=24223,
            new_detections=[],
            new_range=r1,
            stride=24,
            early_exit=False,
            early_exit_frame=None,
            conf_threshold=0.2,
        )
        self.assertEqual(output1["info"]["screening"]["status"], "blank")
        self.assertEqual(output1["info"]["screening"]["strides_completed"], [24])
        self.assertFalse(output1["images"][0]["partial"])

        # Pass 2: runs to EOF with 0 detections
        r2 = EvaluatedRange(stride=4, start=0, end=24220)
        output2 = SidecarScreeningManager.merge_and_save_sidecar(
            json_path=self.json_path,
            relative_video_name="test_video.mp4",
            width=2560,
            height=1440,
            fps=25.0,
            total_frames=24223,
            new_detections=[],
            new_range=r2,
            stride=4,
            early_exit=False,
            early_exit_frame=None,
            conf_threshold=0.2,
        )
        self.assertEqual(output2["info"]["screening"]["status"], "blank")
        self.assertEqual(output2["info"]["screening"]["strides_completed"], [24, 4])
        # Should compact to stride 4
        self.assertEqual(len(output2["info"]["screening"]["evaluated_ranges"]), 1)
        self.assertEqual(output2["info"]["screening"]["evaluated_ranges"][0]["stride"], 4)

    def test_annotation_pass_completes_detected_video(self):
        # Start with an early-exited video
        det1 = {"category": "1", "conf": 0.85, "bbox": [0.1, 0.2, 0.3, 0.4], "frame": 48, "timestamp": 1.92}
        r1 = EvaluatedRange(stride=24, start=0, end=48)
        SidecarScreeningManager.merge_and_save_sidecar(
            json_path=self.json_path,
            relative_video_name="test_video.mp4",
            width=2560,
            height=1440,
            fps=25.0,
            total_frames=24223,
            new_detections=[det1],
            new_range=r1,
            stride=24,
            early_exit=True,
            early_exit_frame=48,
            conf_threshold=0.2,
        )

        # Run annotation pass at Stride 4 across entire video
        det2 = {"category": "1", "conf": 0.90, "bbox": [0.12, 0.22, 0.3, 0.4], "frame": 500, "timestamp": 20.0}
        r_ann = EvaluatedRange(stride=4, start=0, end=24220)
        output_ann = SidecarScreeningManager.merge_and_save_sidecar(
            json_path=self.json_path,
            relative_video_name="test_video.mp4",
            width=2560,
            height=1440,
            fps=25.0,
            total_frames=24223,
            new_detections=[det2],
            new_range=r_ann,
            stride=4,
            early_exit=False,
            early_exit_frame=None,
            conf_threshold=0.2,
            is_annotation_pass=True,
        )

        self.assertEqual(output_ann["info"]["screening"]["status"], "annotated")
        self.assertFalse(output_ann["images"][0]["partial"])
        self.assertEqual(len(output_ann["images"][0]["detections"]), 2)
        self.assertEqual(output_ann["images"][0]["detections"][0]["frame"], 48)
        self.assertEqual(output_ann["images"][0]["detections"][1]["frame"], 500)

    def test_early_exit_stops_decoding_immediately(self):
        """VideoProcessor with early_exit=True must stop decoding upon first detection and not process remaining batches."""
        from unittest.mock import MagicMock, patch

        import torch
        from detector import VideoProcessor

        mock_decoder_instance = MagicMock()
        batches_yielded = 0

        def mock_iter(*_args, **_kwargs):
            nonlocal batches_yielded
            for b in range(5):
                batches_yielded += 1
                frames = torch.zeros((1, 10, 10, 3), dtype=torch.uint8)
                yield frames, [b * 32], [float(b)]

        mock_decoder_instance.__iter__ = mock_iter
        mock_decoder_instance.samples_read = 32
        mock_decoder_instance.total_samples = 160
        mock_decoder_instance.close = MagicMock()

        processor = VideoProcessor.__new__(VideoProcessor)
        processor.device = "cpu"
        processor.device_id = 0
        processor.default_batch_size = 32
        processor.model_version = "v5a.0.0"

        mock_detector = MagicMock()
        # Return a detection on the first batch
        mock_detector.generate_detections_one_batch.return_value = [
            {
                "file": 0,
                "detections": [
                    {"category": "1", "conf": 0.95, "bbox": [0.1, 0.2, 0.3, 0.4]}
                ],
            }
        ]
        processor._detector = mock_detector

        temp_video = Path(self.test_dir.name) / "test_early_exit_vid.mp4"
        temp_video.touch()

        with patch("detector.DaliVideoDecoder", return_value=mock_decoder_instance):
            chunks = list(processor.process_video_stream(temp_video, early_exit=True, file_size=1024))

        # Must have stopped after batch 1!
        self.assertEqual(batches_yielded, 1)

        # Must have yielded exactly 1 early_exit status
        early_exit_chunks = [c for c in chunks if c.get("status") == "early_exit"]
        self.assertEqual(len(early_exit_chunks), 1)

        # Must have completed with early_exit=True
        complete_chunks = [c for c in chunks if c.get("status") == "complete"]
        self.assertEqual(len(complete_chunks), 1)
        self.assertTrue(complete_chunks[0].get("early_exit"))


if __name__ == "__main__":
    unittest.main()

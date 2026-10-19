"""Unit tests for batch_detect queue partitioning, pass candidacy, and screening state progression."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from batch_detect import (
    VideoItem,
    get_annotation_candidates,
    get_pass_candidates,
    has_completed_stride_or_finer,
)
from screening import EvaluatedRange, ScreeningState


class TestQueuePartitioning(unittest.TestCase):
    def setUp(self):
        self.strides = [24, 4, 1]

        # 1. Completely unprocessed video
        self.unprocessed = VideoItem(
            path=Path("/data/test/unproc.mp4"),
            already_processed=False,
            screening_state=None,
        )

        # 2. Pass 1 Blank (completed stride 24, 0 detections)
        self.p1_blank = VideoItem(
            path=Path("/data/test/p1_blank.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="blank",
                strides_completed=[24],
                max_stride_evaluated=24,
                early_exit=False,
                evaluated_ranges=[EvaluatedRange(stride=24, start=0, end=1000)],
            ),
        )

        # 3. Pass 2 Blank (completed strides 24 and 4, 0 detections)
        self.p2_blank = VideoItem(
            path=Path("/data/test/p2_blank.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="blank",
                strides_completed=[24, 4],
                max_stride_evaluated=4,
                early_exit=False,
                evaluated_ranges=[
                    EvaluatedRange(stride=24, start=0, end=1000),
                    EvaluatedRange(stride=4, start=0, end=1000),
                ],
            ),
        )

        # 4. Certified Blank (completed strides 24, 4, 1, 0 detections)
        self.certified_blank = VideoItem(
            path=Path("/data/test/certified_blank.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="blank",
                strides_completed=[24, 4, 1],
                max_stride_evaluated=1,
                early_exit=False,
                evaluated_ranges=[EvaluatedRange(stride=1, start=0, end=1000)],
            ),
        )

        # 5. Pass 1 Detected (early-exit on first animal at frame 48)
        self.p1_detected = VideoItem(
            path=Path("/data/test/p1_detected.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="detected",
                strides_completed=[],
                max_stride_evaluated=24,
                early_exit=True,
                early_exit_frame=48,
                evaluated_ranges=[EvaluatedRange(stride=24, start=0, end=48)],
            ),
        )

        # 6. Fully Annotated video
        self.annotated = VideoItem(
            path=Path("/data/test/annotated.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="annotated",
                strides_completed=[24, 4],
                max_stride_evaluated=4,
                early_exit=False,
                evaluated_ranges=[EvaluatedRange(stride=4, start=0, end=1000)],
            ),
        )

        self.all_items = [
            self.unprocessed,
            self.p1_blank,
            self.p2_blank,
            self.certified_blank,
            self.p1_detected,
            self.annotated,
        ]

    def test_has_completed_stride_or_finer(self):
        self.assertFalse(has_completed_stride_or_finer(None, 24))
        self.assertTrue(has_completed_stride_or_finer(self.p1_blank.screening_state, 24))
        self.assertFalse(has_completed_stride_or_finer(self.p1_blank.screening_state, 4))
        self.assertFalse(has_completed_stride_or_finer(self.p1_blank.screening_state, 1))

        self.assertTrue(has_completed_stride_or_finer(self.p2_blank.screening_state, 24))
        self.assertTrue(has_completed_stride_or_finer(self.p2_blank.screening_state, 4))
        self.assertFalse(has_completed_stride_or_finer(self.p2_blank.screening_state, 1))

        self.assertTrue(has_completed_stride_or_finer(self.certified_blank.screening_state, 1))

    def test_pass_1_candidates(self):
        # Pass 1 (stride 24): Should only select unprocessed item
        c = get_pass_candidates(self.all_items, strides=self.strides, pass_index=0)
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0].path, self.unprocessed.path)

    def test_pass_2_candidates(self):
        # Pass 2 (stride 4): Should select Pass 1 blanks only
        c = get_pass_candidates(self.all_items, strides=self.strides, pass_index=1)
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0].path, self.p1_blank.path)

    def test_pass_3_candidates(self):
        # Pass 3 (stride 1): Should select Pass 2 blanks only
        c = get_pass_candidates(self.all_items, strides=self.strides, pass_index=2)
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0].path, self.p2_blank.path)

    def test_annotation_candidates(self):
        # Annotation pass: Should select p1_detected only
        c = get_annotation_candidates(self.all_items)
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0].path, self.p1_detected.path)

    def test_legacy_stride_subsumption(self):
        # Legacy video processed at stride 4 (0 detections)
        legacy_blank = VideoItem(
            path=Path("/data/test/legacy_blank.mp4"),
            already_processed=True,
            screening_state=ScreeningState(
                status="blank",
                strides_completed=[4],
                max_stride_evaluated=4,
                early_exit=False,
                evaluated_ranges=[EvaluatedRange(stride=4, start=0, end=1000)],
            ),
        )
        items = [legacy_blank]

        # Since stride 4 is finer than 24, Pass 1 should SKIP it
        p1 = get_pass_candidates(items, strides=self.strides, pass_index=0)
        self.assertEqual(len(p1), 0)

        # Pass 2 should also SKIP it (already has 4)
        p2 = get_pass_candidates(items, strides=self.strides, pass_index=1)
        self.assertEqual(len(p2), 0)

        # Pass 3 (stride 1) should INCLUDE it to certify blank
        p3 = get_pass_candidates(items, strides=self.strides, pass_index=2)
        self.assertEqual(len(p3), 1)


if __name__ == "__main__":
    unittest.main()

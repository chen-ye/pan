"""Unit test for empty / 0-byte video handling and skipping."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))

from detector import DaliVideoDecoder, VideoProcessor


class TestEmptyVideoHandling(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.empty_video = Path(self.temp_dir.name) / "empty.mp4"
        self.empty_video.touch()  # Creates a 0-byte file

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_dali_decoder_raises_value_error_on_empty_file(self):
        """DaliVideoDecoder should fail fast with ValueError on 0-byte files before touching DALI C++."""
        with self.assertRaises(ValueError) as ctx:
            DaliVideoDecoder(self.empty_video)
        self.assertIn("empty (0 bytes)", str(ctx.exception))

    def test_process_video_stream_skips_empty_file(self):
        """process_video_stream should yield status: 'skipped' without throwing exceptions."""
        processor = VideoProcessor.__new__(VideoProcessor)
        processor.device = "cpu"
        processor.default_batch_size = 32

        chunks = list(processor.process_video_stream(self.empty_video))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].get("status"), "skipped")
        self.assertEqual(chunks[0].get("reason"), "empty_file")


if __name__ == "__main__":
    unittest.main()

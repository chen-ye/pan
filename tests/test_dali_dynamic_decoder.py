"""Unit tests for DaliVideoDecoder in dynamic mode."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))

from detector import DaliVideoDecoder


class TestDaliDynamicDecoder(unittest.TestCase):
    def test_empty_file_fails_fast(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as tf:
            with self.assertRaises(ValueError) as ctx:
                DaliVideoDecoder(tf.name)
            self.assertIn("empty (0 bytes)", str(ctx.exception))

    def test_corrupt_file_raises_value_error(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as tf:
            tf.write(b"not a valid mp4 header or bitstream")
            tf.flush()
            with self.assertRaises(ValueError) as ctx:
                DaliVideoDecoder(tf.name)
            self.assertIn("0 decodeable samples", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

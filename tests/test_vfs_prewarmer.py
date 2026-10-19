"""Unit tests for sliding window lookahead VfsPrewarmer."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from batch_detect import VfsPrewarmer, VideoItem


class TestVfsPrewarmer(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.test_files: list[Path] = []
        # Create 5 test files, 100 KB each (100 * 1024 bytes)
        for i in range(5):
            p = Path(self.temp_dir.name) / f"video_{i:02d}.mp4"
            p.write_bytes(b"X" * (100 * 1024))
            self.test_files.append(p)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_prewarmer_sliding_window_buffer_cap(self):
        """VfsPrewarmer should buffer upcoming files up to the buffer threshold without exceeding it."""
        items = [VideoItem(p, file_size=100 * 1024) for p in self.test_files]

        # 150 KB total buffer (exact match for 3 files * 50 KB head cap), 10 KB chunks
        prewarmer = VfsPrewarmer(
            buffer_size_mb=1,
            head_size_mb=1,
            chunk_size_mb=1,
        )
        prewarmer.max_buffer_bytes = 150 * 1024  # 150 KB buffer limit
        prewarmer.head_size_bytes = 50 * 1024   # 50 KB per video head cap
        prewarmer.chunk_size = 10 * 1024        # 10 KB chunk size

        # Start at index 0 (decoder is processing item 0, upcoming are 1, 2, 3, 4)
        prewarmer.set_queue(items, start_index=0, early_exit=True)

        # Wait for prewarmer to fill buffer
        deadline = time.time() + 2.0
        while time.time() < deadline:
            with prewarmer._cv:
                total_buf = sum(max(v, 0) for v in prewarmer._prewarmed_bytes.values())
                if total_buf >= 150 * 1024:
                    break
            time.sleep(0.05)

        with prewarmer._cv:
            total_buf = sum(max(v, 0) for v in prewarmer._prewarmed_bytes.values())
            self.assertEqual(total_buf, 150 * 1024)
            # Item 4 should not have been read yet because buffer limit was reached
            self.assertNotIn(str(items[4].path), prewarmer._prewarmed_bytes)

        # Now advance decoder to index 1 (item 1 is consumed, upcoming are 2, 3, 4)
        prewarmer.advance(1)

        # Prewarmer should now see freed budget and prewarm item 4
        deadline = time.time() + 2.0
        while time.time() < deadline:
            with prewarmer._cv:
                if str(items[4].path) in prewarmer._prewarmed_bytes:
                    break
            time.sleep(0.05)

        with prewarmer._cv:
            self.assertIn(str(items[4].path), prewarmer._prewarmed_bytes)
            self.assertEqual(prewarmer._prewarmed_bytes[str(items[4].path)], 50 * 1024)

        prewarmer.stop()

    def test_prewarmer_partial_buffer_cap(self):
        """VfsPrewarmer clamps chunk reads so total buffered bytes never exceed max_buffer_bytes."""
        items = [VideoItem(p, file_size=100 * 1024) for p in self.test_files]

        # 160 KB total buffer: 3 files * 50 KB = 150 KB, leaving 10 KB remaining for file 4
        prewarmer = VfsPrewarmer(
            buffer_size_mb=1,
            head_size_mb=1,
            chunk_size_mb=1,
        )
        prewarmer.max_buffer_bytes = 160 * 1024
        prewarmer.head_size_bytes = 50 * 1024
        prewarmer.chunk_size = 25 * 1024  # Chunk size larger than 10 KB remainder

        prewarmer.set_queue(items, start_index=0, early_exit=True)

        deadline = time.time() + 2.0
        while time.time() < deadline:
            with prewarmer._cv:
                total_buf = sum(max(v, 0) for v in prewarmer._prewarmed_bytes.values())
                if total_buf >= 160 * 1024:
                    break
            time.sleep(0.05)

        with prewarmer._cv:
            total_buf = sum(max(v, 0) for v in prewarmer._prewarmed_bytes.values())
            self.assertEqual(total_buf, 160 * 1024)
            # File 4 should have received exactly 10 KB clamped read
            self.assertEqual(prewarmer._prewarmed_bytes[str(items[4].path)], 10 * 1024)

        prewarmer.stop()

    def test_prewarmer_standalone_single_file(self):
        """Fallback prewarm() on a single file should read up to max_bytes."""
        target = self.test_files[0]
        prewarmer = VfsPrewarmer(buffer_size_mb=10, head_size_mb=10)
        prewarmer.chunk_size = 5 * 1024

        prewarmer.prewarm(target, max_bytes=20 * 1024)
        time.sleep(0.15)
        prewarmer.stop()

        # Should finish cleanly without errors
        self.assertFalse(prewarmer._thread.is_alive())


if __name__ == "__main__":
    unittest.main()

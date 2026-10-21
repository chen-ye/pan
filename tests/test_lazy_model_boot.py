"""Unit tests for lazy MegaDetector model booting in worker and VideoProcessor."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))

import main as worker_main
from detector import VideoProcessor


class TestLazyModelBoot(unittest.TestCase):
    def setUp(self):
        # Reset worker_main global processor for isolated testing
        worker_main.processor = None

    def tearDown(self):
        worker_main.processor = None

    @patch("detector.TorchVisionMegaDetector")
    def test_video_processor_lazy_init_does_not_load_detector(self, mock_detector_cls):
        """VideoProcessor with lazy=True should not instantiate TorchVisionMegaDetector on init."""
        proc = VideoProcessor(lazy=True)
        self.assertFalse(proc.is_model_loaded)
        mock_detector_cls.assert_not_called()

        # Accessing .detector should trigger initialization
        detector = proc.detector
        self.assertIsNotNone(detector)
        self.assertTrue(proc.is_model_loaded)
        mock_detector_cls.assert_called_once()

        # Repeated access should reuse the same detector instance
        detector2 = proc.detector
        self.assertIs(detector, detector2)
        mock_detector_cls.assert_called_once()

    @patch("detector.TorchVisionMegaDetector")
    def test_video_processor_unload_model(self, mock_detector_cls):
        """unload_model should clear detector and reset is_model_loaded."""
        proc = VideoProcessor(lazy=True)
        _ = proc.detector
        self.assertTrue(proc.is_model_loaded)

        proc.unload_model()
        self.assertFalse(proc.is_model_loaded)

        # Accessing again should re-instantiate
        _ = proc.detector
        self.assertTrue(proc.is_model_loaded)
        self.assertEqual(mock_detector_cls.call_count, 2)

    @patch("detector.TorchVisionMegaDetector")
    def test_worker_status_endpoint_reports_unloaded_initially(self, mock_detector_cls):
        """Worker /status should return status: ready and model_loaded: False without booting model."""
        client = worker_main.app.test_client()
        # Initialize processor lazily
        worker_main.processor = VideoProcessor(lazy=True)

        res = client.get("/status")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data.get("status"), "ready")
        self.assertFalse(data.get("model_loaded"))
        mock_detector_cls.assert_not_called()

    @patch("detector.TorchVisionMegaDetector")
    def test_worker_warmup_and_unload_endpoints(self, mock_detector_cls):
        """Worker /warmup should boot model and /unload should unload it."""
        client = worker_main.app.test_client()
        worker_main.processor = VideoProcessor(lazy=True)

        # Warmup
        res_warmup = client.post("/warmup")
        self.assertEqual(res_warmup.status_code, 200)
        self.assertTrue(res_warmup.get_json().get("model_loaded"))
        mock_detector_cls.assert_called_once()

        # Status check after warmup
        res_status = client.get("/status")
        self.assertTrue(res_status.get_json().get("model_loaded"))

        # Unload
        res_unload = client.post("/unload")
        self.assertEqual(res_unload.status_code, 200)
        self.assertFalse(res_unload.get_json().get("model_loaded"))

        # Status check after unload
        res_status2 = client.get("/status")
        self.assertFalse(res_status2.get_json().get("model_loaded"))


if __name__ == "__main__":
    unittest.main()

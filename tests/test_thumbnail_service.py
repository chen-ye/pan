import http.client
import subprocess
import sys
import threading
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import thumbnail.server as thumb_srv


@pytest.fixture
def mock_data_dir(tmp_path: Path) -> Path:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    video_dir = data_dir / "Backyard" / "2025" / "08" / "11"
    video_dir.mkdir(parents=True)
    video_file = video_dir / "test.mp4"
    video_file.write_bytes(b"dummy mp4 content")
    return data_dir


@pytest.fixture
def running_server(mock_data_dir: Path) -> Generator[str, None, None]:
    orig_dir = thumb_srv.DATA_DIR
    orig_port = thumb_srv.PORT
    thumb_srv.DATA_DIR = mock_data_dir.resolve()
    thumb_srv.PORT = 0  # Ephemeral port
    thumb_srv.clear_thumbnail_cache()

    httpd = thumb_srv.ThreadingHTTPServer(("127.0.0.1", 0), thumb_srv.ThumbnailHandler)
    port = httpd.server_address[1]

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    yield f"127.0.0.1:{port}"

    httpd.shutdown()
    httpd.server_close()
    thumb_srv.clear_thumbnail_cache()
    thumb_srv.DATA_DIR = orig_dir
    thumb_srv.PORT = orig_port


def test_health_check(running_server: str) -> None:
    conn = http.client.HTTPConnection(running_server)
    conn.request("GET", "/health")
    resp = conn.getresponse()
    assert resp.status == 200
    assert resp.read() == b'{"status":"ok"}\n'
    conn.close()


def test_missing_path(running_server: str) -> None:
    conn = http.client.HTTPConnection(running_server)
    conn.request("GET", "/thumbnail")
    resp = conn.getresponse()
    assert resp.status == 400
    conn.close()


def test_path_traversal_denied(running_server: str) -> None:
    conn = http.client.HTTPConnection(running_server)
    conn.request("GET", "/thumbnail?path=../../etc/passwd")
    resp = conn.getresponse()
    assert resp.status in (400, 403, 404)
    conn.close()


def test_file_not_found(running_server: str) -> None:
    conn = http.client.HTTPConnection(running_server)
    conn.request("GET", "/thumbnail?path=Backyard/nonexistent.mp4")
    resp = conn.getresponse()
    assert resp.status == 404
    conn.close()


def test_successful_thumbnail_generation(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF"
    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.stdout = fake_jpeg

    with patch("subprocess.run", return_value=mock_proc) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&bbox=0.1,0.2,0.3,0.4&size=320")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.getheader("Content-Type") == "image/jpeg"
        assert resp.getheader("Cache-Control") == "public, max-age=86400, immutable"
        body = resp.read()
        assert body == fake_jpeg

        # Verify command flags
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert cmd[1] == "-hwaccel"
        assert cmd[2] == "cuda"
        assert "-threads" in cmd
        assert cmd[cmd.index("-threads") + 1] == "1"
        assert "-nostdin" in cmd
        assert "-ss" in cmd
        assert "12.500" in cmd
        assert "-vf" in cmd
        assert "crop=" in cmd[cmd.index("-vf") + 1]
        assert "scale='min(320,iw)':-1" in cmd[cmd.index("-vf") + 1]
        conn.close()


def test_cached_thumbnail_generation(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF"
    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.stdout = fake_jpeg

    with patch("subprocess.run", return_value=mock_proc) as mock_run:
        # First request populates cache
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&bbox=0.1,0.2,0.3,0.4&size=320")
        resp1 = conn.getresponse()
        assert resp1.status == 200
        assert resp1.read() == fake_jpeg
        assert mock_run.call_count == 1

        # Second request must hit cache without invoking subprocess
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&bbox=0.1,0.2,0.3,0.4&size=320")
        resp2 = conn.getresponse()
        assert resp2.status == 200
        assert resp2.read() == fake_jpeg
        assert mock_run.call_count == 1
        conn.close()


def test_gpu_decode_failure_returns_500_without_fallback(running_server: str) -> None:
    mock_proc = MagicMock()
    mock_proc.returncode = 1
    mock_proc.stdout = b""
    mock_proc.stderr = b"CUDA driver error: out of memory"

    with patch("subprocess.run", return_value=mock_proc) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&size=320")
        resp = conn.getresponse()
        assert resp.status == 500
        # Crucial check: only GPU decode was attempted, no CPU fallback was spawned
        assert mock_run.call_count == 1
        conn.close()


def test_gpu_decode_timeout_returns_500_without_fallback(running_server: str) -> None:
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=20)) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&size=320")
        resp = conn.getresponse()
        assert resp.status == 500
        # Crucial check: no CPU fallback was spawned on timeout
        assert mock_run.call_count == 1
        conn.close()

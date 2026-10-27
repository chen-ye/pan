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

    httpd = thumb_srv.ThreadingHTTPServer(("127.0.0.1", 0), thumb_srv.ThumbnailHandler)
    port = httpd.server_address[1]

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    yield f"127.0.0.1:{port}"

    httpd.shutdown()
    httpd.server_close()
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


def test_gpu_decode_failure_falls_back_to_cpu(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF"
    gpu_fail = MagicMock(returncode=1, stdout=b"", stderr=b"CUDA driver error: out of memory")
    cpu_ok = MagicMock(returncode=0, stdout=fake_jpeg, stderr=b"")

    with patch("subprocess.run", side_effect=[gpu_fail, cpu_ok]) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&size=320")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == fake_jpeg
        assert mock_run.call_count == 2
        conn.close()


def test_gpu_timeout_and_cpu_failure_returns_500(running_server: str) -> None:
    cpu_fail = MagicMock(returncode=1, stdout=b"", stderr=b"Invalid data")
    with patch(
        "subprocess.run",
        side_effect=[subprocess.TimeoutExpired(cmd="ffmpeg", timeout=5), cpu_fail],
    ) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&time=12.5&size=320")
        resp = conn.getresponse()
        assert resp.status == 500
        assert mock_run.call_count == 2
        conn.close()


def test_invalid_mode_returns_400(running_server: str) -> None:
    conn = http.client.HTTPConnection(running_server)
    conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&mode=bogus")
    resp = conn.getresponse()
    assert resp.status == 400
    conn.close()


def test_chrono_mode_builds_11_input_tmedian_maskedmerge_pipeline(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10CHRONO"
    probe_ok = MagicMock(returncode=0, stdout=b"300.0\n", stderr=b"")
    ffmpeg_ok = MagicMock(returncode=0, stdout=fake_jpeg, stderr=b"")

    with patch("subprocess.run", side_effect=[probe_ok, ffmpeg_ok]) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&mode=chrono&size=320")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == fake_jpeg
        assert mock_run.call_count == 2

        ffmpeg_cmd = mock_run.call_args_list[1][0][0]
        assert ffmpeg_cmd.count("-i") == 11
        assert ffmpeg_cmd.count("-noaccurate_seek") == 11
        assert ffmpeg_cmd.count("nokey") == 11
        filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]
        assert "tmedian=radius=5" in filter_complex
        assert "blend=all_mode=grainextract" in filter_complex
        assert "drawbox=x=0:y=ih*0.93:w=iw*0.24:h=ih*0.07" in filter_complex
        assert "maskedmerge" in filter_complex
        assert "scale=320:180:flags=lanczos" in filter_complex
        conn.close()


def test_chrono_mode_short_video_falls_back_to_midpoint_frame(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10SHORT"
    probe_ok = MagicMock(returncode=0, stdout=b"4.0\n", stderr=b"")
    ffmpeg_ok = MagicMock(returncode=0, stdout=fake_jpeg, stderr=b"")

    with patch("subprocess.run", side_effect=[probe_ok, ffmpeg_ok]) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&mode=chrono&size=320")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == fake_jpeg
        assert mock_run.call_count == 2

        ffmpeg_cmd = mock_run.call_args_list[1][0][0]
        assert ffmpeg_cmd.count("-i") == 1
        assert "2.000" in ffmpeg_cmd
        assert "-filter_complex" not in ffmpeg_cmd
        conn.close()


def test_filmstrip_mode_builds_10x1_zero_padding_ribbon(running_server: str) -> None:
    fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10STRIP"
    probe_ok = MagicMock(returncode=0, stdout=b"100.0\n", stderr=b"")
    ffmpeg_ok = MagicMock(returncode=0, stdout=fake_jpeg, stderr=b"")

    with patch("subprocess.run", side_effect=[probe_ok, ffmpeg_ok]) as mock_run:
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&mode=filmstrip")
        resp = conn.getresponse()
        assert resp.status == 200
        assert resp.read() == fake_jpeg
        assert mock_run.call_count == 2

        ffmpeg_cmd = mock_run.call_args_list[1][0][0]
        assert ffmpeg_cmd.count("-i") == 10
        filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]
        assert "scale=128:72" in filter_complex
        assert "tile=10x1:padding=0:margin=0" in filter_complex
        conn.close()


def test_summary_aborts_when_client_socket_disconnected(running_server: str) -> None:
    with (
        patch.object(thumb_srv.ThumbnailHandler, "_is_client_disconnected", return_value=True),
        patch("subprocess.run") as mock_run,
    ):
        conn = http.client.HTTPConnection(running_server)
        conn.request("GET", "/thumbnail?path=Backyard/2025/08/11/test.mp4&mode=chrono")
        try:
            conn.getresponse()
        except http.client.RemoteDisconnected:
            pass
        assert mock_run.call_count == 0
        conn.close()

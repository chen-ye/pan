import logging
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("thumbnail-service")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "/usr/lib/jellyfin-ffmpeg/ffmpeg")
PORT = int(os.environ.get("PORT", "8080"))


class ThumbnailHandler(BaseHTTPRequestHandler):
    def do_HEAD(self) -> None:
        self.handle_request(send_body=False)

    def do_GET(self) -> None:
        self.handle_request(send_body=True)

    def handle_request(self, send_body: bool = True) -> None:
        parsed_url = urlparse(self.path)
        path = parsed_url.path.rstrip("/")

        if path in ("", "/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if send_body:
                self.wfile.write(b'{"status":"ok"}\n')
            return

        if path not in ("/thumbnail", "/crop"):
            self.send_error(404, "Endpoint not found")
            return

        params = parse_qs(parsed_url.query)
        rel_path = params.get("path", [""])[0]
        if not rel_path:
            self.send_error(400, "Missing required query parameter: path")
            return

        try:
            # Prevent directory traversal
            target_path = (DATA_DIR / rel_path.lstrip("/")).resolve()
            if not target_path.is_relative_to(DATA_DIR):
                self.send_error(403, "Access denied")
                return
            if not target_path.is_file():
                self.send_error(404, f"File not found: {rel_path}")
                return
        except (OSError, ValueError) as e:
            logger.warning("Error resolving path '%s': %s", rel_path, e)
            self.send_error(400, "Invalid path")
            return

        # Parse timestamp
        timestamp_str = params.get("time", ["0"])[0]
        try:
            timestamp = max(0.0, float(timestamp_str))
        except ValueError:
            self.send_error(400, "Invalid timestamp parameter: time")
            return

        # Parse max size
        size_str = params.get("size", ["320"])[0]
        try:
            size = max(32, min(1920, int(size_str)))
        except ValueError:
            size = 320

        # Build video filter for cropping and scaling
        vf_filters: list[str] = []
        bbox_str = params.get("bbox", [""])[0]
        if bbox_str:
            try:
                coords = [float(v.strip()) for v in bbox_str.split(",")]
                if len(coords) == 4:
                    x, y, w, h = coords
                    # Check if normalized [0, 1]
                    if max(x, y, w, h) <= 1.0:
                        w_clamped = max(0.01, min(1.0, w))
                        h_clamped = max(0.01, min(1.0, h))
                        x_clamped = max(0.0, min(1.0 - w_clamped, x))
                        y_clamped = max(0.0, min(1.0 - h_clamped, y))
                        vf_filters.append(
                            f"crop=w=iw*{w_clamped:.4f}:h=ih*{h_clamped:.4f}:x=iw*{x_clamped:.4f}:y=ih*{y_clamped:.4f}"
                        )
                    else:
                        vf_filters.append(f"crop=w={int(w)}:h={int(h)}:x={int(x)}:y={int(y)}")
            except ValueError:
                logger.debug("Failed to parse bbox '%s', falling back to uncropped", bbox_str)

        vf_filters.append(f"scale='min({size},iw)':-1")
        vf = ",".join(vf_filters)

        # First attempt: hardware-accelerated decode via NVDEC (cuda)
        cmd_cuda = [
            FFMPEG_BIN,
            "-hwaccel",
            "cuda",
            "-ss",
            f"{timestamp:.3f}",
            "-i",
            str(target_path),
            "-vf",
            vf,
            "-vframes",
            "1",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "3",
            "pipe:1",
        ]

        jpeg_bytes: bytes | None = None
        try:
            proc = subprocess.run(
                cmd_cuda,
                capture_output=True,
                timeout=8,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                jpeg_bytes = proc.stdout
            else:
                logger.debug(
                    "CUDA decode returned code %d, falling back to CPU: %s",
                    proc.returncode,
                    proc.stderr.decode("utf-8", errors="replace"),
                )
        except (subprocess.SubprocessError, OSError) as e:
            logger.debug("CUDA decode failed (%s), falling back to CPU", e)

        # Fallback attempt: CPU decode
        if not jpeg_bytes:
            cmd_cpu = [
                FFMPEG_BIN,
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(target_path),
                "-vf",
                vf,
                "-vframes",
                "1",
                "-f",
                "image2",
                "-c:v",
                "mjpeg",
                "-q:v",
                "3",
                "pipe:1",
            ]
            try:
                proc = subprocess.run(
                    cmd_cpu,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                if proc.returncode == 0 and proc.stdout:
                    jpeg_bytes = proc.stdout
                else:
                    err_msg = proc.stderr.decode("utf-8", errors="replace")
                    logger.error("CPU decode failed for %s at %ss: %s", rel_path, timestamp, err_msg)
                    self.send_error(500, f"Frame decode failed: {err_msg[:200]}")
                    return
            except (subprocess.SubprocessError, OSError) as e:
                logger.error("CPU decode process error: %s", e)
                self.send_error(500, "Frame decode error")
                return

        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg_bytes)))
        self.send_header("Cache-Control", "public, max-age=86400, immutable")
        self.end_headers()

        if send_body:
            try:
                self.wfile.write(jpeg_bytes)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, format: str, *args: object) -> None:
        # Suppress noisy standard HTTP access logs
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("%s - " + format, self.address_string(), *args)


def run() -> None:
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, ThumbnailHandler)
    logger.info("Thumbnail service listening on port %d (data: %s, ffmpeg: %s)", PORT, DATA_DIR, FFMPEG_BIN)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run()

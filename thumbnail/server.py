import logging
import os
import subprocess
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("thumbnail-service")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "/usr/lib/jellyfin-ffmpeg/ffmpeg")
PORT = int(os.environ.get("PORT", "8080"))

MAX_CONCURRENT_DECODES = int(os.environ.get("MAX_CONCURRENT_DECODES", "3"))
DECODE_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_DECODES)
DECODE_TIMEOUT = int(os.environ.get("DECODE_TIMEOUT", "20"))

MAX_CACHE_ENTRIES = int(os.environ.get("MAX_CACHE_ENTRIES", "2048"))
CACHE_LOCK = threading.Lock()
THUMBNAIL_CACHE: OrderedDict[str, bytes] = OrderedDict()


def get_cached_thumbnail(key: str) -> bytes | None:
    with CACHE_LOCK:
        if key in THUMBNAIL_CACHE:
            THUMBNAIL_CACHE.move_to_end(key)
            return THUMBNAIL_CACHE[key]
    return None


def put_cached_thumbnail(key: str, data: bytes) -> None:
    with CACHE_LOCK:
        THUMBNAIL_CACHE[key] = data
        THUMBNAIL_CACHE.move_to_end(key)
        if len(THUMBNAIL_CACHE) > MAX_CACHE_ENTRIES:
            THUMBNAIL_CACHE.popitem(last=False)


def clear_thumbnail_cache() -> None:
    with CACHE_LOCK:
        THUMBNAIL_CACHE.clear()


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
        except (OSError, ValueError) as exc:
            logger.warning("Error resolving path '%s': %s", rel_path, exc)
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
                coords = [float(val.strip()) for val in bbox_str.split(",")]
                if len(coords) == 4:
                    box_x, box_y, box_w, box_h = coords
                    # Check if normalized [0, 1]
                    if max(box_x, box_y, box_w, box_h) <= 1.0:
                        w_clamped = max(0.01, min(1.0, box_w))
                        h_clamped = max(0.01, min(1.0, box_h))
                        x_clamped = max(0.0, min(1.0 - w_clamped, box_x))
                        y_clamped = max(0.0, min(1.0 - h_clamped, box_y))
                        vf_filters.append(
                            f"crop=w=iw*{w_clamped:.4f}:h=ih*{h_clamped:.4f}:x=iw*{x_clamped:.4f}:y=ih*{y_clamped:.4f}"
                        )
                    else:
                        vf_filters.append(f"crop=w={int(box_w)}:h={int(box_h)}:x={int(box_x)}:y={int(box_y)}")
            except ValueError:
                logger.debug("Failed to parse bbox '%s', falling back to uncropped", bbox_str)

        vf_filters.append(f"scale='min({size},iw)':-1")
        vf = ",".join(vf_filters)

        cache_key = f"{rel_path}:{timestamp:.3f}:{bbox_str}:{size}"
        cached_bytes = get_cached_thumbnail(cache_key)
        if cached_bytes is not None:
            self._send_image_response(cached_bytes, send_body=send_body)
            return

        # Acquire concurrency semaphore to stay strictly within NVDEC hardware session limits
        acquired = DECODE_SEMAPHORE.acquire(timeout=30)
        if not acquired:
            logger.error("GPU decode queue busy, semaphore wait timed out for %s", rel_path)
            self.send_error(503, "GPU decode service busy, please retry")
            return

        try:
            # Re-check cache in case another worker thread generated it while waiting
            cached_bytes = get_cached_thumbnail(cache_key)
            if cached_bytes is not None:
                self._send_image_response(cached_bytes, send_body=send_body)
                return

            jpeg_bytes = self._decode_frame_gpu(target_path, rel_path, timestamp, vf)
            if jpeg_bytes is None:
                self.send_error(500, "GPU frame decode failed")
                return

            put_cached_thumbnail(cache_key, jpeg_bytes)
            self._send_image_response(jpeg_bytes, send_body=send_body)
        finally:
            DECODE_SEMAPHORE.release()

    def _decode_frame_gpu(self, target_path: Path, rel_path: str, timestamp: float, vf: str) -> bytes | None:
        """Hardware-accelerated decode via NVDEC (cuda). CPU fallback is intentionally omitted."""
        cmd = [
            FFMPEG_BIN,
            "-hwaccel",
            "cuda",
            "-threads",
            "1",
            "-nostdin",
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
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=DECODE_TIMEOUT,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout

            err_text = proc.stderr.decode("utf-8", errors="replace")
            logger.error(
                "GPU NVDEC decode failed for %s at %.3fs (exit code %d): %s",
                rel_path,
                timestamp,
                proc.returncode,
                err_text[-500:].strip(),
            )
            return None
        except subprocess.TimeoutExpired:
            logger.error(
                "GPU NVDEC decode timed out after %ds for %s at %.3fs",
                DECODE_TIMEOUT,
                rel_path,
                timestamp,
            )
            return None
        except (subprocess.SubprocessError, OSError) as exc:
            logger.error("GPU decode process error for %s at %.3fs: %s", rel_path, timestamp, exc)
            return None

    def _send_image_response(self, jpeg_bytes: bytes, send_body: bool = True) -> None:
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
    logger.info(
        "Thumbnail service listening on port %d (data: %s, ffmpeg: %s, max_concurrent_gpu: %d)",
        PORT,
        DATA_DIR,
        FFMPEG_BIN,
        MAX_CONCURRENT_DECODES,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run()

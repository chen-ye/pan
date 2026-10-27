import logging
import os
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("thumbnail-service")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "/usr/lib/jellyfin-ffmpeg/ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_BIN", "/usr/lib/jellyfin-ffmpeg/ffprobe")
PORT = int(os.environ.get("PORT", "8080"))

MAX_CONCURRENT_DECODES = int(os.environ.get("MAX_CONCURRENT_DECODES", "4"))
DECODE_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_DECODES)
DECODE_TIMEOUT = int(os.environ.get("DECODE_TIMEOUT", "5"))

MAX_CONCURRENT_SUMMARIES = int(os.environ.get("MAX_CONCURRENT_SUMMARIES", "2"))
SUMMARY_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_SUMMARIES)
SUMMARY_TIMEOUT = int(os.environ.get("SUMMARY_TIMEOUT", "90"))


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

        if path != "/thumbnail":
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

        mode = params.get("mode", ["frame"])[0].strip().lower() or "frame"
        if mode not in ("frame", "chrono", "filmstrip"):
            self.send_error(400, f"Invalid mode parameter: {mode}")
            return

        if mode in ("chrono", "filmstrip"):
            self._handle_summary_request(mode, params, target_path, rel_path, send_body=send_body)
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

        # Acquire concurrency semaphore to stay strictly within NVDEC hardware session limits
        acquired = DECODE_SEMAPHORE.acquire(timeout=5)
        if not acquired:
            logger.info("GPU decode queue busy for %s, falling back directly to CPU decode", rel_path)
            jpeg_bytes = self._decode_frame_cpu(target_path, rel_path, timestamp, vf)
            if jpeg_bytes is None:
                self.send_error(500, "Frame decode failed")
                return
            self._send_image_response(jpeg_bytes, send_body=send_body)
            return

        try:
            jpeg_bytes = self._decode_frame_gpu(target_path, rel_path, timestamp, vf)
            if jpeg_bytes is None:
                logger.info("Retrying frame decode via CPU for %s at %.3fs", rel_path, timestamp)
                jpeg_bytes = self._decode_frame_cpu(target_path, rel_path, timestamp, vf)

            if jpeg_bytes is None:
                self.send_error(500, "Frame decode failed")
                return

            self._send_image_response(jpeg_bytes, send_body=send_body)
        finally:
            DECODE_SEMAPHORE.release()

    def _decode_frame_gpu(self, target_path: Path, rel_path: str, timestamp: float, vf: str) -> bytes | None:
        """Hardware-accelerated decode via NVDEC (cuda)."""
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
            "-an",
            "-sn",
            "-dn",
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

    def _decode_frame_cpu(self, target_path: Path, rel_path: str, timestamp: float, vf: str) -> bytes | None:
        """Fallback CPU decode in case GPU decode or CUDA lock times out."""
        cmd = [
            FFMPEG_BIN,
            "-threads",
            "2",
            "-nostdin",
            "-an",
            "-sn",
            "-dn",
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
                timeout=30,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout
            err_text = proc.stderr.decode("utf-8", errors="replace")
            logger.error(
                "CPU fallback decode failed for %s at %.3fs (exit code %d): %s",
                rel_path,
                timestamp,
                proc.returncode,
                err_text[-500:].strip(),
            )
            return None
        except (subprocess.SubprocessError, OSError) as exc:
            logger.error("CPU fallback decode process error for %s at %.3fs: %s", rel_path, timestamp, exc)
            return None

    def _handle_summary_request(
        self,
        mode: str,
        params: dict[str, list[str]],
        target_path: Path,
        rel_path: str,
        send_body: bool = True,
    ) -> None:
        if mode == "chrono":
            size_str = params.get("size", ["320"])[0]
            try:
                raw_size = int(size_str)
            except ValueError:
                raw_size = 320
            out_width = max(160, min(1920, raw_size))
            out_width -= out_width % 2
            out_height = max(90, round(out_width * 9 / 16))
            out_height -= out_height % 2
            tile_count = 0
            tile_width = 0
            tile_height = 0
        else:
            tiles_str = params.get("tiles", ["10"])[0]
            try:
                tile_count = max(4, min(20, int(tiles_str)))
            except ValueError:
                tile_count = 10

            height_str = params.get("height", ["72"])[0]
            try:
                raw_height = int(height_str)
            except ValueError:
                raw_height = 72
            tile_height = max(36, min(180, raw_height))
            tile_height -= tile_height % 2
            tile_width = max(64, round(tile_height * 16 / 9))
            tile_width -= tile_width % 2
            out_width = 0
            out_height = 0

        acquired = SUMMARY_SEMAPHORE.acquire(timeout=SUMMARY_TIMEOUT)
        if not acquired:
            logger.warning("Summary queue saturated for %s (mode=%s)", rel_path, mode)
            self.send_error(503, "Summary generation queue busy")
            return

        try:
            if self._is_client_disconnected():
                logger.info("Client disconnected before %s summary started for %s", mode, rel_path)
                return

            duration = self._probe_duration(target_path, rel_path)
            if duration is None or duration <= 0.0:
                self.send_error(500, "Failed to probe video duration")
                return

            if mode == "chrono":
                jpeg_bytes = self._render_chronophotograph(
                    target_path, rel_path, duration, out_width, out_height
                )
            else:
                jpeg_bytes = self._render_filmstrip(
                    target_path, rel_path, duration, tile_count, tile_width, tile_height
                )

            if jpeg_bytes is None:
                self.send_error(500, f"{mode.capitalize()} summary generation failed")
                return

            self._send_image_response(jpeg_bytes, send_body=send_body)
        finally:
            SUMMARY_SEMAPHORE.release()

    def _is_client_disconnected(self) -> bool:
        """Non-blocking socket peek to detect if the client aborted while queued."""
        try:
            peek_bytes = self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
            return peek_bytes == b""
        except BlockingIOError:
            return False
        except (BrokenPipeError, ConnectionResetError, OSError):
            return True
        except (AttributeError, ValueError):
            return False

    def _probe_duration(self, target_path: Path, rel_path: str) -> float | None:
        cmd = [
            FFPROBE_BIN,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(target_path),
        ]
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=30,
                check=False,
            )
            if proc.returncode != 0 or not proc.stdout:
                err_text = proc.stderr.decode("utf-8", errors="replace").strip()
                logger.error("ffprobe failed for %s (exit %d): %s", rel_path, proc.returncode, err_text[-300:])
                return None
            return float(proc.stdout.decode("utf-8", errors="replace").strip())
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            logger.error("ffprobe duration error for %s: %s", rel_path, exc)
            return None

    def _render_chronophotograph(
        self,
        target_path: Path,
        rel_path: str,
        duration: float,
        out_width: int,
        out_height: int,
    ) -> bytes | None:
        if duration < 6.0:
            midpoint = duration * 0.5
            return self._decode_frame_cpu(
                target_path,
                rel_path,
                midpoint,
                f"scale={out_width}:{out_height}",
            )

        sample_count = 11
        median_radius = 5
        work_width = max(640, out_width)
        work_height = max(360, out_height)
        blur_sigma = max(18, round(work_width * 0.028))

        input_args: list[str] = []
        filter_parts: list[str] = []
        bg_concat_inputs: list[str] = []

        for idx in range(sample_count):
            sample_ts = duration * (idx + 0.5) / sample_count
            input_args.extend(
                [
                    "-noaccurate_seek",
                    "-skip_frame",
                    "nokey",
                    "-ss",
                    f"{sample_ts:.3f}",
                    "-i",
                    str(target_path),
                ]
            )
            filter_parts.append(
                f"[{idx}:v]trim=end_frame=1,setpts=PTS-STARTPTS,"
                f"scale={work_width}:{work_height},format=gbrp,"
                f"split=3[fg{idx}][bg_in{idx}][hp_in{idx}]"
            )
            bg_concat_inputs.append(f"[bg_in{idx}]")

        filter_parts.append(
            f"{''.join(bg_concat_inputs)}concat=n={sample_count}:v=1:a=0,"
            f"tmedian=radius={median_radius},setpts=PTS-STARTPTS,"
            f"split=2[canvas0][bg_for_hp]"
        )

        ref_outputs = "".join(f"[ref{idx}]" for idx in range(sample_count))
        filter_parts.extend(
            [
                "[bg_for_hp]format=gray,gblur=sigma=1.2,split=2[bgr][bgb]",
                f"[bgb]gblur=sigma={blur_sigma}[bgl]",
                f"[bgr][bgl]blend=all_mode=grainextract,split={sample_count}{ref_outputs}",
            ]
        )

        for idx in range(sample_count):
            filter_parts.extend(
                [
                    f"[hp_in{idx}]format=gray,gblur=sigma=1.2,split=2[fr{idx}][fb{idx}]",
                    f"[fb{idx}]gblur=sigma={blur_sigma}[fl{idx}]",
                    f"[fr{idx}][fl{idx}]blend=all_mode=grainextract[fhp{idx}]",
                    (
                        f"[fhp{idx}][ref{idx}]blend=all_mode=difference,"
                        r"lut='if(gt(val\,13)\,255\,0)',"
                        "erosion,dilation,dilation,dilation,"
                        "drawbox=x=0:y=ih*0.93:w=iw*0.24:h=ih*0.07:color=black:t=fill,"
                        f"gblur=sigma=2.0,format=gbrp[mask{idx}]"
                    ),
                    f"[canvas{idx}][fg{idx}][mask{idx}]maskedmerge[canvas{idx + 1}]",
                ]
            )

        filter_parts.append(
            f"[canvas{sample_count}]scale={out_width}:{out_height}:flags=lanczos,format=yuvj420p[out_final]"
        )

        cmd = [
            FFMPEG_BIN,
            "-threads",
            "2",
            "-nostdin",
            *input_args,
            "-an",
            "-sn",
            "-dn",
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[out_final]",
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "3",
            "pipe:1",
        ]
        return self._run_summary_ffmpeg(cmd, rel_path, "chrono")

    def _render_filmstrip(
        self,
        target_path: Path,
        rel_path: str,
        duration: float,
        tile_count: int,
        tile_width: int,
        tile_height: int,
    ) -> bytes | None:
        input_args: list[str] = []
        filter_parts: list[str] = []
        concat_inputs: list[str] = []

        for idx in range(tile_count):
            sample_ts = 0.0 if duration < 1.0 else duration * (idx + 0.5) / tile_count
            input_args.extend(
                [
                    "-noaccurate_seek",
                    "-skip_frame",
                    "nokey",
                    "-ss",
                    f"{sample_ts:.3f}",
                    "-i",
                    str(target_path),
                ]
            )
            filter_parts.append(
                f"[{idx}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale={tile_width}:{tile_height}[v{idx}]"
            )
            concat_inputs.append(f"[v{idx}]")

        filter_parts.append(
            f"{''.join(concat_inputs)}concat=n={tile_count}:v=1:a=0,tile={tile_count}x1:padding=0:margin=0[out]"
        )

        cmd = [
            FFMPEG_BIN,
            "-threads",
            "2",
            "-nostdin",
            *input_args,
            "-an",
            "-sn",
            "-dn",
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[out]",
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "pipe:1",
        ]
        return self._run_summary_ffmpeg(cmd, rel_path, "filmstrip")

    def _run_summary_ffmpeg(self, cmd: list[str], rel_path: str, mode: str) -> bytes | None:
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=SUMMARY_TIMEOUT,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout

            err_text = proc.stderr.decode("utf-8", errors="replace")
            logger.error(
                "FFmpeg %s summary failed for %s (exit code %d): %s",
                mode,
                rel_path,
                proc.returncode,
                err_text[-500:].strip(),
            )
            return None
        except subprocess.TimeoutExpired:
            logger.error(
                "FFmpeg %s summary timed out after %ds for %s",
                mode,
                SUMMARY_TIMEOUT,
                rel_path,
            )
            return None
        except (subprocess.SubprocessError, OSError) as exc:
            logger.error("FFmpeg %s summary process error for %s: %s", mode, rel_path, exc)
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

# Video Visual Summaries Design Spec

**Date:** 2026-10-27  
**Status:** Draft for Review

## 1. Purpose & Success Criteria

Reviewing 5–16 minute 4K HEVC NVR recordings—particularly auditing clips marked `blank` or `candidate` and spotting small nocturnal wildlife—currently requires playing through each video.

This feature adds on-demand, server-generated FFmpeg visual summaries across the application:
1. **Sidebar (`video-list.ts`):** Every video card displays a lazy-loaded `320x180` (`16:9`) **Chronophotograph** summarizing motion trajectories across the full clip in a single natural frame.
2. **Detail View (`video-detail.ts`):**
   - An **iOS Photos–style Horizontal Filmstrip Seek Bar** directly beneath the player viewport showing a seamless `10x1` frame ribbon from `0%` to `100%` of clip duration with a 60fps playhead, click-and-drag scrubbing, floating `MM:SS` scrub badge, and subtle colored detection markers.
   - A **Chronophoto Stage Toggle** in `.controls-bar` overlaying a `1280x720` Chronophotograph in exact `16:9` registration inside `.media-stack` (automatically returning to live video when scrubbing or seeking).
   - Existing cropped **Detection Snapshots** remain unchanged below metadata when detections exist.

### Constraints
- **Pure FFmpeg rendering** inside `pan-thumbnail-1` (`jellyfin-ffmpeg` 8.1); no OpenCV, NumPy, or Pillow dependencies.
- **Zero writes to `/data`:** Never write summary assets back onto the `:ro` `rclone` mount.
- **VRAM & latency isolation:** Multi-keyframe summaries (`chrono`, `filmstrip`) run on CPU (`3.6x` faster than multi-session NVDEC for single I-frame seeks and preserves scarce RTX 3090 VRAM headroom), isolated on a separate semaphore from NVDEC frame-accurate detection crops.
- **Subtract Before You Add:** Remove userland caching state and dead routes before adding new modes, delegating RAM + NVMe caching, LRU eviction, and concurrent request coalescing to Nginx `proxy_cache` + the Linux VFS page cache.

---

## 2. Subtractions (Execute First)

Before adding new capabilities, remove redundant code and dead routes:
1. **`thumbnail/server.py`:**
   - Remove `THUMBNAIL_CACHE` (`OrderedDict`), `CACHE_LOCK`, `MAX_CACHE_ENTRIES`, `get_cached_thumbnail()`, `put_cached_thumbnail()`, and `clear_thumbnail_cache()`.
   - Remove the unused `/crop` route alias (`only /thumbnail` and `/health` remain).
2. **`nginx/nginx.conf`:**
   - Remove the two unused location blocks `location = /api/thumbnail` and `location ^~ /api/thumbnail/` (zero callers in repo; all callers use `/thumbnail/`).
3. **`frontend/src/components/video-list.ts`:**
   - Remove the filler `<span>Video</span>` metadata row and move the delete `<sl-icon-button>` onto the card header row next to `.video-title`.

---

## 3. Architecture & Data Flow

```
Browser (video-list / video-detail)
   │  GET /thumbnail/?mode=chrono|filmstrip|frame...
   ▼
Nginx (pan-nginx-1)
   ├─ proxy_cache (thumbnail_cache:/var/cache/nginx/thumbnails, 2 GB max, 30d)
   ├─ Linux kernel VFS page cache (hot RAM hits without waking Python)
   └─ proxy_cache_lock on (coalesces duplicate concurrent misses)
   │  (cache MISS only)
   ▼
Stateless Thumbnail Worker (pan-thumbnail-1, server.py)
   ├─ mode=frame (default): DECODE_SEMAPHORE (4) -> NVDEC GPU -> CPU fallback
   └─ mode=chrono | filmstrip: SUMMARY_SEMAPHORE (2) -> socket alive check -> ffprobe + CPU FFmpeg
```

---

## 4. Component Specifications

### 4.1 Docker & Nginx Cache (`docker-compose.yml`, `nginx/nginx.conf`)
- Declare named volume `thumbnail_cache:` in `docker-compose.yml` (local driver on host NVMe) and mount `thumbnail_cache:/var/cache/nginx/thumbnails` in the `nginx` service.
- Configure `proxy_cache_path` at top of `nginx/nginx.conf` (inside `http` context — `conf.d/default.conf` is included inside `http {}` in `nginx:alpine`):
  ```nginx
  proxy_cache_path /var/cache/nginx/thumbnails levels=1:2 keys_zone=thumbnails:16m max_size=2g inactive=30d use_temp_path=off;
  ```
- Configure `location /thumbnail/`:
  - `proxy_cache thumbnails;`
  - `proxy_cache_key "$uri?$args";` (shared across HTTP/HTTPS and hostnames)
  - `proxy_cache_valid 200 30d;` (never cache `4xx`/`5xx` errors)
  - `proxy_cache_lock on;`, `proxy_cache_lock_age 120s;`, `proxy_cache_lock_timeout 120s;`
  - `proxy_cache_bypass $http_cache_control;` (hard-refresh bypasses cache)
  - `proxy_read_timeout 120s;` (accommodates cold `rclone` VFS fetches)
  - `add_header Cache-Control "public, max-age=86400, immutable";`
  - `add_header X-Cache-Status $upstream_cache_status always;`

### 4.2 Stateless Thumbnail Service (`thumbnail/server.py`)
All rendering goes through `GET /thumbnail` (and `HEAD /thumbnail`) discriminated by `mode`:

1. **`mode=frame` (default when `mode` is omitted):**
   - Parameters: `path` (required), `time` (float, default `0`), `bbox` (optional `x,y,w,h`), `size` (int `[32..1920]`, default `320`).
   - Concurrency: `DECODE_SEMAPHORE` (`MAX_CONCURRENT_DECODES = 4`, 5s acquire timeout -> direct CPU fallback; NVDEC failure/5s timeout -> CPU fallback).

2. **`mode=chrono`:**
   - Parameters: `path` (required), `size` (int, clamped to `[160..1920]`, default `320`).
   - Duration probing: Runs `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <target_path>` (`timeout=30s`). Returns `500` if duration cannot be parsed or `<= 0`.
   - Short-clip fallback: If `duration < 6.0` seconds, decodes a single midpoint frame (`timestamp = duration * 0.5`) scaled to `out_width x out_height` (`16:9`, `out_height = round(out_width * 9 / 16)` rounded to even) via `_decode_frame_cpu`.
   - Full Chronophotograph (`duration >= 6.0s`):
     - Samples `N = 11` uniform timestamps `t_i = duration * (i + 0.5) / 11` (`i = 0..10`), `radius = 5`.
     - Internal working resolution: `work_w = max(640, out_w)`, `work_h = max(360, out_h)` (`sigma = max(18, round(work_w * 0.028))`).
     - Multi-input fast keyframe seek: `-threads 2 -nostdin` + per-input `-noaccurate_seek -skip_frame nokey -ss <t_i> -i <target_path>` + `-an -sn -dn`.
     - Native FFmpeg `-filter_complex`:
       - Scales each input to `work_w:work_h`, `format=gbrp`, splits into `[fg_i]`, `[bg_in_i]`, `[hp_in_i]`.
       - Concatenates `[bg_in_0..10]` -> `tmedian=radius=5,setpts=PTS-STARTPTS` -> clean median background `[canvas0]` and grayscale illumination-normalized reference (`gblur=sigma=1.2` + `gblur=sigma=<sigma>` + `blend=all_mode=grainextract`).
       - For each frame `i`, computes `grainextract` high-pass, `blend=all_mode=difference` against reference, binary threshold `lut='if(gt(val\,13)\,255\,0)'`, `erosion,dilation,dilation,dilation`, masks out bottom-left OSD clock (`drawbox=x=0:y=ih*0.93:w=iw*0.24:h=ih*0.07:color=black:t=fill`), feathers with `gblur=sigma=2.0,format=gbrp`, and composites `[fg_i]` onto `[canvas_i]` via `maskedmerge`.
       - Final stage scales `[canvas11]` to `out_w:out_h:flags=lanczos,format=yuvj420p` and outputs MJPEG (`-q:v 3`, `timeout=90s`) to `pipe:1`.

3. **`mode=filmstrip`:**
   - Parameters: `path` (required), `tiles` (int `[4..20]`, default `10`), `height` (int `[36..180]`, default `72`).
   - Tile dimensions: `tile_h` (even integer), `tile_w = round(tile_h * 16 / 9)` rounded to even (`128x72` default -> `1280x72` output JPEG).
   - Samples `tiles` uniform timestamps `t_i = duration * (i + 0.5) / tiles` (for very short clips `< 1.0s`, repeats `0.0s` cleanly).
   - Multi-input fast keyframe seek on CPU (`-noaccurate_seek -skip_frame nokey -ss <t_i> -i <target_path>`), scaling each single frame to `tile_w:tile_h` and concatenating into `tile=<tiles>x1:padding=0:margin=0`, outputting MJPEG (`-q:v 4`, `timeout=90s`) to `pipe:1`.

4. **Summary Concurrency & Disconnect Aborts:**
   - `SUMMARY_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_SUMMARIES)` (default `2`). Requests call `SUMMARY_SEMAPHORE.acquire(timeout=90)` and return `503` if the queue is saturated beyond `90s`.
   - Before running `ffprobe`/`ffmpeg` *after* acquiring `SUMMARY_SEMAPHORE`, check `_is_client_disconnected()` using non-blocking `socket.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)`: if `recv` returns `b""` (EOF) or raises `ConnectionResetError`/`BrokenPipeError`, abort immediately without spawning FFmpeg (`BlockingIOError` means socket is still open and waiting for response).

### 4.3 Sidebar Card Preview (`frontend/src/components/video-list.ts`)
- Each `.video-item` renders:
  1. `.video-thumb` (`width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: var(--sl-color-neutral-200);`) containing:
     `<img loading="lazy" decoding="async" src="/thumbnail/?mode=chrono&path=${encodeURIComponent(v.path)}&size=320" alt="" />`
  2. `.video-header-row` (`display: flex; align-items: center; justify-content: space-between; gap: 4px;`): `.video-title` on the left, spinner or delete `<sl-icon-button>` on the right.
  3. Existing `.tag-container` badges below.
- If `@error` fires on the thumbnail `<img>`, hide its `.video-thumb` parent element (`parentElement.hidden = true`) so broken icons never appear.

### 4.4 Detail Scrubber & Stage Toggle (`frontend/src/components/video-detail.ts`)
- **Lit Reactive State Rule:** Declare all reactive component state (`declare showChrono: boolean;`, `declare scrubPreviewTime: number | null;`, `declare filmstripError: boolean;`, `declare chronoError: boolean;`) using `declare` in the class body, register in `static override properties`, and initialize default values inside `constructor()`.
- **Chronophoto Stage Toggle:**
  - Add a `<sl-button size="small" variant=${this.showChrono ? "primary" : "default"}>` (`Chronophoto` with `<sl-icon slot="prefix" name="layers"></sl-icon>`) in `.controls-bar` (hidden if `chronoError` is true).
  - Toggling `showChrono = true` pauses `#main-video` and renders `<img class="chrono-overlay" src="/thumbnail/?mode=chrono&path=${encodeURIComponent(currentPath)}&size=1280" />` inside `.media-stack` (`grid-area: 1 / 1; max-width: 100%; max-height: 100%; z-index: 15;`).
  - Reset `showChrono = false` (and `filmstripError = false`, `chronoError = false`) whenever `currentPath` changes, whenever `seekToTimestamp()` runs, or whenever the user scrubs the filmstrip bar.
- **Horizontal Filmstrip Seek Bar (`.filmstrip-scrubber`):**
  - Rendered directly between `.video-container` and `.controls-bar`.
  - Track container (`height: 52px` desktop, `44px` mobile `<=768px`; padded dark bar with rounded inner `6px` filmstrip track `position: relative; user-select: none; touch-action: none; cursor: ew-resize;`).
  - Displays `<img class="filmstrip-img" src="/thumbnail/?mode=filmstrip&path=${encodeURIComponent(currentPath)}" draggable="false" />` (`width: 100%; height: 100%; object-fit: fill;`). If the image is still loading or errors, the dark neutral track remains fully functional as a timeline scrubber.
  - **60fps Playhead:** `animationLoop()` reads `video.currentTime` and `duration = video.duration || vidData?.duration || 0`, updating `--playhead-pct: ${(pct * 100).toFixed(3)}%` directly on `#filmstrip-track` without triggering Lit re-renders. `.filmstrip-playhead` renders a crisp `3px` white vertical bar with subtle dark halo at `left: var(--playhead-pct, 0%)`.
  - **Pointer Scrubbing:**
    - Pure helper `computeScrubTimestamp(clientX: number, rectLeft: number, rectWidth: number, duration: number): number` clamps `ratio` to `[0, 1]` and returns `ratio * duration`.
    - `pointerdown`: captures pointer (`setPointerCapture`), records `wasPlaying = !video.paused`, pauses video, sets `showChrono = false`, seeks `video.currentTime`, updates `--playhead-pct` and `scrubPreviewTime`.
    - `pointermove`: if dragging, updates `video.currentTime`, `--playhead-pct`, and `scrubPreviewTime`; if hovering (not dragging), updates `scrubPreviewTime` and `--hover-pct` to show the `MM:SS` hover pill without seeking.
    - `pointerup` / `pointercancel`: releases capture, clears drag state, and resumes `video.play()` if `wasPlaying` was true.
    - `pointerleave`: clears `scrubPreviewTime` when not dragging.
  - **Detection Markers:** When `results?.detections` exist and `duration > 0`, deduplicate timestamps into ~`0.5%` buckets and render `2px`-wide colored tick marks along the bottom `4px` of the track (`#e91e63` animal, `#2196f3` person, `#f00` other).

---

## 5. Error Handling & Edge Cases

- **Cold `rclone` timeouts / corrupt media:** FFmpeg exits non-zero or hits `90s` timeout -> `server.py` returns `500`; Nginx does not cache `500` responses so subsequent loads retry cleanly.
- **Zero/unknown duration before metadata loads:** Scrubber disables seeking (`duration <= 0`) until either `video.duration` (`loadedmetadata`) or `vidData.duration` (`/api/videos/durations`) resolves.
- **Rapid sidebar scrolling:** Browser lazy-loading (`loading="lazy"`) limits requests to near-viewport cards; `SUMMARY_SEMAPHORE (2)` bounds CPU usage to at most 4 FFmpeg threads total; `_is_client_disconnected()` skips queued requests whose connections closed.

---

## 6. Verification Plan

1. **Python Unit Tests (`tests/test_thumbnail_service.py` + `uvx ruff@latest check --fix .`):**
   - Stateless `mode=frame` GPU decode + CPU fallback on GPU failure/timeout/busy semaphore.
   - `mode=chrono` command construction (`11` inputs, `-noaccurate_seek -skip_frame nokey`, `tmedian=radius=5`, `maskedmerge`) and `<6.0s` short-clip single-frame fallback.
   - `mode=filmstrip` command construction (`10` inputs, `tile=10x1:padding=0`).
   - Disconnected client socket skips `ffprobe`/`ffmpeg` execution.
   - Path traversal (`403`/`400`) and missing file (`404`) checks.
2. **Frontend Typecheck & Unit Tests (`deno task check` & `deno task test`):**
   - Unit tests for `computeScrubTimestamp` clamping/mapping, detection-bucket deduplication, and `VideoDetail` `showChrono` state reset on video change and seek.
3. **Live Stack Verification (`docker compose up -d`):**
   - Verify `X-Cache-Status: MISS` followed by `<5ms` `X-Cache-Status: HIT` across `mode=frame`, `mode=chrono`, and `mode=filmstrip` through `https://vishnu.local:8443/thumbnail/...`, surviving `docker compose restart thumbnail nginx`.

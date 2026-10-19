# Pan NVR

A modern, high-throughput, AI-powered Network Video Recorder (NVR) interface and batch processing pipeline designed for wildlife monitoring, video archive triage, and automated animal detection.

Pan combines an interactive, hardware-monitored web dashboard with a high-performance **Multi-Pass Breadth-First Search (BFS) Video Screening Funnel** powered by **NVIDIA DALI NVDEC** and a pure-GPU **MegaDetector v5** pipeline on NVIDIA RTX GPUs.

---

## Table of Contents

- [Features](#features)
- [Architecture & Screening Funnel](#architecture--screening-funnel)
  - [Phase 1: Multi-Pass BFS Screening Funnel](#phase-1-multi-pass-bfs-screening-funnel)
  - [Phase 2: Post-Screening Annotation Pass](#phase-2-post-screening-annotation-pass)
  - [State Transitions & Sidecar Schema](#state-transitions--sidecar-schema)
- [Hardware & Performance Acceleration](#hardware--performance-acceleration)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Running the Web Application](#running-the-web-application)
- [Batch Processing CLI (`batch_detect.py`)](#batch-processing-cli-batch_detectpy)
  - [Running in Docker (Recommended)](#running-in-docker-recommended)
  - [Common CLI Workflows](#common-cli-workflows)
  - [CLI Reference](#cli-reference)
- [Sidecar Migration (`migrate_sidecars_to_megadetector.py`)](#sidecar-migration-migrate_sidecars_to_megadetectorpy)
- [Storage & SMB Optimization](#storage--smb-optimization)
- [Testing](#testing)

---

## Features

- **Multi-Pass BFS Screening Funnel**: Rapidly triages massive backlogs of 4K video clips over remote SMB/TrueNAS storage, certifying blank clips with zero false negatives while skipping up to 90%+ of redundant frame decodes.
- **Pure-GPU MegaDetector v5**: Direct PyTorch/TorchVision implementation of MegaDetector (`MDv1000-redwood` / YOLOv5x6) utilizing hardware NVDEC decoding via NVIDIA DALI. Decoded frames remain entirely in GPU VRAM (zero CPU-GPU PCIe copy bottlenecks).
- **Dynamic VRAM Batch Sizing**: Real-time GPU memory monitoring dynamically scales frame inference batches between 16, 32, and 64 frames depending on available VRAM.
- **Standard MegaDetector JSON Schema**: Output sidecars (`<video>.mp4.json`) match the universal MegaDetector v1.6 schema (compatible with EcoAssist and official MegaDetector tooling), augmented with non-destructive `info.screening` state tracking.
- **Infinite Scroll Feed**: Seamlessly browse through thousands of video clips with a high-performance virtualized grid.
- **Smart Filtering & Tree Navigation**: Filter by date range, object category (Animal, Person, Vehicle), directory, or camera source.
- **Real-time GPU Monitoring**: Track NVIDIA GPU utilization, VRAM allocation, and temperature directly from the dashboard.
- **Modern Responsive UI**: Built with Lit, Shoelace components, Vite, and a custom dark-mode design system.

---

## Architecture & Screening Funnel

When processing large backlogs of security and wildlife camera footage, the vast majority of clips are completely empty ("blank"). Rather than decoding every single frame of every video at full framerate sequentially, Pan uses a **Global Breadth-First Search (BFS) Screening Funnel** divided into two phases:

```
[ Unprocessed Backlog (~2,500+ videos) ]
                  │
                  ▼
┌────────────────────────────────────────────────────────┐
│  Pass 1: Rapid Triage (Stride 24 / ~1.04 FPS)          │
│  - Evaluates every 24th frame with early-exit on hits  │
└────────────────────────────────────────────────────────┘
         │                                       │
      (Hits)                                 (0 Detections)
         ▼                                       ▼
 [ Tagged 'detected' ]           ┌───────────────────────────────────────────────┐
 (Set aside for Phase 2)         │ Pass 2: Verification (Stride 4 / ~6.25 FPS)   │
                                 │ - Skips frames k % 24 == 0 (16.7% compute cut)│
                                 │ - Evaluates Pass 1 blanks only                │
                                 └───────────────────────────────────────────────┘
                                          │                               │
                                       (Hits)                         (0 Hits)
                                          ▼                               ▼
                                  [ Tagged 'detected' ]   ┌───────────────────────────────┐
                                  (Set aside for Phase 2) │ Pass 3: Zero-Tolerance       │
                                                          │ Certification (Stride 1 / 25F)│
                                                          │ - Skips frames k % 4 == 0     │
                                                          │ - Evaluates Pass 2 blanks only│
                                                          └───────────────────────────────┘
                                                                          │
                                                                       (0 Hits)
                                                                          ▼
                                                                [ Certified Blank ]
                                                                (Safe to archive/delete)
                  │
                  ▼
┌────────────────────────────────────────────────────────┐
│  Phase 2: Post-Screening Annotation Pass (Stride 4)    │
│  - Runs on all 'detected' videos (early_exit = False)  │
│  - Backfills missing frame ranges across full duration │
│  - Builds complete multi-object timeline detections    │
└────────────────────────────────────────────────────────┘
                  │
                  ▼
          [ Tagged 'annotated' ]
```

### Phase 1: Multi-Pass BFS Screening Funnel

1. **Pass 1 (Stride 24 / ~1.04 FPS — Rapid Triage)**:
   - Evaluates every 24th frame with `early_exit=True`.
   - On the first detection exceeding confidence threshold ($\ge 0.2$), decoding halts immediately, and the clip is tagged `detected` (partial).
   - Clips reaching EOF with 0 detections are tagged `blank` (`strides_completed: [24]`) and queued for Pass 2.
2. **Pass 2 (Stride 4 / ~6.25 FPS — Verification)**:
   - Evaluates only Pass 1 blanks.
   - Uses an in-VRAM boolean mask to skip frames already evaluated during Pass 1 ($k \pmod{24} == 0$), delivering a **16.7% compute savings**.
   - Any newly detected clip halts and transitions to `detected`; clips with 0 detections advance to Pass 3 (`strides_completed: [24, 4]`).
3. **Pass 3 (Stride 1 / ~25.0 FPS — Zero-Tolerance Certification)**:
   - Evaluates only Pass 2 blanks at 100% temporal density (every frame).
   - Skips frames already evaluated in Pass 2 ($k \pmod 4 == 0$), delivering an immediate **25% compute savings**.
   - Clips with 0 detections at EOF receive **Certified Blank** status (`strides_completed: [24, 4, 1]`).

### Phase 2: Post-Screening Annotation Pass

- Runs across all videos marked `detected` with `early_exit=False`.
- Uses `evaluated_ranges` stored in the sidecar to backfill only unevaluated intervals at the target annotation stride (default: stride 4 / ~6.25 FPS).
- Resolves multiple concurrent objects per frame (e.g., humans, grazing deer, nocturnal wildlife) and records their continuous bounding boxes.
- Upon completion, the sidecar is tagged `status: "annotated"`, `partial: false`.

### State Transitions & Sidecar Schema

Screening state is tracked non-destructively under the `info.screening` block in each video's sidecar JSON (`<video_filename>.mp4.json`):

```json
{
  "info": {
    "detection_completion_time": "2026-10-19 15:10:40",
    "format_version": "1.6",
    "screening": {
      "status": "detected",
      "strides_completed": [24],
      "max_stride_evaluated": 24,
      "early_exit": true,
      "early_exit_frame": 1512,
      "evaluated_ranges": [
        {"stride": 24, "start": 0, "end": 1512}
      ]
    }
  },
  "detection_categories": {
    "1": "animal",
    "2": "person",
    "3": "vehicle"
  },
  "images": [
    {
      "file": "Backyard_00_20250831070722.mp4",
      "width": 3840,
      "height": 2160,
      "total_frames": 9000,
      "fps": 25.0,
      "partial": true,
      "detections": [
        {
          "category": "1",
          "conf": 0.9619,
          "bbox": [0.57798, 0.35929, 0.10732, 0.17795],
          "frame_number": 216,
          "timestamp": 8.623
        }
      ]
    }
  ]
}
```

---

## Hardware & Performance Acceleration

- **NVIDIA DALI NVDEC**: Video decoding is performed in hardware on NVIDIA GPU video decoder chips using the `nvidia.dali.fn.readers.video` operator. Frames are decoded directly into CUDA memory, bypassing CPU RAM and host-to-device PCIe bandwidth limits.
- **Pure TorchVision Model**: Replaces external detection wrappers with direct TorchVision letterbox transformations and `torchvision.ops.nms` running in FP16 half-precision on Tensor Cores.
- **VFS Background Pre-Warmer**: A dedicated daemon thread reads ahead on the next video in the queue, priming the rclone VFS cache chunk ring buffer so NVDEC decodes from local disk cache rather than waiting on network latency.
- **Dynamic VRAM Batch Sizing**: Batch sizes dynamically adapt to free VRAM:
  - $\ge 15.0\text{ GB free}$: Batch size 64 (~29.8 FPS peak throughput)
  - $9.0 - 15.0\text{ GB free}$: Batch size 32
  - $5.0 - 9.0\text{ GB free}$: Batch size 16
  - $< 5.0\text{ GB free}$: Batch size 8

---

## Getting Started

### Prerequisites

- **NVIDIA GPU** with Pascal architecture or newer (RTX 30-series / 40-series recommended).
- **NVIDIA Container Toolkit** installed on the Docker host (`nvidia-smi` available inside containers).
- **Docker & Docker Compose** (or Docker Desktop with WSL2 on Windows).

### Running the Web Application

1. **Clone repository and configure environment**:
   ```bash
   git clone <repo-url>
   cd pan
   cp .env.example .env # Configure TRUENAS / storage credentials
   ```

2. **Start Services**:
   ```bash
   docker compose up -d
   ```

3. **Access Dashboard**: Open [http://localhost:5173](http://localhost:5173).

---

## Batch Processing CLI (`batch_detect.py`)

The batch processing script (`scripts/batch_detect.py`) drives the entire multi-pass screening funnel and annotation pipeline across video libraries.

### Running in Docker (Recommended)

Running inside the Docker worker container ensures exact PyTorch, CUDA, and DALI driver compatibility:

```bash
# Run full automated multi-pass BFS screening funnel + annotation
docker compose run --rm worker python /app/scripts/batch_detect.py --batch-size auto /data/NVR-unprocessed
```

### Common CLI Workflows

#### 1. Full Multi-Pass Funnel (Default)
Runs Pass 1 (stride 24 triage), Pass 2 (stride 4 verification), Pass 3 (stride 1 certification), followed by the Phase 2 annotation backfill:
```bash
docker compose run --rm worker python /app/scripts/batch_detect.py /data/NVR-unprocessed
```

#### 2. Screening Only (Skip Annotation Backfill)
Rapidly certify blanks and tag detected clips without running the full temporal annotation pass:
```bash
docker compose run --rm worker python /app/scripts/batch_detect.py --skip-annotation /data/NVR-unprocessed
```

#### 3. Run a Specific Stage
Target only a specific pass in the screening funnel:
```bash
# Run Pass 1 triage only
docker compose run --rm worker python /app/scripts/batch_detect.py --stage 1 /data/NVR-unprocessed

# Run Pass 2 on Pass 1 blanks only
docker compose run --rm worker python /app/scripts/batch_detect.py --stage 2 /data/NVR-unprocessed

# Run Phase 2 annotation backfill on detected videos
docker compose run --rm worker python /app/scripts/batch_detect.py --stage annotate /data/NVR-unprocessed
```

#### 4. Dry Run Queue Inspection
Inspect candidate counts across all passes and queues without executing inference:
```bash
docker compose run --rm worker python /app/scripts/batch_detect.py --dry-run /data/NVR-unprocessed
```

#### 5. Automatic Separation of Blanks
Automatically move certified blank videos and their sidecars to a separate directory:
```bash
docker compose run --rm worker python /app/scripts/batch_detect.py \
  --move-blank-to /data/NVR-blank \
  --move-detected-to /data/NVR-detected \
  /data/NVR-unprocessed
```

### CLI Reference

| Flag | Default | Description |
| :--- | :--- | :--- |
| `paths` | `[]` | One or more video files or directory paths to process. |
| `--stage` | `auto` | Pipeline stage: `auto` (full BFS funnel), `1`, `2`, `3`, `annotate`, or `legacy`. |
| `--strides` | `24,4,1` | Comma-separated strides for multi-pass screening passes. |
| `--annotate-stride` | `4` | Target frame stride for post-screening annotation backfill pass. |
| `--skip-annotation` | `False` | Run only screening passes; skip the post-screening annotation pass. |
| `--early-exit` / `--no-early-exit` | `True` | Terminate video evaluation immediately upon first positive detection. |
| `--batch-size` | `auto` | Frame batch size (integer or `auto` for dynamic VRAM tuning). |
| `--conf` | `0.2` | Minimum detection confidence threshold. |
| `--model` | `MDv1000-redwood` | MegaDetector model weights (`MDv1000-redwood`, `MDV5A`, etc.). |
| `--target-size` | `1280` | Image dimension to letterbox frames to before inference. |
| `--skip-existing` / `--no-skip-existing` | `True` | Skip videos that have already completed screening or annotation. |
| `-f`, `--force` | `False` | Force re-evaluation of all videos, ignoring existing sidecars. |
| `--move-blank-to` | `""` | Directory to automatically move certified blank videos and sidecars to. |
| `--move-detected-to` | `""` | Directory to automatically move annotated videos and sidecars to. |
| `--dry-run` | `False` | Preview pass candidate counts and queues without running inference. |

---

## Sidecar Migration (`migrate_sidecars_to_megadetector.py`)

If you have legacy sidecar JSON files generated by earlier Pan versions (`[x1, y1, x2, y2]` absolute coordinates or flat detection arrays), use the migration script to safely convert them to standard MegaDetector v1.6 format with `info.screening` state:

```bash
# Dry-run migration check
uv run scripts/migrate_sidecars_to_megadetector.py --dry-run /data/NVR-unprocessed

# Execute migration in-place with backup
uv run scripts/migrate_sidecars_to_megadetector.py --backup /data/NVR-unprocessed
```

---

## Storage & SMB Optimization

For remote network mounts (e.g., TrueNAS over SMB via Rclone Docker plugin), Pan incorporates low-overhead filesystem strategies:
- **Single-Roundtrip Directory Scanning**: Uses `os.scandir` to extract file existence, sidecar presence, and `file_size` in a single directory stream, avoiding thousands of roundtrip `stat()` calls over the network.
- **Stat-Free Sidecar Ingestion**: Sidecars are directly read with a single `open()` request, catching missing or empty files cleanly without preceding `stat()` or `exists()` checks.
- **Empty File Guard**: 0-byte or corrupted video files are detected from cached file sizes and skipped instantly, preventing C++ assertion aborts from DALI.
- **Rclone VFS Caching**: Configured with `vfs-cache-mode: full`, `vfs-cache-max-size: 50G`, and `dir-cache-time: 2h` for local SSD read buffering.

---

## Testing

Pan includes both frontend UI and backend Python verification suites:

```bash
# Run backend Python tests (screening state, queue logic, empty file skip)
.venv/bin/python -m unittest discover -s tests

# Run Playwright and Vitest UI tests in Docker
docker compose run --rm test npm test
```

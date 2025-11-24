# Pan NVR

A Deno + Lit + Python/MegaDetector NVR application for browsing and analyzing wildlife camera trap videos.

## Architecture

*   **Frontend**: Lit Element + Shoelace + Signals. 3-column layout for filtering, browsing, and viewing.
*   **Backend**: Deno. Serves the frontend, streams video files, and proxies requests to the worker.
*   **Worker**: Python (Flask + PyTorch + YOLOv5). Runs MegaDetector v5 to identify animals, people, and vehicles in videos.

## Setup & Running

1.  **Prerequisites**: Docker and Docker Compose.
2.  **Start the App**:
    ```bash
    docker-compose up --build
    ```
3.  **Access**: Open `http://localhost:8000` in your browser.

## Data

*   Place your video files (`.mp4`, `.avi`, etc.) in the `./data` directory.
*   The application tracks processed videos by creating a companion `.json` file (e.g., `video.mp4.json`) containing detection results.
*   To override the data directory, update the `volumes` section in `docker-compose.yml` or mount a different host path to `/data`.

## Features

*   **Rapid Playback**: Default 5x playback speed for quick review.
*   **AI Detection**: Integrated MegaDetector v5 to scan videos.
*   **Visualization**: Bounding boxes are overlaid on the video during playback.
*   **Responsive UI**: Filter by status, view metadata, and manage files.

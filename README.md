# Pan NVR

A modern, AI-powered Network Video Recorder (NVR) interface designed for
wildlife monitoring and efficient video management.

## Features

- **Infinite Scroll Feed**: Seamlessly browse through thousands of video clips
  with a high-performance virtualized list.
- **AI Object Detection**: Integrated YOLOv5 worker automatically detects and
  classifies objects (Animals, Persons, Vehicles).
- **Smart Filtering**: Filter videos by:
  - Date Range
  - Object Class (e.g., "Show only animals")
  - Directory/Camera source
- **Directory Tree**: Navigate your video archive using a familiar file tree
  structure.
- **Real-time GPU Monitoring**: Track NVIDIA GPU usage, memory, and temperature
  directly from the dashboard.
- **Responsive Design**: Fully optimized for desktop and mobile usage.
- **Modern UI**: Built with Lit, Shoelace, and a custom dark-mode design system.

## Technology Stack

- **Frontend**: Vite, Lit, Shoelace, TypeScript.
- **Backend**: Deno (`oak` framework).
- **AI Worker**: Python 3.9, PyTorch, Ultralytics YOLOv5.
- **Infrastructure**: Docker Compose (GPU support requires NVIDIA Container
  Toolkit).

## Getting Started

### Prerequisites

- Docker & Docker Compose
- NVIDIA GPU + NVIDIA Container Toolkit (for AI processing)

### Running the Application

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd pan
   ```

2. **Configure Data Directory**: Update `docker-compose.yml` volumes to point to
   your video storage:
   ```yaml
   volumes:
     - /path/to/your/videos:/data
   ```

3. **Start Services**:
   ```bash
   docker compose up -d
   ```

4. **Access the App**: Open [http://localhost:5173](http://localhost:5173) in
   your browser.

## Testing

The project includes specific testing infrastructure using Playwright and Vitest
running in Docker.

```bash
# Run all tests
docker compose exec tests npm test
```

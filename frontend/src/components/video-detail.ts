import { css, html, LitElement } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import Hls from "hls.js";
import { State } from "../state.ts";
import type { Detection } from "../types.ts";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/range/range.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import "@shoelace-style/shoelace/dist/components/progress-bar/progress-bar.js";

function formatDuration(seconds?: number) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h > 0 ? `${h}h ` : "") + `${m}m ${s}s`;
}

export class VideoDetail extends SignalWatcher(LitElement) {
  state!: State;
  animReq: number | undefined;

  lastVideoPath: string | null = null;
  private hls: Hls | null = null;

  static override properties = {
    state: { attribute: false },
  };

  static override styles = [css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      background: var(--sl-color-neutral-200);
      position: relative;
      overflow-y: auto;
    }
    .video-container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-grow: 1;
      min-height: 300px;
      background: #000;
      overflow: hidden;
    }
    /* Grid wrapper ensures canvas patches video element exactly */
    .media-stack {
      display: grid;
      place-items: center;
      max-width: 100%;
      max-height: 100%;
      position: relative;
    }
    .media-stack > * {
      grid-area: 1 / 1;
    }
    video {
      max-width: 100%;
      max-height: 100%;
      display: block;
      /* Ensure the element shrinks to fit content aspect ratio */
      width: auto;
      height: auto;
    }
    #overlay-canvas {
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10;
    }
    .controls-bar {
      /* ... existing styles */
      background: var(--sl-color-neutral-0);
      padding: var(--sl-spacing-medium);
      border-top: 1px solid var(--sl-color-neutral-200);
      display: flex;
      gap: var(--sl-spacing-medium);
      align-items: center;
    }
    .speed-label {
      font-size: 0.9rem;
      min-width: 60px;
    }
    .speed-slider {
      width: 200px;
    }
    .spacer {
      flex: 1;
    }
    .info-panel {
      padding: var(--sl-spacing-medium);
      background: var(--sl-color-neutral-0);
      border-bottom: 1px solid var(--sl-color-neutral-200);
    }
    .empty-state {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
    }
    .thumbnail-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: var(--sl-spacing-small);
      margin-top: var(--sl-spacing-medium);
    }
    .thumbnail-item {
      position: relative;
      cursor: pointer;
      border: 2px solid var(--sl-color-neutral-200);
      border-radius: 4px;
      overflow: hidden;
      aspect-ratio: 16/9;
      transition: border-color 0.2s, transform 0.2s;
    }
    .thumbnail-item:hover {
      border-color: var(--sl-color-primary-600);
      transform: scale(1.05);
    }
    .thumbnail-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .thumbnail-label {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 2px 4px;
      font-size: 0.7rem;
      text-align: center;
    }

    /* Mobile responsive */
    @media (max-width: 768px) {
      .video-container {
        min-height: 200px;
      }
      .controls-bar {
        flex-wrap: wrap;
        padding: var(--sl-spacing-small);
        gap: var(--sl-spacing-small);
      }
      .speed-slider {
        width: 120px;
      }
      .speed-label {
        min-width: 45px;
        font-size: 0.8rem;
      }
      .spacer {
        flex-basis: 100%;
        height: 0;
      }
      .controls-bar sl-button {
        font-size: 0.75rem;
      }
      .info-panel {
        padding: var(--sl-spacing-small);
      }
      .info-panel h3 {
        font-size: 0.9rem;
        margin: 0.5em 0;
      }
      .info-panel p {
        font-size: 0.8rem;
        margin: 0.3em 0;
      }
      .thumbnail-gallery {
        grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
      }
    }
  `];

  override connectedCallback() {
    super.connectedCallback();
    this.animationLoop();
  }

  animationLoop() {
    this.drawOverlays();
    this.animReq = requestAnimationFrame(() => this.animationLoop());
  }

  drawOverlays() {
    const video = this.shadowRoot?.querySelector("video") as HTMLVideoElement;
    const canvas = this.shadowRoot?.querySelector(
      "#overlay-canvas",
    ) as HTMLCanvasElement;
    if (!video || !canvas) return;

    const results = this.state.currentResults.get();
    if (!results) {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const ctx = canvas.getContext("2d")!;

    // Match canvas size to video display size
    if (
      canvas.width !== video.clientWidth || canvas.height !== video.clientHeight
    ) {
      canvas.width = video.clientWidth;
      canvas.height = video.clientHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentTime = video.currentTime;
    // Find detections close to current time
    // Note: Using a wider threshold or finding exact frame match would be better, but this matches original logic
    const threshold = 0.1;

    const detections = results.detections || [];
    const currentDetections = detections.filter((d) =>
      Math.abs(d.timestamp - currentTime) < threshold
    );

    currentDetections.forEach((d) => {
      const [x, y, w, h] = d.bbox; // MegaDetector [x, y, w, h] normalized

      const rx = x * canvas.width;
      const ry = y * canvas.height;
      const rw = w * canvas.width;
      const rh = h * canvas.height;

      // Draw Box
      ctx.strokeStyle = "#f00";
      if (d.category === "animal") ctx.strokeStyle = "#e91e63"; // Pink for animal
      if (d.category === "person") ctx.strokeStyle = "#2196f3"; // Blue

      ctx.lineWidth = 3;
      ctx.strokeRect(rx, ry, rw, rh);

      // Draw Label
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "14px sans-serif";
      ctx.fillText(`${d.category} ${(d.conf * 100).toFixed(0)}%`, rx, ry - 5);
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.animReq) {
      cancelAnimationFrame(this.animReq);
      this.animReq = undefined;
    }
  }

  private setupVideo(video: HTMLVideoElement, path: string) {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    const m3u8Url = `/videos/${path}.m3u8`;
    const mp4Url = `/videos/${path}`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
      });
      hls.loadSource(m3u8Url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn(
            "HLS fatal error, falling back to direct MP4 source:",
            data.details,
            "Error:", data.error?.message || data.error,
          );
          hls.destroy();
          this.hls = null;
          video.src = mp4Url;
        }
      });
      this.hls = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari on iOS where MSE is not supported)
      video.src = m3u8Url;
    } else {
      video.src = mp4Url;
    }
  }

  override updated() {
    const currentPath = this.state?.currentVideoPath.get();
    if (!currentPath) {
      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      this.lastVideoPath = null;
      return;
    }

    if (currentPath !== this.lastVideoPath) {
      this.lastVideoPath = currentPath;
      const gallery = this.shadowRoot?.querySelector("#thumbnail-gallery");
      if (gallery) gallery.innerHTML = "";

      const video = this.shadowRoot?.querySelector("#main-video") as HTMLVideoElement;
      if (video) {
        this.setupVideo(video, currentPath);
      }
    }
  }

  override render() {
    if (!this.state) {
      return html`

      `;
    }
    const currentPath = this.state.currentVideoPath.get();

    if (!currentPath) {
      return html`
        <div class="empty-state">
          <p>Select a video to view</p>
        </div>
      `;
    }

    const vidData = this.state.videos.get().find((v) => v.path === currentPath);
    const isProcessed = vidData && vidData.processed;

    const results = this.state.currentResults.get();
    const playbackSpeed = this.state.playbackSpeed.get();

    const job = this.state.processingJob.get();
    const isProcessingCurrent = job && job.path === currentPath;
    const processingStatus = isProcessingCurrent ? job.status : null;
    const processingProgress = isProcessingCurrent ? job.progress : 0;

    return html`
      <div class="video-container">
        <div class="media-stack">
            <video
              id="main-video"
              controls
              autoplay
              muted
              loop
              preload="metadata"
              crossorigin="anonymous"
              @loadedmetadata="${this.onVideoLoad}"
            >
            </video>
            <canvas id="overlay-canvas"></canvas>
        </div>
      </div>

      <div class="controls-bar">
        <sl-icon name="speedometer"></sl-icon>
        <span class="speed-label">${playbackSpeed}x</span>
        <sl-range
          class="speed-slider"
          min="0.5"
          max="18"
          step="0.5"
          .value="${playbackSpeed}"
          @sl-change="${(e: Event) =>
            this.setSpeed((e.target as HTMLInputElement).value)}"
        ></sl-range>

        <div class="spacer"></div>

        ${!isProcessed
          ? html`
            <sl-button
              id="process-btn"
              variant="primary"
              ?disabled="${isProcessingCurrent || this.state.processingQueue.get().includes(currentPath)}"
              ?loading="${!!processingStatus}"
              @click="${() => this.state.processVideo(currentPath)}"
            >
              <sl-icon slot="prefix" name="cpu"></sl-icon>
              ${this.state.processingQueue.get().includes(currentPath) ? "Queued" : "Process with AI"}
            </sl-button>
          `
          : html`
            <sl-button
                ?disabled="${isProcessingCurrent || this.state.processingQueue.get().includes(currentPath)}"
                ?loading="${!!processingStatus}"
                @click="${() => this.state.processVideo(currentPath)}"
            >
                ${this.state.processingQueue.get().includes(currentPath) ? "Queued" : "Re-process"}
            </sl-button>
          `}

        <sl-button variant="warning" outline @click="${() =>
          this.state.moveVideo(currentPath)}">
          <sl-icon slot="prefix" name="cloud-upload"></sl-icon>
          Move to Upload
        </sl-button>

        <sl-button variant="danger" outline @click="${() =>
          this.state.deleteVideo(currentPath)}">
          <sl-icon slot="prefix" name="trash"></sl-icon>
          Delete
        </sl-button>
      </div>

      ${processingStatus
        ? html`
          <div
            style="padding: 10px; background: var(--sl-color-neutral-0); border-bottom: 1px solid var(--sl-color-neutral-200);"
          >
            <div
              style="display:flex; justify-content:space-between; margin-bottom: 5px; font-size: 0.8rem;"
            >
              <span>${processingStatus}</span>
              <span>${(processingProgress * 100).toFixed(0)}%</span>
            </div>
            <sl-progress-bar value="${processingProgress *
              100}"></sl-progress-bar>
          </div>
        `
        : ""}

      <div class="info-panel">
        <div style="margin-bottom: var(--sl-spacing-medium); display: flex; gap: 6px; flex-wrap: wrap;">
          ${(() => {
            const state = vidData?.state || (isProcessed ? (vidData?.classifications?.length ? "annotated" : "blank") : "unprocessed");
            switch (state) {
              case "candidate":
                return html`
                  <sl-tag variant="primary">Candidate</sl-tag>
                  ${vidData?.stride ? html`<sl-tag variant="neutral">Stride ${vidData.stride}</sl-tag>` : ""}
                `;
              case "detected":
                return html`<sl-tag variant="warning">Detected</sl-tag>`;
              case "annotated":
                return html`<sl-tag variant="success">Annotated</sl-tag>`;
              case "blank":
                return html`<sl-tag variant="neutral">Blank</sl-tag>`;
              case "unprocessed":
              default:
                return html`<sl-tag variant="neutral">Unprocessed</sl-tag>`;
            }
          })()}
        </div>
        <h3>Metadata</h3>
        <p><strong>File:</strong> ${currentPath}</p>
        ${vidData?.duration
          ? html`
            <p><strong>Duration:</strong> ${formatDuration(
              vidData.duration,
            )}</p>
          `
          : ""} ${results
          ? html`
            <p><strong>Detections:</strong> ${results.detections.length}</p>
            <p><strong>Resolution:</strong> ${results.metadata.width}x${results
              .metadata.height}</p>
            ${results.info?.screening ? html`
              <p><strong>Screening Status:</strong> ${results.info.screening.status || "N/A"}</p>
              ${results.info.screening.strides_completed ? html`
                <p><strong>Strides Completed:</strong> ${results.info.screening.strides_completed.join(", ")}</p>
              ` : ""}
              ${results.info.screening.early_exit ? html`
                <p><strong>Early Exit:</strong> Frame ${results.info.screening.early_exit_frame ?? "N/A"}</p>
              ` : ""}
            ` : ""}

            ${results.detections.length > 0
              ? html`
                <h3 style="margin-top: var(--sl-spacing-medium);">
                  Detection Snapshots (${Math.min(results.detections.length, 30)}${results.detections.length > 30 ? ` of ${results.detections.length}` : ""})
                </h3>
                <div class="thumbnail-gallery" id="thumbnail-gallery">
                  ${results.detections.slice(0, 30).map((det) => {
                    const [x, y, w, h] = det.bbox;
                    const currentVideo = this.state.currentVideoPath.get() || "";
                    const thumbUrl = `/thumbnail/?path=${encodeURIComponent(currentVideo)}&time=${det.timestamp}&bbox=${x},${y},${w},${h}&size=320`;
                    return html`
                      <div class="thumbnail-item" @click="${() => this.seekToTimestamp(det.timestamp)}" title="Jump to ${det.timestamp.toFixed(1)}s">
                        <img loading="lazy" src="${thumbUrl}" alt="${det.category} detection" />
                        <div class="thumbnail-label">
                          ${det.category} ${(det.conf * 100).toFixed(0)}% @ ${det.timestamp.toFixed(1)}s
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
              : ""}
          `
          : ""}
      </div>
    `;
  }

  seekToTimestamp(timestamp: number) {
    const mainVideo = this.shadowRoot?.querySelector("#main-video") as HTMLVideoElement;
    if (mainVideo) {
      mainVideo.currentTime = timestamp;
      mainVideo.scrollIntoView({ behavior: "smooth", block: "center" });
      mainVideo.play();
    }
  }

  onVideoLoad(e: Event) {
    const video = e.target as HTMLVideoElement;
    video.playbackRate = this.state.playbackSpeed.get();
  }

  setSpeed(speed: string) {
    this.state.setPlaybackSpeed(parseFloat(speed));
    const video = this.shadowRoot?.querySelector(
      "#main-video",
    ) as HTMLVideoElement;
    if (video) video.playbackRate = parseFloat(speed);
  }
}
customElements.define("video-detail", VideoDetail);

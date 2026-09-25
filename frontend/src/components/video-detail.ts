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
      const [x1, y1, x2, y2] = d.bbox; // normalized

      const rx = x1 * canvas.width;
      const ry = y1 * canvas.height;
      const rw = (x2 - x1) * canvas.width;
      const rh = (y2 - y1) * canvas.height;

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

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari / iOS)
      video.src = m3u8Url;
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
      });
      hls.loadSource(m3u8Url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn("HLS fatal error, falling back to direct MP4 source", data);
          hls.destroy();
          this.hls = null;
          video.src = mp4Url;
        }
      });
      this.hls = hls;
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
        ${isProcessed
          ? html`
            <div style="margin-bottom: var(--sl-spacing-medium);">
              <sl-tag type="success">Processed</sl-tag>
            </div>
          `
          : ""}
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

            ${results.detections.length > 0
              ? html`
                <h3 style="margin-top: var(--sl-spacing-medium);">Detection Snapshots</h3>
                <sl-button size="small" @click="${() =>
                  this.generateThumbnails()}">Generate Thumbnails</sl-button>
                <div class="thumbnail-gallery" id="thumbnail-gallery"></div>
              `
              : ""}
          `
          : ""}
      </div>
    `;
  }

  async generateThumbnails() {
    const results = this.state.currentResults.get();
    const video = this.shadowRoot?.querySelector("#main-video") as HTMLVideoElement;
    const gallery = this.shadowRoot?.querySelector("#thumbnail-gallery") as HTMLElement;

    if (!results || !video || !gallery) return;

    gallery.innerHTML = '<p style="text-align:center; padding:10px;">Generating thumbnails...</p>';

    // Get unique detections (limit to first 20 for performance)
    const uniqueDetections = results.detections.slice(0, 20);
    const thumbnails: { url: string; det: Detection }[] = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    // Use a separate, hidden video element for thumbnail generation so playback is uninterrupted
    const tempVideo = document.createElement("video");
    tempVideo.crossOrigin = "anonymous";
    tempVideo.muted = true;
    tempVideo.playsInline = true;
    tempVideo.preload = "auto";

    let tempHls: Hls | null = null;
    const currentVideo = this.state.currentVideoPath.get();
    const m3u8Url = `/videos/${currentVideo}.m3u8`;
    const mp4Url = `/videos/${currentVideo}`;

    if (tempVideo.canPlayType("application/vnd.apple.mpegurl")) {
      tempVideo.src = m3u8Url;
    } else if (Hls.isSupported()) {
      tempHls = new Hls({
        maxBufferLength: 10,
        enableWorker: true,
      });
      tempHls.loadSource(m3u8Url);
      tempHls.attachMedia(tempVideo);
      tempHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn("HLS error in thumbnail generator, falling back to direct MP4", data);
          tempHls?.destroy();
          tempHls = null;
          tempVideo.src = mp4Url;
        }
      });
    } else {
      tempVideo.src = mp4Url;
    }

    // Attach to DOM but hide it to ensure browser prioritizes loading
    tempVideo.style.position = "absolute";
    tempVideo.style.visibility = "hidden";
    tempVideo.style.pointerEvents = "none";
    tempVideo.style.zIndex = "-1";
    this.shadowRoot?.appendChild(tempVideo);

    // Helper to cleanup
    const cleanup = () => {
      if (tempHls) {
        tempHls.destroy();
        tempHls = null;
      }
      tempVideo.pause();
      tempVideo.src = "";
      tempVideo.remove();
    };

    const errors: string[] = [];
    try {
        // Wait for metadata to load so we can seek
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timeout loading video metadata")), 15000);
            tempVideo.onloadedmetadata = () => {
                clearTimeout(timeout);
                resolve();
            };
            tempVideo.onerror = () => {
                 clearTimeout(timeout);
                 reject(new Error("Failed to load video for processing"));
            };
        });

        // We don't need to play the video, just seek
        for (const det of uniqueDetections) {
            try {
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error("Seek timeout")), 5000);

                    const onSeeked = () => {
                        clearTimeout(timeout);
                        resolve();
                    };

                    // Handle seek errors
                    const onError = () => {
                         clearTimeout(timeout);
                         reject(new Error("Video error during seek"));
                    };

                    tempVideo.addEventListener("seeked", onSeeked, { once: true });
                    tempVideo.addEventListener("error", onError, { once: true });
                    tempVideo.currentTime = det.timestamp;
                });

                // Calculate crop
                const [x1, y1, x2, y2] = det.bbox;
                const vw = tempVideo.videoWidth;
                const vh = tempVideo.videoHeight;

                // Check for absolute vs normalized coordinates
                // If coordinates are > 1.1, assume they are absolute pixels
                const isAbsolute = x1 > 1.1 || y1 > 1.1 || x2 > 1.1 || y2 > 1.1;

                let sx, sy, sw, sh;

                if (isAbsolute) {
                    // console.warn(`Detected absolute coordinates for frame ${det.frame}:`, det.bbox);
                    sx = x1;
                    sy = y1;
                    sw = x2 - x1;
                    sh = y2 - y1;
                } else {
                    sx = x1 * vw;
                    sy = y1 * vh;
                    sw = (x2 - x1) * vw;
                    sh = (y2 - y1) * vh;
                }

                // Integer pixels
                sx = Math.floor(sx);
                sy = Math.floor(sy);
                sw = Math.ceil(sw);
                sh = Math.ceil(sh);

                // Clamp to video dimensions
                sx = Math.max(0, Math.min(sx, vw - 1));
                sy = Math.max(0, Math.min(sy, vh - 1));

                // Ensure width/height don't exceed bounds
                sw = Math.min(sw, vw - sx);
                sh = Math.min(sh, vh - sy);

                if (sw > 0 && sh > 0) {
                    canvas.width = sw;
                    canvas.height = sh;
                    ctx.drawImage(tempVideo, sx, sy, sw, sh, 0, 0, sw, sh);
                    thumbnails.push({ url: canvas.toDataURL("image/jpeg", 0.7), det });
                } else {
                    errors.push(`Invalid dimensions for frame ${det.frame}: ${sw}x${sh} (bbox: ${det.bbox.map(n => n.toFixed(2))})`);
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`Failed to generate thumbnail for frame ${det.frame}:`, e);
                errors.push(`Frame ${det.frame}: ${msg}`);
            }
      }
    } catch (e) {
      console.error("Thumbnail generation failed:", e);
      gallery.innerHTML = `<p style="color:var(--sl-color-danger-600); text-align:center;">Failed to generate thumbnails: ${e instanceof Error ? e.message : String(e)}</p>`;
      return;
    } finally {
      cleanup();
    }

    // Render thumbnails
    gallery.innerHTML = "";
    if (thumbnails.length === 0) {
        let msg = "No thumbnails could be generated.";
        if (errors.length > 0) {
            msg += "<br><br>Errors:<br>" + errors.slice(0, 5).join("<br>") + (errors.length > 5 ? `<br>...and ${errors.length - 5} more` : "");
        }
        gallery.innerHTML = `<p style="text-align:center; color: var(--sl-color-neutral-600);">${msg}</p>`;
        return;
    }

    thumbnails.forEach(({ url, det }) => {
      const item = document.createElement("div");
      item.className = "thumbnail-item";
      // When clicking a thumbnail, seek the MAIN video
      item.onclick = () => {
         const mainVideo = this.shadowRoot?.querySelector("#main-video") as HTMLVideoElement;
         if (mainVideo) {
             mainVideo.currentTime = det.timestamp;
             mainVideo.scrollIntoView({ behavior: "smooth", block: "center" });
             mainVideo.play();
         }
      };

      const img = document.createElement("img");
      img.src = url;
      img.alt = `${det.category} detection`;

      const label = document.createElement("div");
      label.className = "thumbnail-label";
      label.textContent = `${det.category} ${(det.conf * 100).toFixed(0)}% @ ${det.timestamp.toFixed(1)}s`;

      item.appendChild(img);
      item.appendChild(label);
      gallery.appendChild(item);
    });
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

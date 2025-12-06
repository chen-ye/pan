import { LitElement, html, css } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { State } from '../state.ts';
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/range/range.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import "@shoelace-style/shoelace/dist/components/progress-bar/progress-bar.js";

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h > 0 ? `${h}h ` : '') + `${m}m ${s}s`;
}

export class VideoDetail extends SignalWatcher(LitElement) {
    state!: State;
    animReq: number | undefined;

    static override properties = {
        state: { attribute: false }
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
        display: flex;
        justify-content: center;
        align-items: center;
        flex-grow: 1;
        min-height: 300px;
        background: #000;
    }
    video {
        max-width: 100%;
        max-height: 100%;
        display: block;
    }
    #overlay-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }
    .controls-bar {
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
        background: rgba(0,0,0,0.7);
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

    override disconnectedCallback() {
        super.disconnectedCallback();
        if (this.animReq) cancelAnimationFrame(this.animReq);
    }

    animationLoop() {
        this.drawOverlays();
        this.animReq = requestAnimationFrame(() => this.animationLoop());
    }

    drawOverlays() {
        const video = this.shadowRoot?.querySelector('video') as HTMLVideoElement;
        const canvas = this.shadowRoot?.querySelector('#overlay-canvas') as HTMLCanvasElement;
        if (!video || !canvas) return;

        const results = this.state.currentResults.get();
        if (!results) {
             const ctx = canvas.getContext('2d')!;
             ctx.clearRect(0, 0, canvas.width, canvas.height);
             return;
        }

        const ctx = canvas.getContext('2d')!;

        // Match canvas size to video display size
        if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
            canvas.width = video.clientWidth;
            canvas.height = video.clientHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const currentTime = video.currentTime;
        // Find detections close to current time
        // Note: Using a wider threshold or finding exact frame match would be better, but this matches original logic
        const threshold = 0.1;

        const detections = results.detections || [];
        const currentDetections = detections.filter(d => Math.abs(d.timestamp - currentTime) < threshold);

        currentDetections.forEach(d => {
            const [x1, y1, x2, y2] = d.bbox; // normalized

            const rx = x1 * canvas.width;
            const ry = y1 * canvas.height;
            const rw = (x2 - x1) * canvas.width;
            const rh = (y2 - y1) * canvas.height;

            // Draw Box
            ctx.strokeStyle = '#f00';
            if (d.category === 'animal') ctx.strokeStyle = '#e91e63'; // Pink for animal
            if (d.category === 'person') ctx.strokeStyle = '#2196f3'; // Blue

            ctx.lineWidth = 3;
            ctx.strokeRect(rx, ry, rw, rh);

            // Draw Label
            ctx.fillStyle = ctx.strokeStyle;
            ctx.font = '14px sans-serif';
            ctx.fillText(`${d.category} ${(d.conf*100).toFixed(0)}%`, rx, ry - 5);
        });
    }

    override render() {
        if (!this.state) return html``;
        const currentPath = this.state.currentVideoPath.get();

        if (!currentPath) {
             return html`
                <div class="empty-state">
                    <p>Select a video to view</p>
                </div>
            `;
        }

        const vidData = this.state.videos.get().find(v => v.path === currentPath);
        const isProcessed = vidData && vidData.processed;

        const results = this.state.currentResults.get();
        const playbackSpeed = this.state.playbackSpeed.get();

        const job = this.state.processingJob.get();
        const isProcessingCurrent = job && job.path === currentPath;
        const processingStatus = isProcessingCurrent ? job.status : null;
        const processingProgress = isProcessingCurrent ? job.progress : 0;

        return html`
          <div class="video-container">
              <video
                  id="main-video"
                  controls
                  autoplay
                  muted
                  loop
                  src="${window.location.protocol}//${window.location.hostname}:8000/videos/${currentPath}"
                  @loadedmetadata=${this.onVideoLoad}
              ></video>
              <canvas id="overlay-canvas"></canvas>
          </div>

          <div class="controls-bar">
               <sl-icon name="speedometer"></sl-icon>
               <span class="speed-label">${playbackSpeed}x</span>
               <sl-range class="speed-slider" min="0.5" max="18" step="0.5" .value=${playbackSpeed} @sl-change=${(e: Event) => this.setSpeed((e.target as HTMLInputElement).value)}></sl-range>

               <div class="spacer"></div>

               ${!isProcessed ? html`
                   <sl-button id="process-btn" variant="primary" ?loading=${!!processingStatus} @click=${() => this.state.processVideo(currentPath)}>
                      <sl-icon slot="prefix" name="cpu"></sl-icon>
                      Process with AI
                   </sl-button>
               ` : html`
                   <sl-button ?loading=${!!processingStatus} @click=${() => this.state.processVideo(currentPath)}>Re-process</sl-button>
               `}

               <sl-button variant="warning" outline @click=${() => this.state.moveVideo(currentPath)}>
                   <sl-icon slot="prefix" name="cloud-upload"></sl-icon>
                   Move to Upload
               </sl-button>

               <sl-button variant="danger" outline @click=${() => this.state.deleteVideo(currentPath)}>
                   <sl-icon slot="prefix" name="trash"></sl-icon>
                   Delete
               </sl-button>
          </div>

          ${processingStatus ? html`
             <div style="padding: 10px; background: var(--sl-color-neutral-0); border-bottom: 1px solid var(--sl-color-neutral-200);">
                 <div style="display:flex; justify-content:space-between; margin-bottom: 5px; font-size: 0.8rem;">
                     <span>${processingStatus}</span>
                     <span>${(processingProgress * 100).toFixed(0)}%</span>
                 </div>
                 <sl-progress-bar value="${processingProgress * 100}"></sl-progress-bar>
             </div>
         ` : ''}

          <div class="info-panel">
              ${isProcessed ? html`<div style="margin-bottom: var(--sl-spacing-medium);"><sl-tag type="success">Processed</sl-tag></div>` : ''}
              <h3>Metadata</h3>
              <p><strong>File:</strong> ${currentPath}</p>
              ${vidData?.duration ? html`<p><strong>Duration:</strong> ${formatDuration(vidData.duration)}</p>` : ''}
              ${results ? html`
                  <p><strong>Detections:</strong> ${results.detections.length}</p>
                  <p><strong>Resolution:</strong> ${results.metadata.width}x${results.metadata.height}</p>

                  ${results.detections.length > 0 ? html`
                      <h3 style="margin-top: var(--sl-spacing-medium);">Detection Snapshots</h3>
                      <sl-button size="small" @click=${() => this.generateThumbnails()}>Generate Thumbnails</sl-button>
                      <div class="thumbnail-gallery" id="thumbnail-gallery"></div>
                  ` : ''}
              ` : ''}
          </div>
        `;
    }

    async generateThumbnails() {
        const results = this.state.currentResults.get();
        const video = this.shadowRoot?.querySelector('#main-video') as HTMLVideoElement;
        const gallery = this.shadowRoot?.querySelector('#thumbnail-gallery') as HTMLElement;

        if (!results || !video || !gallery) return;

        gallery.innerHTML = '<p style="text-align:center; padding:10px;">Generating thumbnails...</p>';

        // Get unique detections (limit to first 20 for performance)
        const uniqueDetections = results.detections.slice(0, 20);

        const thumbnails: string[] = [];
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;

        // Pause video during thumbnail generation
        const wasPlaying = !video.paused;
        video.pause();
        const originalTime = video.currentTime;

        for (const det of uniqueDetections) {
            await new Promise<void>((resolve) => {
                video.currentTime = det.timestamp;
                video.onseeked = () => {
                    // Set canvas size to match video dimensions
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;

                    // Draw full frame
                    ctx.drawImage(video, 0, 0);

                    // Draw bounding box
                    const [x1, y1, x2, y2] = det.bbox;
                    const rx = x1 * canvas.width;
                    const ry = y1 * canvas.height;
                    const rw = (x2 - x1) * canvas.width;
                    const rh = (y2 - y1) * canvas.height;

                    ctx.strokeStyle = det.category === 'animal' ? '#e91e63' : det.category === 'person' ? '#2196f3' : '#f00';
                    ctx.lineWidth = 4;
                    ctx.strokeRect(rx, ry, rw, rh);

                    thumbnails.push(canvas.toDataURL('image/jpeg', 0.7));
                    resolve();
                };
            });
        }

        // Restore video state
        video.currentTime = originalTime;
        if (wasPlaying) video.play();

        // Render thumbnails
        gallery.innerHTML = '';
        thumbnails.forEach((dataUrl, idx) => {
            const det = uniqueDetections[idx];
            const item = document.createElement('div');
            item.className = 'thumbnail-item';
            item.onclick = () => {
                video.currentTime = det.timestamp;
                video.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };

            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = `${det.category} detection`;

            const label = document.createElement('div');
            label.className = 'thumbnail-label';
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
        const video = this.shadowRoot?.querySelector('#main-video') as HTMLVideoElement;
        if (video) video.playbackRate = parseFloat(speed);
    }
}
customElements.define('video-detail', VideoDetail);


import { LitElement, html, css } from "https://esm.sh/lit@3.1.2";
import { Signal } from "https://esm.sh/signal-polyfill@0.1.0";

class State {
  constructor() {
    this.videos = new Signal.State([]);
    this.currentVideoPath = new Signal.State(null);
    this.currentResults = new Signal.State(null);
    this.playbackSpeed = new Signal.State(5.0);
    this.filterProcessed = new Signal.State(false);
  }

  async fetchVideos() {
    try {
      const res = await fetch("/api/videos");
      const data = await res.json();
      data.sort((a, b) => a.name.localeCompare(b.name));
      this.videos.set(data);
    } catch (e) {
      console.error("Failed to fetch videos", e);
    }
  }

  async selectVideo(path) {
    this.currentVideoPath.set(path);
    this.currentResults.set(null);

    // Find video object to check processed status immediately from list if possible
    const videos = this.videos.get();
    const vid = videos.find(v => v.path === path);

    if (vid && vid.processed) {
        try {
            const res = await fetch(`/api/results/${path}`);
            if (res.ok) {
                const data = await res.json();
                this.currentResults.set(data);
            }
        } catch (e) {
            console.error("Failed to load results", e);
        }
    }
  }

  async deleteVideo(path) {
    if (!confirm(`Delete ${path}?`)) return;
    await fetch(`/api/videos/${path}`, { method: 'DELETE' });
    await this.fetchVideos();
    if (this.currentVideoPath.get() === path) {
        this.currentVideoPath.set(null);
        this.currentResults.set(null);
    }
  }

  async processVideo(path) {
      const btn = document.getElementById('process-btn');
      if(btn) btn.loading = true;
      try {
          const res = await fetch("/api/worker/process", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          await this.fetchVideos();
          // Reload results if this is current video
          if (this.currentVideoPath.get() === path) {
              await this.selectVideo(path);
          }
      } catch (e) {
          alert("Processing failed: " + e.message);
      } finally {
          if(btn) btn.loading = false;
      }
  }
}

const state = new State();

class AppRoot extends LitElement {
  constructor() {
    super();
    this.videoList = [];
    this.currentVideo = null;
    this.results = null;
    this.playbackSpeed = 5.0;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    state.fetchVideos();

    this.interval = setInterval(() => {
        const newVideos = state.videos.get();
        if (JSON.stringify(newVideos) !== JSON.stringify(this.videoList)) {
            this.videoList = newVideos;
            this.requestUpdate();
        }

        const newCurrent = state.currentVideoPath.get();
        if (newCurrent !== this.currentVideo) {
            this.currentVideo = newCurrent;
            this.requestUpdate();
        }

        const newResults = state.currentResults.get();
        if (JSON.stringify(newResults) !== JSON.stringify(this.results)) {
            this.results = newResults;
        }

        const newSpeed = state.playbackSpeed.get();
        if (newSpeed !== this.playbackSpeed) {
            this.playbackSpeed = newSpeed;
            this.requestUpdate();
        }
    }, 200);

    // Animation loop for canvas
    this.animationLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.interval);
    cancelAnimationFrame(this.animReq);
  }

  animationLoop() {
      this.drawOverlays();
      this.animReq = requestAnimationFrame(() => this.animationLoop());
  }

  drawOverlays() {
      const video = this.querySelector('video');
      const canvas = this.querySelector('#overlay-canvas');
      if (!video || !canvas || !this.results) return;

      const ctx = canvas.getContext('2d');

      // Match canvas size to video display size
      if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
          canvas.width = video.clientWidth;
          canvas.height = video.clientHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const currentTime = video.currentTime;
      // Find detections close to current time
      // Assuming 30fps roughly if not provided, so 0.033s per frame.
      // We look for detections within 0.1s.
      const threshold = 0.1;

      const detections = this.results.detections || [];
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

  render() {
    return html`
      <header>
        <h1>ANIML NVR</h1>
        <div class="header-actions">
             <sl-button size="small" variant="neutral" href="https://github.com/microsoft/CameraTraps" target="_blank">MegaDetector v5</sl-button>
        </div>
      </header>
      <main>
        <!-- Filters Column -->
        <div id="filters-col">
            <div class="section-title">Filters</div>
            <sl-checkbox checked disabled>All Locations</sl-checkbox>
            <sl-divider></sl-divider>
            <div class="section-title">Classifications</div>
            <sl-checkbox checked>All</sl-checkbox>
            <sl-checkbox>Animal</sl-checkbox>
            <sl-checkbox>Person</sl-checkbox>
            <sl-checkbox>Vehicle</sl-checkbox>
            <sl-divider></sl-divider>
             <div class="section-title">Status</div>
             <sl-checkbox>Processed Only</sl-checkbox>
        </div>

        <!-- List Column -->
        <div id="list-col">
            <div class="section-title list-header">Videos (${this.videoList.length})</div>
            ${this.videoList.map(v => html`
                <div class="video-item ${this.currentVideo === v.path ? 'active' : ''}" @click=${() => state.selectVideo(v.path)}>
                    <div class="video-title" title="${v.name}">${v.name}</div>
                    <div class="tag-container">
                        ${v.processed ? html`<span class="tag processed">Processed</span>` : ''}
                        <!-- Mock tags for now until we scan all -->
                    </div>
                    <div class="video-meta">
                        <span>Video</span>
                        <sl-icon-button name="trash" class="delete-btn" label="Delete" @click=${(e) => { e.stopPropagation(); state.deleteVideo(v.path); }}></sl-icon-button>
                    </div>
                </div>
            `)}
        </div>

        <!-- Detail Column -->
        <div id="detail-col">
            ${this.currentVideo ? this.renderDetail() : html`
                <div class="empty-state">
                    <p>Select a video to view</p>
                </div>
            `}
        </div>
      </main>
    `;
  }

  renderDetail() {
      const vidData = this.videoList.find(v => v.path === this.currentVideo);
      const isProcessed = vidData && vidData.processed;

      return html`
        <div class="video-container">
            <video
                id="main-video"
                controls
                autoplay
                muted
                loop
                src="/videos/${this.currentVideo}"
                @loadedmetadata=${this.onVideoLoad}
            ></video>
            <canvas id="overlay-canvas"></canvas>
        </div>

        <div class="controls-bar">
             <sl-icon name="speedometer"></sl-icon>
             <span class="speed-label">${this.playbackSpeed}x</span>
             <sl-range class="speed-slider" min="0.5" max="10" step="0.5" .value=${this.playbackSpeed} @sl-change=${(e) => this.setSpeed(e.target.value)}></sl-range>

             <div class="spacer"></div>

             ${!isProcessed ? html`
                 <sl-button id="process-btn" variant="primary" @click=${() => state.processVideo(this.currentVideo)}>
                    <sl-icon slot="prefix" name="cpu"></sl-icon>
                    Process with AI
                 </sl-button>
             ` : html`
                 <sl-tag type="success">Processed</sl-tag>
                 <sl-button size="small" @click=${() => state.processVideo(this.currentVideo)}>Re-process</sl-button>
             `}
        </div>

        <div class="info-panel">
            <h3>Metadata</h3>
            <p><strong>File:</strong> ${this.currentVideo}</p>
            ${this.results ? html`
                <p><strong>Detections:</strong> ${this.results.detections.length}</p>
                <p><strong>Resolution:</strong> ${this.results.metadata.width}x${this.results.metadata.height}</p>
            ` : ''}
        </div>
      `;
  }

  onVideoLoad(e) {
    e.target.playbackRate = this.playbackSpeed;
  }

  setSpeed(speed) {
    state.playbackSpeed.set(parseFloat(speed));
    const video = this.querySelector('#main-video');
    if (video) video.playbackRate = parseFloat(speed);
  }
}

customElements.define('app-root', AppRoot);

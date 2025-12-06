
import { LitElement, css } from "lit";
import { SignalWatcher, html } from "@lit-labs/signals";
import { effect } from 'signal-utils/subtle/microtask-effect';


import "@shoelace-style/shoelace/dist/components/button/button.js";

import "@shoelace-style/shoelace/dist/components/tree/tree.js";

import "@shoelace-style/shoelace/dist/components/tree-item/tree-item.js";
import type SlTreeItem from "@shoelace-style/shoelace/dist/components/tree-item/tree-item.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/divider/divider.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/range/range.js";
import "@shoelace-style/shoelace/dist/components/tag/tag.js";
import { State } from "./state.ts";
import type { TreeNode } from "./types.ts";
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';

setBasePath('/shoelace');

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h > 0 ? `${h}h ` : '') + `${m}m ${s}s`;
}


class AppRoot extends SignalWatcher(LitElement) {

  animReq: number | undefined;
  state: State;

  constructor() {
    super();
    this.state = new State();
  }

  connectedCallback() {
    super.connectedCallback();
    this.state.fetchDirs();
    this.state.loadVideos(true);

    // Animation loop for canvas
    this.animationLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.animReq);
  }

  animationLoop() {
      this.drawOverlays();
      this.animReq = requestAnimationFrame(() => this.animationLoop());
  }

  drawOverlays() {
      const video = this.querySelector('video') as HTMLVideoElement;
      const canvas = this.querySelector('#overlay-canvas') as HTMLCanvasElement;
      if (!video || !canvas) return;

      const results = this.state.currentResults.get();
      if (!results) return;

      const ctx = canvas.getContext('2d')!;

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

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: var(--sl-font-sans);
      --sidebar-width: 250px;
      --list-width: 320px;
    }

    header {
      background-color: var(--sl-color-neutral-050);
      color: var(--sl-color-neutral-950);
      padding: 0 var(--sl-spacing-medium);
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    h1 { margin: 0; font-size: 1.2rem; font-weight: 600; letter-spacing: 1px; }

    main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    #filters-col {
      width: var(--sidebar-width);
      border-right: 1px solid var(--sl-color-neutral-200);
      background: var(--sl-color-neutral-50);
      display: flex;
      flex-direction: column;
      padding: var(--sl-spacing-medium);
      gap: var(--sl-spacing-medium);
    }

    #list-col {
      width: var(--list-width);
      border-right: 1px solid var(--sl-color-neutral-200);
      background: var(--sl-color-neutral-50);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    #detail-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--sl-color-neutral-200);
      position: relative;
      overflow-y: auto;
    }

    .video-item {
      padding: var(--sl-spacing-medium);
      cursor: pointer;
      border-bottom: 1px solid var(--sl-color-neutral-200);
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: background 0.2s;
    }

    .video-item:hover {
      background-color: var(--sl-color-neutral-100);
    }

    .video-item.active {
      background-color: var(--sl-color-primary-50);
      border-left: 4px solid var(--sl-color-primary-600);
    }

    .video-title {
        font-weight: 500;
        font-size: 0.9rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .video-meta {
      font-size: 0.75rem;
      color: var(--sl-color-neutral-500);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .video-container {
        position: relative;
        width: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-grow: 1;
        min-height: 300px;
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

    .tag-container {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
    }

    .tag {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.7rem;
        background: var(--sl-color-neutral-200);
        color: var(--sl-color-neutral-700);
    }

    .tag.animal {
        background: var(--sl-color-danger-100);
        color: var(--sl-color-danger-700);
        border: 1px solid var(--sl-color-danger-200);
    }

    .tag.processed {
        background: var(--sl-color-success-100);
        color: var(--sl-color-success-700);
    }

    .controls-bar {
        background: var(--sl-color-neutral-0);
        padding: var(--sl-spacing-medium);
        border-top: 1px solid var(--sl-color-neutral-200);
        display: flex;
        gap: var(--sl-spacing-medium);
        align-items: center;
    }

    .section-title {
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--sl-color-neutral-500);
        font-weight: 600;
        margin-bottom: var(--sl-spacing-small);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .list-header {
      padding: var(--sl-spacing-medium);
      position: sticky;
      top: 0;
      background: var(--sl-color-neutral-50);
      z-index: 1;
      border-bottom: 1px solid var(--sl-color-neutral-200);
    }

    .delete-btn {
      font-size: 1rem;
    }

    .empty-state {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
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
  `;

  render() {
    function formatSize(bytes: number) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    return html`
      <header>
        <h1>Pan NVR</h1>
        <div class="header-actions">
             <sl-button size="small" variant="neutral" href="https://github.com/microsoft/CameraTraps" target="_blank">MegaDetector</sl-button>
        </div>
      </header>
      <main>
        <!-- Filters Column -->
        <div id="filters-col">
            <div class="section-title">Filters</div>

            <div style="margin-bottom: 10px; font-size: 0.9rem; font-weight: 500;">Locations</div>
            ${this.state.dirTree.get().length > 0 ? html`
                <sl-tree selection="multiple" @sl-selection-change=${this.onTreeSelectionChange}>
                    ${this.renderTreeItems(this.state.dirTree.get())}
                </sl-tree>
            ` : html`<div>${this.state.error.get() ? html`<span style="color:red">${this.state.error.get()}</span>` : 'Loading dirs...'}</div>`}

            <sl-divider></sl-divider>
            <div class="section-title">Classifications</div>
            <sl-checkbox checked>All</sl-checkbox>
            <sl-checkbox>Animal</sl-checkbox>
            <sl-checkbox>Person</sl-checkbox>
            <sl-checkbox>Vehicle</sl-checkbox>
            <sl-divider></sl-divider>
             <div class="section-title">Status</div>
             <sl-checkbox .checked=${this.state.filterProcessed.get()} @sl-change=${(e: any) => this.state.setFilterProcessed(e.target.checked)}>Processed Only</sl-checkbox>
        </div>

        <!-- List Column -->
        <div id="list-col">
            <div class="section-title list-header">Videos (${this.state.totalVideos.get()})</div>
            ${this.state.videos.get().map(v => html`
                <div class="video-item ${this.state.currentVideoPath.get() === v.path ? 'active' : ''}" @click=${() => this.state.selectVideo(v.path)}>
                    <div class="video-title" title="${v.name}">${v.name}</div>
                    <div class="tag-container">
                        ${v.processed ? html`<span class="tag processed">Processed</span>` : ''}
                        <span class="tag">${formatSize(v.size)}</span>
                        ${v.duration ? html`<span class="tag">${formatDuration(v.duration)}</span>` : ''}
                    </div>
                    <div class="video-meta">
                        <span>Video</span>
                        <sl-icon-button name="trash" class="delete-btn" label="Delete" @click=${(e) => { e.stopPropagation(); this.state.deleteVideo(v.path); }}></sl-icon-button>
                    </div>
                </div>
            `)}

            ${this.state.hasMore.get() ? html`
                <div style="padding: 10px; text-align: center;">
                    <sl-button variant="default" ?loading=${this.state.isLoading.get()} @click=${() => this.state.loadVideos()}>Load More</sl-button>
                </div>
            ` : ''}
        </div>

        <!-- Detail Column -->
        <div id="detail-col">
            ${this.state.currentVideoPath.get() ? this.renderDetail() : html`
                <div class="empty-state">
                    <p>Select a video to view</p>
                </div>
            `}
        </div>
      </main>
    `;
  }

  renderDetail() {
      console.log('renderDetail');
      const currentPath = this.state.currentVideoPath.get();
      const vidData = this.state.videos.get().find(v => v.path === currentPath);
      const isProcessed = vidData && vidData.processed;

      const results = this.state.currentResults.get();
      const playbackSpeed = this.state.playbackSpeed.get();

      effect(() => {
          console.log('currentPath',  this.state.currentVideoPath.get());
      })

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
             <sl-range class="speed-slider" min="0.5" max="18" step="0.5" .value=${playbackSpeed} @sl-change=${(e) => this.setSpeed(e.target.value)}></sl-range>

             <div class="spacer"></div>

             ${!isProcessed ? html`
                 <sl-button id="process-btn" variant="primary" @click=${() => this.state.processVideo(currentPath)}>
                    <sl-icon slot="prefix" name="cpu"></sl-icon>
                    Process with AI
                 </sl-button>
             ` : html`
                 <sl-tag type="success">Processed</sl-tag>
                 <sl-button size="small" @click=${() => this.state.processVideo(currentPath)}>Re-process</sl-button>
             `}

             <sl-button variant="warning" outline @click=${() => this.state.moveVideo(currentPath)}>
                 <sl-icon slot="prefix" name="cloud-upload"></sl-icon>
                 Move to Upload
             </sl-button>
        </div>

        <div class="info-panel">
            <h3>Metadata</h3>
            <p><strong>File:</strong> ${currentPath}</p>
            ${vidData?.duration ? html`<p><strong>Duration:</strong> ${formatDuration(vidData.duration)}</p>` : ''}
            ${results ? html`
                <p><strong>Detections:</strong> ${results.detections.length}</p>
                <p><strong>Resolution:</strong> ${results.metadata.width}x${results.metadata.height}</p>
            ` : ''}
        </div>
      `;
  }

  onVideoLoad(e) {
    e.target.playbackRate = this.state.playbackSpeed.get();
  }

  setSpeed(speed: string) {
    this.state.setPlaybackSpeed(parseFloat(speed));
    const video = this.querySelector('#main-video') as HTMLVideoElement;
    if (video) video.playbackRate = parseFloat(speed);
  }
  onTreeSelectionChange(e: Event) {
      // SlTree emits sl-selection-change with detail.selection as SlTreeItem[]
      const event = e as CustomEvent;
      const selectedItems = event.detail.selection as SlTreeItem[];

      const newSet = new Set<string>();
      selectedItems.forEach(item => {
            const path = item.getAttribute('value');
            if (path) newSet.add(path);
      });
      this.state.selectedDirs.set(newSet);
      this.state.updateUrl();
      this.state.loadVideos(true);
  }

  renderTreeItems(nodes: TreeNode[]) {
      return nodes.map(node => html`
          <sl-tree-item .selected=${this.state.selectedDirs.get().has(node.path)} value="${node.path}">
              ${node.name}
              ${node.children && node.children.length > 0 ? this.renderTreeItems(node.children) : ''}
          </sl-tree-item>
      `);
  }
}

customElements.define('app-root', AppRoot);

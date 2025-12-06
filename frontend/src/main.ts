import { LitElement, css } from "lit";
import { SignalWatcher, html } from "@lit-labs/signals";
import { State } from "./state.ts";
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "./components/filter-panel.ts";
import "./components/video-list.ts";
import "./components/video-detail.ts";

setBasePath('/shoelace');

class AppRoot extends SignalWatcher(LitElement) {
  state: State;

  constructor() {
    super();
    this.state = new State();
  }

  handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.state.selectNextVideo();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.state.selectPrevVideo();
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.state.fetchDirs();
    this.state.loadVideos(true);
    window.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.handleKeyDown);
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
    }

    #list-col {
      width: var(--list-width);
      border-right: 1px solid var(--sl-color-neutral-200);
      background: var(--sl-color-neutral-50);
      display: flex;
      flex-direction: column;
    }

    #detail-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--sl-color-neutral-200);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
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
    const gpu = this.state.gpuStats.get();

    return html`
      <header>
        <h1>Pan NVR</h1>
        <div class="header-actions">
             ${gpu ? html`
                 <div style="font-size: 0.8rem; color: var(--sl-color-neutral-600); margin-right: 15px;">
                    ${gpu.error ? html`<span style="color: var(--sl-color-danger-600)">GPU Error: ${gpu.error}</span>` :
                    html`
                        <span>${gpu.gpu_name}</span>
                        <span style="margin-left: 8px;">${formatSize(gpu.memory_used)} / ${formatSize(gpu.memory_total)}</span>
                    `}
                 </div>
             ` : ''}
             <sl-button size="small" variant="neutral" href="https://github.com/microsoft/CameraTraps" target="_blank">MegaDetector</sl-button>
        </div>
      </header>
      <main>
        <!-- Filters Column -->
        <div id="filters-col">
            <filter-panel .state=${this.state}></filter-panel>
        </div>

        <!-- List Column -->
        <div id="list-col">
            <video-list .state=${this.state}></video-list>
        </div>

        <!-- Detail Column -->
        <div id="detail-col">
            <video-detail .state=${this.state}></video-detail>
        </div>
      </main>
    `;
  }
}

customElements.define('app-root', AppRoot);

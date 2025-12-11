import { css, LitElement } from "lit";
import { html, SignalWatcher } from "@lit-labs/signals";
import { State } from "./state.ts";
import { setBasePath } from "@shoelace-style/shoelace/dist/utilities/base-path.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "./components/filter-panel.ts";
import "./components/video-list.ts";
import "./components/filter-panel.ts";
import "./components/video-list.ts";
import "./components/video-detail.ts";
import "./components/queue-dialog.ts";
import type { QueueDialog } from "./components/queue-dialog.ts";
import "@shoelace-style/shoelace/dist/components/split-panel/split-panel.js";

setBasePath("/shoelace");

class AppRoot extends SignalWatcher(LitElement) {
  state: State;

  constructor() {
    super();
    this.state = new State();
    this.checkMobile();
    globalThis.addEventListener("resize", this.handleResize);
  }

  isMobile = false;

  handleResize = () => {
    this.checkMobile();
  };

  checkMobile() {
    const isMobile = globalThis.matchMedia("(max-width: 768px)").matches;
    if (this.isMobile !== isMobile) {
      this.isMobile = isMobile;
      this.requestUpdate();
    }
  }

  toggleFilters() {
    this.state.showFilters.set(!this.state.showFilters.get());
  }

  handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.state.selectNextVideo();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.state.selectPrevVideo();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      const current = this.state.currentVideoPath.get();
      if (current) {
        e.preventDefault();
        this.state.deleteVideo(current);
      }
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.state.fetchDirs();
    this.state.loadVideos(true);
    // Periodically sync queue status if processing
    setInterval(() => {
        if (this.state.processingJob.get() || this.state.processingQueue.get().length > 0) {
            this.state.fetchQueueStatus();
        }
    }, 5000);
    globalThis.addEventListener("keydown", this.handleKeyDown);
  }

  openQueue() {
      const dialog = this.shadowRoot?.querySelector('queue-dialog') as QueueDialog;
      if (dialog) dialog.show();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("keydown", this.handleKeyDown);
    globalThis.removeEventListener("resize", this.handleResize);
  }

  static override styles = css`
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

    h1 {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 600;
      letter-spacing: 1px;
    }

    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    #filters-col {
      width: var(--sidebar-width);
      border-right: 1px solid var(--sl-color-neutral-200);
      background: var(--sl-color-neutral-50);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    #list-col {
      width: var(--list-width);
      border-right: 1px solid var(--sl-color-neutral-200);
      background: var(--sl-color-neutral-50);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow-y: auto;
    }

    #detail-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--sl-color-neutral-200);
      height: 100%; /* Ensure full height for split panel content */
      overflow: hidden;
    }

    sl-split-panel {
      --divider-width: 2px;
      --min: 200px;

      height: 100%;
    }

    /* Target specific panels for scroll modification if needed,
       but generally panels handle their own scrolling */


    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .gpu-info {
      font-size: 0.8rem;
      color: var(--sl-color-neutral-600);
      margin-right: 15px;
    }

    /* Mobile breakpoint - tablets and below */
    @media (max-width: 1024px) {
      #filters-col {
        width: 200px;
      }
      #list-col {
        width: 280px;
      }
      .gpu-info {
        display: none;
      }
    }

    /* Mobile breakpoint - phones */
    @media (max-width: 768px) {
      main {
        flex-direction: column;
      }

      #filters-col {
        display: none; /* Hide filters on mobile, could add a toggle */
      }

      #list-col {
        width: 100%;
        height: 40vh;
        border-right: none;
        border-bottom: 1px solid var(--sl-color-neutral-200);
      }

      #detail-col {
        flex: 1;
        min-height: 0;
      }

      header {
        padding: 0 var(--sl-spacing-small);
        height: 50px;
      }

      h1 {
        font-size: 1rem;
      }

      .header-actions sl-button {
        display: none;
      }
      .mobile-filter-btn {
        display: block !important;
      }
    }

    .mobile-filter-btn {
      display: none;
    }

    .filter-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 100;
    }
    .filter-overlay.open {
      display: block;
    }

    .filter-drawer {
      position: fixed;
      top: 0;
      left: -280px;
      width: 280px;
      height: 100%;
      background: var(--sl-color-neutral-50);
      z-index: 101;
      transition: left 0.3s ease;
      overflow-y: auto;
    }
    .filter-drawer.open {
      left: 0;
    }
    .filter-drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--sl-spacing-medium);
      border-bottom: 1px solid var(--sl-color-neutral-200);
    }
  `;

  override render() {
    function formatSize(bytes: number) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }
    const gpu = this.state.gpuStats.get();

    return html`
      <header>
        <div style="display: flex; align-items: center; gap: 10px;">
          <sl-icon-button
            class="mobile-filter-btn"
            name="funnel"
            label="Filters"
            @click="${() => this.toggleFilters()}"
          ></sl-icon-button>
          <h1>Pan NVR</h1>
        </div>
        <div class="header-actions">
          ${gpu
            ? html`
              <div
                style="font-size: 0.8rem; color: var(--sl-color-neutral-600); margin-right: 15px;"
              >
                ${gpu.error
                  ? html`
                    <span style="color: var(--sl-color-danger-600)">GPU Error: ${gpu
                      .error}</span>
                  `
                  : html`
                    <span>${gpu.gpu_name}</span>
                    <span style="margin-left: 8px;">${gpu.utilization !==
                        undefined
                      ? `${gpu.utilization}% GPU`
                      : ""}</span>
                    <span style="margin-left: 8px;">${formatSize(
                      gpu.memory_used ?? 0,
                    )} / ${formatSize(gpu.memory_total ?? 0)}</span>
                  `}
              </div>
            `
            : ""}
          <sl-button
            size="small"
            variant="neutral"
            href="https://github.com/microsoft/CameraTraps"
            target="_blank"
          >MegaDetector</sl-button>
        </div>
      </header>



      <queue-dialog .state="${this.state}"></queue-dialog>

      <!-- Mobile Filter Drawer -->
      <div class="filter-overlay ${this.state.showFilters.get()
        ? "open"
        : ""}" @click="${() => this.toggleFilters()}"></div>
      <div class="filter-drawer ${this.state.showFilters.get() ? "open" : ""}">
        <div class="filter-drawer-header">
          <h3 style="margin: 0;">Filters</h3>
          <sl-icon-button
            name="x-lg"
            label="Close"
            @click="${() => this.toggleFilters()}"
          ></sl-icon-button>
        </div>
        <filter-panel .state="${this.state}"></filter-panel>
      </div>
      <main>
        ${this.isMobile
          ? html`
        <!-- Mobile Layout -->
        <div id="list-col">
          <video-list .state="${this.state}" @open-queue="${() => this.openQueue()}"></video-list>
        </div>
        <div id="detail-col">
          <video-detail .state="${this.state}"></video-detail>
        </div>
        `
          : html`
        <!-- Desktop Layout with Split Panels -->
        <!-- Outer split: Filters vs (List + Detail) -->
        <sl-split-panel position-in-pixels="250" primary="start">
          <div slot="start" id="filters-col" style="height: 100%; width: 100%;">
            <filter-panel .state="${this.state}"></filter-panel>
          </div>

          <div slot="end" style="height: 100%; display: flex; flex-direction: column; overflow: hidden;">
             <!-- Inner split: List vs Detail -->
             <sl-split-panel position-in-pixels="320" primary="start">
               <div slot="start" id="list-col" style="height: 100%; width: 100%; border-right: none;">
                  <video-list .state="${this.state}" @open-queue="${() => this.openQueue()}"></video-list>
               </div>
               <div slot="end" id="detail-col" style="height: 100%; width: 100%;">
                  <video-detail .state="${this.state}"></video-detail>
               </div>
             </sl-split-panel>
          </div>
        </sl-split-panel>
        `}
      </main>
    `;
  }
}

customElements.define(
  "app-root",
  AppRoot as unknown as CustomElementConstructor,
);

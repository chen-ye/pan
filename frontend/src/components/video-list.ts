import { css, html, LitElement } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { State } from "../state.ts";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";

function formatDuration(seconds?: number) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h > 0 ? `${h}h ` : "") + `${m}m ${s}s`;
}

export function formatSize(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export class VideoList extends SignalWatcher(LitElement) {
  state!: State;

  static override properties = {
    state: { attribute: false },
  };

  static override styles = [css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow-y: auto;
      background: var(--sl-color-neutral-50);
    }
    .section-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--sl-color-neutral-500);
      font-weight: 600;
      margin-bottom: var(--sl-spacing-small);
    }
    .list-header {
      padding: var(--sl-spacing-medium);
      position: sticky;
      top: 0;
      background: var(--sl-color-neutral-50);
      z-index: 1;
      border-bottom: 1px solid var(--sl-color-neutral-200);
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
    .tag.processed {
      background: var(--sl-color-success-100);
      color: var(--sl-color-success-700);
    }
    .delete-btn {
      font-size: 1rem;
    }

    /* Mobile responsive */
    @media (max-width: 768px) {
      .list-header {
        padding: var(--sl-spacing-small);
      }
      .video-item {
        padding: var(--sl-spacing-small);
        gap: 4px;
      }
      .video-title {
        font-size: 0.8rem;
      }
      .tag {
        font-size: 0.65rem;
        padding: 1px 4px;
      }
      .video-meta {
        font-size: 0.7rem;
      }
      .section-title {
        font-size: 0.7rem;
      }
    }
  `];

  override connectedCallback() {
    super.connectedCallback();
  }

  override render() {
    if (!this.state) {
      return html`

      `;
    }

    return html`
      <div
        class="list-header"
        style="display:flex; justify-content:space-between; align-items:center;"
      >
        <div class="section-title" style="margin-bottom:0">Videos (${this.state
          .totalVideos.get()})</div>
        <sl-button
          size="small"
          variant="primary"
          ?loading="${this.state.isBatchProcessing.get()}"
          @click="${() => this.state.processBatch()}"
        >Process Page</sl-button>
      </div>
      ${this.state.processingJob.get()
        ? html`
          <div
            style="padding: 8px var(--sl-spacing-medium); background: var(--sl-color-primary-50); border-bottom: 1px solid var(--sl-color-neutral-200);"
          >
            <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem;">
              <sl-spinner style="font-size: 0.9rem; --track-width: 2px;"></sl-spinner>
              <span
                style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              >
                ${this.state.processingJob.get()?.path.split("/").pop()}
              </span>
              <span style="color: var(--sl-color-primary-700); font-weight: 600;">
                ${Math.round(
                  (this.state.processingJob.get()?.progress || 0) * 100,
                )}%
              </span>
            </div>
            ${this.state.processingQueue.get().length > 0
              ? html`
                <div
                  style="font-size: 0.7rem; color: var(--sl-color-neutral-600); margin-top: 4px;"
                >
                  ${this.state.processingQueue.get().length} more in queue
                </div>
              `
              : ""}
          </div>
        `
        : ""} ${this.state.videos.get().map((v) => {
          const job = this.state.processingJob.get();
          const isProcessing = job && job.path === v.path;
          return html`
            <div class="video-item ${this.state.currentVideoPath.get() ===
                v.path
              ? "active"
              : ""}" @click="${() => this.state.selectVideo(v.path)}">
              <div class="video-title" title="${v.name}">${v.name}</div>
              <div class="tag-container">
                ${v.processed
                  ? html`
                    <span class="tag processed">Processed</span>
                  `
                  : ""} ${isProcessing
                  ? html`
                    <span
                      class="tag"
                      style="background:var(--sl-color-primary-100); color:var(--sl-color-primary-700)"
                    >${Math.round((job?.progress || 0) * 100)}%</span>
                  `
                  : ""}
                <span class="tag">${formatSize(v.size)}</span>
                ${v.duration
                  ? html`
                    <span class="tag">${formatDuration(v.duration)}</span>
                  `
                  : ""}
              </div>
              <div class="video-meta">
                <span>Video</span>
                ${isProcessing
                  ? html`
                    <sl-spinner style="font-size: 1rem; --track-width: 2px;"></sl-spinner>
                  `
                  : html`
                    <sl-icon-button
                      name="trash"
                      class="delete-btn"
                      label="Delete"
                      @click="${(e: Event) => {
                        e.stopPropagation();
                        this.state.deleteVideo(v.path);
                      }}"
                    ></sl-icon-button>
                  `}
              </div>
            </div>
          `;
        })} ${this.state.hasMore.get()
        ? html`
          <div style="padding: 10px; text-align: center;">
            <sl-button variant="default" ?loading="${this.state.isLoading
              .get()}" @click="${() => this.state.loadVideos()}"
            >Load More</sl-button>
          </div>
        `
        : ""}
    `;
  }
}
customElements.define("video-list", VideoList);

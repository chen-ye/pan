import { css, html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { SignalWatcher } from "@lit-labs/signals";
import { State } from "../state.ts";
import type { Video } from "../types.ts";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/dropdown/dropdown.js";
import "@shoelace-style/shoelace/dist/components/menu/menu.js";
import "@shoelace-style/shoelace/dist/components/menu-item/menu-item.js";

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
      margin: 0;
    }
    .list-header {
      padding: var(--sl-spacing-medium);
      position: sticky;
      top: 0;
      background: var(--sl-color-neutral-50);
      z-index: 1;
      border-bottom: 1px solid var(--sl-color-neutral-200);
      display: flex;
      flex-direction: column;
      gap: var(--sl-spacing-small);
    }
    .header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .list-header h3 {
        margin: 0;
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
    .tag.progress {
      background: var(--sl-color-primary-100);
      color: var(--sl-color-primary-700);
    }
    .delete-btn {
      font-size: 1rem;
    }
    .status-btn {
        flex: 1;
    }
    .status-btn::part(label) {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
    }
    .status-text {
        display: flex;
        flex-direction: column;
        align-items: start;
        text-align: left;
        line-height: 1.1;
        flex: 1;
    }
    .status-primary {
        font-weight: 600;
        font-size: 0.8rem;
    }
    .status-secondary {
        font-size: 0.7rem;
        opacity: 0.8;
    }
    .load-more {
        padding: 10px;
        text-align: center;
    }

    .actions-container {
        display: flex;
        align-items: center;
        gap: var(--sl-spacing-small);
        width: 100%;
    }
    .process-btn {
        flex: 1;
    }
    .list-header .section-title {
        margin: 0;
    }

    /* Mobile responsive */
    @media (max-width: 768px) {
      .list-header {
        padding: var(--sl-spacing-small);
      }
      .actions-container {
          flex-direction: column;
          align-items: stretch;
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
      return html``;
    }

    const sortLabel = {
        name: "Name",
        date: "Date",
        size: "Size"
    }[this.state.sortBy.get()] || "Name";

    return html`
      <div class="list-header">
        <div class="header-row">
            <div class="section-title">Videos (${this.state.totalVideos.get()})</div>

            <sl-dropdown>
              <sl-button slot="trigger" size="small" caret variant="text">
                Sort: ${sortLabel}
                ${this.state.sortOrder.get() === 'asc' ? '↑' : '↓'}
              </sl-button>
              <sl-menu>
                <sl-menu-item @click=${() => this.state.setSort('name')}>Name</sl-menu-item>
                <sl-menu-item @click=${() => this.state.setSort('date')}>Date</sl-menu-item>
                <sl-menu-item @click=${() => this.state.setSort('size')}>Size</sl-menu-item>
              </sl-menu>
            </sl-dropdown>
        </div>

        <div class="actions-container">
            ${(() => {
                 const job = this.state.processingJob.get();
                 const queue = this.state.processingQueue.get();

                 if (job || queue.length > 0) {
                     return html`
                       <sl-button class="status-btn" variant="default" size="small" @click=${() => this.dispatchEvent(new CustomEvent('open-queue', {bubbles: true, composed: true}))}>
                         <sl-icon slot="prefix" name="cpu"></sl-icon>
                         <div class="status-text" id="queue-count">
                            <span class="status-primary">
                                ${job ? `Processing ${(job.progress * 100).toFixed(0)}%` : 'Queue Active'}
                            </span>
                            ${queue.length > 0 ? html`<span class="status-secondary">${queue.length} pending</span>` : ''}
                         </div>
                       </sl-button>
                     `;
                 }
                 return html``;
             })()}

            <sl-button
              class="process-btn"
              size="small"
              variant="primary"
              ?loading="${this.state.isBatchProcessing.get()}"
              @click="${() => this.state.processBatch()}"
            >
                <sl-icon slot="prefix" name="stack"></sl-icon>
                Process Page
            </sl-button>
        </div>
      </div>

      ${repeat(
        this.state.videos.get(),
        (v: Video) => v.path,
        (v: Video) => {
          const job = this.state.processingJob.get();
          const isProcessing = job && job.path === v.path;
          return html`
            <div class="video-item ${this.state.currentVideoPath.get() === v.path ? "active" : ""}"
                 @click="${() => this.state.selectVideo(v.path)}">
              <div class="video-title" title="${v.name}">${v.name}</div>
              <div class="tag-container">
                ${v.processed ? html`<span class="tag processed">Processed</span>` : ""}
                ${isProcessing ? html`<span class="tag progress">${Math.round((job?.progress || 0) * 100)}%</span>` : ""}
                <span class="tag">${formatSize(v.size)}</span>
                ${v.duration ? html`<span class="tag">${formatDuration(v.duration)}</span>` : ""}
              </div>
              <div class="video-meta">
                <span>Video</span>
                ${isProcessing
                  ? html`<sl-spinner style="font-size: 1rem; --track-width: 2px;"></sl-spinner>`
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
        }
      )}

      ${this.state.hasMore.get()
        ? html`
          <div class="load-more">
            <sl-button variant="default" ?loading="${this.state.isLoading.get()}" @click="${() => this.state.loadVideos()}">
                Load More
            </sl-button>
          </div>
        `
        : ""}
    `;
  }
}
customElements.define("video-list", VideoList);

import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SignalWatcher } from "@lit-labs/signals";
import { State } from "../state.ts";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";

@customElement("queue-dialog")
export class QueueDialog extends SignalWatcher(LitElement) {
  @property({ attribute: false }) accessor state!: State;
  @state() accessor open = false;

  static override styles = css`
    .queue-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 400px;
      overflow-y: auto;
    }
    .queue-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background: var(--sl-color-neutral-050);
      border-radius: 4px;
      font-size: 0.9rem;
    }
    .queue-item.active {
      background: var(--sl-color-primary-050);
      border: 1px solid var(--sl-color-primary-200);
    }
    .empty-msg {
      text-align: center;
      color: var(--sl-color-neutral-500);
      padding: 1rem;
    }
  `;

  async show() {
    this.open = true;
    // @ts-ignore: methods added to state in recent edit
    await this.state.fetchQueueStatus();
    const dialog = this.shadowRoot?.querySelector("sl-dialog");
    if (dialog) dialog.show();
  }

  hide() {
    this.open = false;
    const dialog = this.shadowRoot?.querySelector("sl-dialog");
    if (dialog) dialog.hide();
  }

  handleClear() {
    if (confirm("Clear the entire queue?")) {
        // @ts-ignore: methods added to state in recent edit
        this.state.clearQueue();
    }
  }

  override render() {
    const queue = this.state.processingQueue.get();
    const current = this.state.processingJob.get();

    return html`
      <sl-dialog label="Processing Queue" class="queue-dialog" style="--width: 500px">
        <div class="queue-list">
          ${current ? html`
            <div class="queue-item active">
               <div>
                 <strong>Processing:</strong> ${current.path}<br>
                 <small>${current.status} (${(current.progress * 100).toFixed(0)}%)</small>
               </div>
               <sl-icon name="arrow-repeat" style="animation: spin 2s linear infinite;"></sl-icon>
            </div>
          ` : ''}

          ${queue.map(path => html`
            <div class="queue-item">
              <span>${path}</span>
              <sl-icon name="hourglass"></sl-icon>
            </div>
          `)}

          ${!current && queue.length === 0 ? html`
            <div class="empty-msg">Queue is empty</div>
          ` : ''}
        </div>

        <div slot="footer">
          <sl-button variant="danger" outline @click=${this.handleClear} ?disabled=${queue.length === 0}>
            Clear Queue
          </sl-button>
          <sl-button variant="primary" @click=${() => this.hide()}>Close</sl-button>
        </div>
      </sl-dialog>

      <style>
        @keyframes spin { 100% { transform: rotate(360deg); } }
      </style>
    `;
  }
}

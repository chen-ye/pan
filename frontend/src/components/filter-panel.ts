import { css, html, LitElement } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { State } from "../state.ts";
import type { TreeNode } from "../types.ts";
import "@shoelace-style/shoelace/dist/components/tree/tree.js";
import "@shoelace-style/shoelace/dist/components/tree-item/tree-item.js";
import type SlTreeItem from "@shoelace-style/shoelace/dist/components/tree-item/tree-item.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/divider/divider.js";

export class FilterPanel extends SignalWatcher(LitElement) {
  state!: State;

  static override properties = {
    state: { attribute: false },
  };

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--sl-spacing-medium);
      padding: var(--sl-spacing-medium);
      background: var(--sl-color-neutral-50);
      height: 100%;
      overflow-y: auto;
    }

    .section-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--sl-color-neutral-500);
      font-weight: 600;
      margin-bottom: var(--sl-spacing-small);
    }
  `;

  override render() {
    if (!this.state) {
      return html`

      `;
    }

    return html`
      <div class="section-title">Filters</div>

      <div style="margin-bottom: 10px; font-size: 0.9rem; font-weight: 500;">
        Locations
      </div>
      ${this.state.dirTree.get().length > 0
        ? html`
          <sl-tree selection="multiple" @sl-selection-change="${this
            .onTreeSelectionChange}">
            ${this.renderTreeItems(this.state.dirTree.get())}
          </sl-tree>
        `
        : html`
          <div>${this.state.error.get()
            ? html`
              <span style="color:red">${this.state.error.get()}</span>
            `
            : "Loading dirs..."}</div>
        `}

      <sl-divider></sl-divider>
      <div class="section-title">Classifications</div>
      <sl-checkbox checked>All</sl-checkbox>
      <sl-checkbox>Animal</sl-checkbox>
      <sl-checkbox>Person</sl-checkbox>
      <sl-checkbox>Vehicle</sl-checkbox>
      <sl-divider></sl-divider>
      <div class="section-title">Status</div>
      <sl-checkbox .checked="${this.state.filterProcessed
        .get()}" @sl-change="${(e: Event) =>
        this.state.setFilterProcessed((e.target as HTMLInputElement).checked)}"
      >Processed Only</sl-checkbox>
    `;
  }

  onTreeSelectionChange(e: Event) {
    // SlTree emits sl-selection-change with detail.selection as SlTreeItem[]
    const event = e as CustomEvent;
    const selectedItems = event.detail.selection as SlTreeItem[];

    const newSet = new Set<string>();
    selectedItems.forEach((item) => {
      const path = item.getAttribute("value");
      if (path) newSet.add(path);
    });
    this.state.selectedDirs.set(newSet);
    this.state.updateUrl();
    this.state.loadVideos(true);
  }

  renderTreeItems(nodes: TreeNode[]): unknown[] {
    return nodes.map((node) =>
      html`
        <sl-tree-item .selected="${this.state.selectedDirs.get().has(
          node.path,
        )}" value="${node.path}">
          ${node.name} ${node.children && node.children.length > 0
            ? this.renderTreeItems(node.children)
            : ""}
        </sl-tree-item>
      `
    );
  }
}

customElements.define("filter-panel", FilterPanel);

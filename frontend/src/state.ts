import { signal } from "@lit-labs/signals";
import type SlButton from "@shoelace-style/shoelace/dist/components/button/button.js";
import type { TreeNode, Video, Result } from "./types.ts";

export class State {
  videos = signal<Video[]>([]);
  currentVideoPath = signal<string | null>(null);
  currentResults = signal<Result | null>(null);
  playbackSpeed = signal(5.0);
  filterProcessed = signal(false);

  currentPage = signal(1);
  hasMore = signal(true);
  isLoading = signal(false);
  totalVideos = signal(0);

  dirTree = signal<TreeNode[]>([]);
  selectedDirs = signal(new Set());
  error = signal<string | null>(null);


  async fetchDirs() {
      console.log("Fetching dirs...");
      this.error.set(null);
      try {
          const res = await fetch("/api/dirs");
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const data = await res.json();
          console.log("Dirs fetched:", data.length);
          this.dirTree.set(data);
      } catch (e: any) {
          console.error("Failed to fetch dirs", e);
          this.error.set("Failed to fetch dirs: " + e.message);
      }
  }

  async loadVideos(reset = false) {
    if (this.isLoading.get()) return;
    this.isLoading.set(true);

    try {
      const page = reset ? 1 : this.currentPage.get();

      const selectedDirs = Array.from(this.selectedDirs.get());
      const dirParams = selectedDirs.map(d => `dirs=${encodeURIComponent(d)}`).join('&');
      const query = `page=${page}&limit=50` + (dirParams ? `&${dirParams}` : '');

      const res = await fetch(`/api/videos?${query}`);
      const data = await res.json();

      // Backend returns { items: [], total: ..., page: ..., limit: ... }
      const newItems = data.items;

      if (reset) {
          this.videos.set(newItems);
          this.currentPage.set(2);
      } else {
          this.videos.set([...this.videos.get(), ...newItems]);
          this.currentPage.set(page + 1);
      }

      this.hasMore.set(this.videos.get().length < data.total);
      this.totalVideos.set(data.total);

    } catch (e) {
      console.error("Failed to fetch videos", e);
    } finally {
        this.isLoading.set(false);
    }
  }

  async selectVideo(path: string) {
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

  async deleteVideo(path: string) {
    if (!confirm(`Delete ${path}?`)) return;
    await fetch(`/api/videos/${path}`, { method: 'DELETE' });
    await this.loadVideos(true);
    if (this.currentVideoPath.get() === path) {
        this.currentVideoPath.set(null);
        this.currentResults.set(null);
    }
  }

  toggleDir(path: string, selected: boolean) {
      const current = this.selectedDirs.get();
      const next = new Set(current);
      if (selected) {
          next.add(path);
      } else {
          next.delete(path);
      }
      this.selectedDirs.set(next);
      this.loadVideos(true);
  }

  async processVideo(path: string) {
      const btn = document.getElementById('process-btn') as SlButton;
      if(btn) btn.loading = true;
      try {
          const res = await fetch("/api/worker/process", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          // Just reload all for simplicity to update processed status
          await this.loadVideos(true);
          // Reload results if this is current video
          if (this.currentVideoPath.get() === path) {
              await this.selectVideo(path);
          }
      } catch (e: any) {
          alert("Processing failed: " + e.message);
      } finally {
          if(btn) btn.loading = false;
      }
  }
}

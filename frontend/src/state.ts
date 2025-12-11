import { signal, computed } from "@lit-labs/signals";
import { effect } from "signal-utils/subtle/microtask-effect";
import type SlButton from "@shoelace-style/shoelace/dist/components/button/button.js";
import type { GpuStats, Result, TreeNode, Video } from "./types.ts";

interface LegacyAnnotation {
  img_id?: string;
  bbox?: number[][];
  category?: string[];
  confidence?: number[];
}

interface ProcessingStartedEvent {
  path: string;
  queueLength?: number;
}
interface ProcessingProgressEvent {
  path: string;
  progress: number;
  status: string;
}
interface ProcessingErrorEvent {
  error: string;
}
interface VideosResponse {
  items: Video[];
  total: number;
  page: number;
  limit: number;
}

export class State {
  videos = signal<Video[]>([]);
  currentVideoPath = signal<string | null>(null);
  currentResults = signal<Result | null>(null);
  playbackSpeed = signal(5.0);
  // filterProcessed = signal(false); // Deprecated
  selectedTags = signal<Set<string>>(new Set());

  showFilters = signal(false);

  currentPage = signal(1);
  hasMore = signal(true);
  isLoading = signal(false);
  totalVideos = signal(0);
  sortBy = signal("name");
  sortOrder = signal("asc");

  dirTree = signal<TreeNode[]>([]);
  selectedDirs = signal<Set<string>>(new Set());
  minimizedDirs = computed(() => this.minimizeDirs(Array.from(this.selectedDirs.get())));
  error = signal<string | null>(null);

  gpuStats = signal<GpuStats | null>(null);

  constructor() {
    const url = new URL(globalThis.location.href);
    const params = url.searchParams;
    if (params.has("video")) this.currentVideoPath.set(params.get("video"));
    if (params.has("speed")) {
      this.playbackSpeed.set(parseFloat(params.get("speed")!));
    }
    if (params.has("tags")) {
        const tags = params.get("tags")!.split(",");
        this.selectedTags.set(new Set(tags));
    }

    if (params.has("sort")) {
      this.sortBy.set(params.get("sort")!);
    }
    if (params.has("order")) {
      this.sortOrder.set(params.get("order")!);
    }

    // Load dirs from sessionStorage
    try {
      const stored = sessionStorage.getItem("selectedDirs");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this.selectedDirs.set(new Set(parsed));
        }
      }
    } catch (e) {
      console.warn("Failed to load dirs from session", e);
    }

    // Auto-update URL when state changes
    effect(() => {
        this.updateUrl();
    });

    // Auto-refresh library
    const evtSource = new EventSource("/api/events");
    evtSource.addEventListener("update", () => {
      console.log("Library update received, reloading...");
      this.loadVideos(true);
    });

    // Listen for processing updates from server
    evtSource.addEventListener("processing_started", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as ProcessingStartedEvent;
      this.processingJob.set({
        path: data.path,
        progress: 0,
        status: "Starting...",
      });
    });

    evtSource.addEventListener("processing_progress", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as ProcessingProgressEvent;
      this.processingJob.set({
        path: data.path,
        progress: data.progress,
        status: data.status,
      });
    });

    evtSource.addEventListener("processing_done", () => {
      this.loadVideos(false); // Refresh to show updated status
    });

    evtSource.addEventListener("video_processed", () => {
      this.loadVideos(false);
    });

    evtSource.addEventListener("processing_complete", () => {
      this.processingJob.set(null);
      this.isBatchProcessing.set(false);
    });

    evtSource.addEventListener("processing_error", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as ProcessingErrorEvent;
      console.error("Processing error:", data.error);
    });

    // Receive GPU stats via SSE (pushed from server)
    evtSource.addEventListener("gpu_stats", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as GpuStats;
      this.gpuStats.set(data);
    });
  }

  updateUrl() {
    const params = new URLSearchParams();
    const video = this.currentVideoPath.get();
    if (video) params.set("video", video);

    const speed = this.playbackSpeed.get();
    if (speed !== 5.0) params.set("speed", speed.toString());

    const tags = Array.from(this.selectedTags.get());
    if (tags.length > 0) params.set("tags", tags.join(","));

    const sort = this.sortBy.get();
    if (sort !== "name") params.set("sort", sort);

    const order = this.sortOrder.get();
    if (order !== "asc") params.set("order", order);

    const url = new URL(globalThis.location.href);
    url.search = params.toString();
    globalThis.history.replaceState({}, "", url.toString());
  }

  setPlaybackSpeed(speed: number) {
    this.playbackSpeed.set(speed);
  }

  toggleTag(tag: string) {
      const current = this.selectedTags.get();
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      this.selectedTags.set(next);
      this.updateUrl();
      this.loadVideos(true);
  }

  // setFilterProcessed(value: boolean) { ... } // Removed

  async fetchDirs() {
    console.log("Fetching dirs...");
    this.error.set(null);
    try {
      const res = await fetch("/api/dirs");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      console.log("Dirs fetched:", data.length);
      this.dirTree.set(data);
    } catch (e: unknown) {
      console.error("Failed to fetch dirs", e);
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set("Failed to fetch dirs: " + msg);
    }
  }

  durationCache = new Map<string, number>();

  // ...

  async loadVideos(reset = false) {
    if (this.isLoading.get()) return;
    this.isLoading.set(true);

    try {
      const page = reset ? 1 : this.currentPage.get();

      const selectedDirs = this.minimizedDirs.get();

      const payload = {
        page: page,
        limit: 50,
        sort: this.sortBy.get(),
        order: this.sortOrder.get(),
        dirs: selectedDirs,
        tags: Array.from(this.selectedTags.get())
      };

      const res = await fetch("/api/videos/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json() as VideosResponse;

      // Backend returns { items: [], total: ..., page: ..., limit: ... }
      const newItems = data.items;

      // Apply cached durations
      newItems.forEach((item: Video) => {
        if (item.duration === undefined && this.durationCache.has(item.path)) {
          item.duration = this.durationCache.get(item.path);
        }
      });

      if (reset) {
        this.videos.set(newItems);
        this.currentPage.set(2);
      } else {
        this.videos.set([...this.videos.get(), ...newItems]);
        this.currentPage.set(page + 1);
      }

      this.hasMore.set(this.videos.get().length < data.total);
      this.totalVideos.set(data.total);

      // Fetch durations asynchronously
      this.fetchDurations(newItems);
    } catch (e) {
      console.error("Failed to fetch videos", e);
    } finally {
      this.isLoading.set(false);
    }
  }



  resultsCache = new Map<string, Result>();

  async selectVideo(path: string) {
    this.currentVideoPath.set(path);
    this.currentResults.set(null);

    // Check cache first
    if (this.resultsCache.has(path)) {
      this.currentResults.set(this.resultsCache.get(path)!);
      this.prefetchNeighbors(path);
      return;
    }

    // Find video object to check processed status immediately from list if possible
    const videos = this.videos.get();
    const vid = videos.find((v) => v.path === path);

    if (vid && vid.processed) {
      try {
        const res = await fetch(`/api/results/${path}`);
        if (res.ok) {
          try {
            let data = await res.json();
            // data = this.normalizeLegacyFormat(data); // Backend handles this now
            this.resultsCache.set(path, data);
            this.currentResults.set(data);
          } catch (e) {
            console.error("Failed to parse JSON results", e);
            this.currentResults.set(null);
            this.error.set(`Result file corrupted for ${path}: ${e instanceof Error ? e.message : String(e)}`);
            setTimeout(() => this.error.set(null), 5000);
          }
        }
      } catch (e) {
        console.error("Failed to load results", e);
      }
    }

    this.prefetchNeighbors(path);
  }

  prefetchNeighbors(currentPath: string) {
    const videos = this.videos.get();
    const idx = videos.findIndex(v => v.path === currentPath);
    if (idx === -1) return;

    if (idx > 0) {
        this.prefetchResult(videos[idx - 1].path);
    }
    if (idx < videos.length - 1) {
        this.prefetchResult(videos[idx + 1].path);
    }
  }

  async prefetchResult(path: string) {
    if (this.resultsCache.has(path)) return; // Already cached

    // Check if processed
    const videos = this.videos.get();
    const vid = videos.find(v => v.path === path);
    if (!vid || !vid.processed) return;

    try {
        const res = await fetch(`/api/results/${path}`);
        if (res.ok) {
            const data = await res.json();
            // data = this.normalizeLegacyFormat(data);
            this.resultsCache.set(path, data);
        }
    } catch {
        // Ignore prefetch errors
    }
  }

  async deleteVideo(path: string) {
    if (!confirm(`Delete ${path}?`)) return;

    // Calculate next video before deletion
    const videos = this.videos.get();
    const idx = videos.findIndex((v) => v.path === path);
    let nextPath: string | null = null;
    if (idx !== -1) {
      if (idx < videos.length - 1) {
        nextPath = videos[idx + 1].path;
      } else if (idx > 0) {
        nextPath = videos[idx - 1].path;
      }
    }

    await fetch(`/api/videos/${path}`, { method: "DELETE" });
    await this.loadVideos(true);

    if (this.currentVideoPath.get() === path) {
      if (nextPath) {
        this.selectVideo(nextPath);
      } else {
        this.currentVideoPath.set(null);
        this.currentResults.set(null);
        this.updateUrl();
      }
    }
  }

  setSelectedDirs(dirs: Set<string>) {
    this.selectedDirs.set(dirs);
    const minimized = this.minimizeDirs(Array.from(dirs));
    sessionStorage.setItem("selectedDirs", JSON.stringify(minimized));
    this.loadVideos(true);
  }

  setSort(by: string) {
      if (this.sortBy.get() === by) {
          // Toggle order
          this.sortOrder.set(this.sortOrder.get() === "asc" ? "desc" : "asc");
      } else {
          this.sortBy.set(by);
          this.sortOrder.set("asc");
      }
      this.loadVideos(true);
  }

  selectNextVideo() {
    const videos = this.videos.get();
    const current = this.currentVideoPath.get();
    if (!current && videos.length > 0) {
      this.selectVideo(videos[0].path);
      return;
    }
    const idx = videos.findIndex((v) => v.path === current);
    if (idx !== -1 && idx < videos.length - 1) {
      this.selectVideo(videos[idx + 1].path);
    }
  }

  selectPrevVideo() {
    const videos = this.videos.get();
    const current = this.currentVideoPath.get();
    if (!current && videos.length > 0) {
      this.selectVideo(videos[0].path);
      return;
    }
    const idx = videos.findIndex((v) => v.path === current);
    if (idx > 0) {
      this.selectVideo(videos[idx - 1].path);
    }
  }

  processingJob = signal<
    { path: string; progress: number; status: string } | null
  >(null);
  processingQueue = signal<string[]>([]);
  isBatchProcessing = signal(false);

  async processBatch() {
    if (this.isBatchProcessing.get()) return;

    const videos = this.videos.get();
    // Filter for unprocessed videos
    const paths = videos.filter((v) => !v.processed).map((v) => v.path);

    if (paths.length === 0) {
      alert("No unprocessed videos to process.");
      return;
    }

    this.isBatchProcessing.set(true);

    try {
      const res = await fetch("/api/processing/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });

      if (!res.ok) {
        throw new Error(`Failed to queue: ${res.status}`);
      }

      const result = await res.json();
      console.log(`Queued ${result.queued} videos for processing`);
      this.fetchQueueStatus();
    } catch (e) {
      console.error("Failed to queue batch:", e);
      this.isBatchProcessing.set(false);
    }
  }

  async fetchQueueStatus() {
    try {
        const res = await fetch("/api/processing/status");
        if (res.ok) {
            const data = await res.json();
            this.processingQueue.set(data.queue || []);
        }
    } catch (e) {
        console.error("Failed to fetch queue status", e);
    }
  }

  async clearQueue() {
      try {
          await fetch("/api/processing/queue", { method: "DELETE" });
          this.fetchQueueStatus();
      } catch (e) {
          console.error("Failed to clear queue", e);
      }
  }

  async processVideo(path: string, isBatch = false) {
    if (this.processingJob.get() && !isBatch) return; // Busy

    const btn = document.getElementById("process-btn") as SlButton;
    if (btn && !isBatch) btn.loading = true;

    this.processingJob.set({ path, progress: 0, status: "Starting..." });

    try {
      const res = await fetch("/api/worker/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No readable stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep last partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.error) throw new Error(msg.error);

            if (msg.status === "progress") {
              this.processingJob.set({
                path,
                progress: msg.progress,
                status: `Processing frame ${msg.frame}/${msg.total_frames}`,
              });
            } else if (msg.status === "complete") {
              this.processingJob.set({ path, progress: 1, status: "Complete" });
            } else if (msg.status === "starting") {
              this.processingJob.set({
                path,
                progress: 0,
                status: "Starting...",
              });
            }
          } catch (e) {
            console.error("JSON parse error", e);
          }
        }
      }

      // Reload list to update status
      await this.loadVideos(true);

      // If this was the current video, reload its results
      if (this.currentVideoPath.get() === path) {
        await this.selectVideo(path); // This fetches results
      }
    } catch (e: unknown) {
      if (!isBatch) {
        alert(
          "Processing failed: " + (e instanceof Error ? e.message : String(e)),
        );
      }
      console.error(`Processing failed for ${path}:`, e);
    } finally {
      this.processingJob.set(null);
      if (btn) btn.loading = false;
    }
  }
  async fetchDurations(items: Video[]) {
    const paths = items.filter((v) => v.duration === undefined).map((v) =>
      v.path
    );
    if (paths.length === 0) return;

    try {
      const res = await fetch("/api/videos/durations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });

      if (res.ok) {
        const data = await res.json();
        // Batch update
        const currentList = this.videos.get();
        // Create a map for faster lookup
        const durationMap = new Map(Object.entries(data));

        // Update cache
        for (const [path, dur] of durationMap.entries()) {
          this.durationCache.set(path, Number(dur));
        }

      const updatedList = currentList.map((v) => {
          if (durationMap.has(v.path)) {
            const d = Number(durationMap.get(v.path));
            return { ...v, duration: isNaN(d) ? undefined : d };
          }
          return v;
        });

        this.videos.set(updatedList);
      }
    } catch (e) {
      console.error("Failed to fetch durations", e);
    }
  }

  async moveVideo(path: string) {
    if (!confirm(`Move ${path} to NVR-upload?`)) return;
    try {
      const res = await fetch("/api/videos/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || res.statusText);
      }
      // Remove from local list to reflect immediate change
      const current = this.videos.get();
      this.videos.set(current.filter((v) => v.path !== path));

      if (this.currentVideoPath.get() === path) {
        this.currentVideoPath.set(null);
        this.currentResults.set(null);
      }
    } catch (e: unknown) {
      alert("Move failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  minimizeDirs(dirs: string[]): string[] {
    if (dirs.length === 0) return [];

    // Sort to ensure parents come before children
    // e.g. ["/a", "/a/b", "/b"]
    const sorted = [...dirs].sort();

    const result: string[] = [];

    for (const dir of sorted) {
      // Check if this dir is covered by the last added dir
      if (result.length > 0) {
        const last = result[result.length - 1];
        if (dir.startsWith(last + "/") || dir === last) {
          continue;
        }
      }
      result.push(dir);
    }

    return result;
  }
}

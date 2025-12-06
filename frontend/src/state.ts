import { signal } from "@lit-labs/signals";
import type SlButton from "@shoelace-style/shoelace/dist/components/button/button.js";
import type { Detection, GpuStats, Result, TreeNode, Video } from "./types.ts";

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
  filterProcessed = signal(false);

  showFilters = signal(false);

  currentPage = signal(1);
  hasMore = signal(true);
  isLoading = signal(false);
  totalVideos = signal(0);

  dirTree = signal<TreeNode[]>([]);
  selectedDirs = signal<Set<string>>(new Set());
  error = signal<string | null>(null);

  gpuStats = signal<GpuStats | null>(null);

  constructor() {
    const params = new URLSearchParams(globalThis.location.search);
    if (params.has("video")) this.currentVideoPath.set(params.get("video"));
    if (params.has("speed")) {
      this.playbackSpeed.set(parseFloat(params.get("speed")!));
    }
    if (params.has("processed")) {
      this.filterProcessed.set(params.get("processed") === "true");
    }
    if (params.has("dirs")) {
      const dirs = params.get("dirs")!.split(",");
      this.selectedDirs.set(new Set(dirs));
    }

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

    const processed = this.filterProcessed.get();
    if (processed) params.set("processed", "true");

    const dirs = Array.from(this.selectedDirs.get());
    if (dirs.length > 0) params.set("dirs", dirs.join(","));

    const newUrl = `${globalThis.location.pathname}?${params.toString()}`;
    globalThis.history.replaceState({}, "", newUrl);
  }

  setPlaybackSpeed(speed: number) {
    this.playbackSpeed.set(speed);
    this.updateUrl();
  }

  setFilterProcessed(value: boolean) {
    this.filterProcessed.set(value);
    this.updateUrl();
  }

  async fetchDirs() {
    console.log("Fetching dirs...");
    this.error.set(null);
    this.updateUrl();
    this.updateUrl(); // Sync initial state to URL if needed (e.g. cleaning up empty params)
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

      const selectedDirs = Array.from(this.selectedDirs.get());
      const dirParams = selectedDirs.map((d: string) =>
        `dirs=${encodeURIComponent(d)}`
      ).join("&");
      const query = `page=${page}&limit=50` +
        (dirParams ? `&${dirParams}` : "");

      const res = await fetch(`/api/videos?${query}`);
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

  // deno-lint-ignore no-explicit-any
  normalizeLegacyFormat(data: any): any {
    // Check if data has legacy format (annotations array)
    if (data.annotations && Array.isArray(data.annotations)) {
      console.log("Converting legacy format to new format");
      const detections: Detection[] = [];

      data.annotations.forEach((ann: LegacyAnnotation) => {
        const frameNum = parseInt(ann.img_id || "0");
        const bboxes = ann.bbox || [];
        const categories = ann.category || [];
        const confidences = ann.confidence || [];

        // Each frame can have multiple detections
        for (let i = 0; i < bboxes.length; i++) {
          detections.push({
            frame: frameNum,
            timestamp: frameNum / 2, // Assume 2fps processing
            category: categories[i] || "unknown",
            conf: confidences[i] || 0,
            bbox: bboxes[i] || [0, 0, 0, 0],
          });
        }
      });

      return {
        video: data.video || "unknown",
        metadata: data.metadata || {
          fps: 2,
          total_frames: data.annotations.length,
          width: 1920,
          height: 1080,
        },
        detections: detections,
      };
    }

    // Already in new format
    return data;
  }

  async selectVideo(path: string) {
    this.currentVideoPath.set(path);
    this.currentResults.set(null);
    this.updateUrl();
    this.updateUrl();

    // Find video object to check processed status immediately from list if possible
    const videos = this.videos.get();
    const vid = videos.find((v) => v.path === path);

    if (vid && vid.processed) {
      try {
        const res = await fetch(`/api/results/${path}`);
        if (res.ok) {
          let data = await res.json();
          data = this.normalizeLegacyFormat(data);
          this.currentResults.set(data);
        }
      } catch (e) {
        console.error("Failed to load results", e);
      }
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
        this.updateUrl();
      }
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
    this.updateUrl();
    this.loadVideos(true);
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
            return { ...v, duration: Number(durationMap.get(v.path)) };
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
      this.updateUrl();
    } catch (e: unknown) {
      alert("Move failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

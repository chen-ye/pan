import { CONFIG } from "../config.ts";
import { sseService } from "./sse.ts";

interface ProcessingJob {
  path: string;
  progress: number;
  status: string;
}

class ProcessingService {
  private queue: string[] = [];
  private currentJob: ProcessingJob | null = null;
  private isProcessing = false;

  getStatus() {
    return {
      currentJob: this.currentJob,
      queue: this.queue,
      isProcessing: this.isProcessing,
    };
  }

  addToQueue(paths: string[]) {
    // Deduplicate against current job and existing queue
    const uniquePaths = paths.filter(p => {
        const isProcessing = this.currentJob && this.currentJob.path === p;
        const isQueued = this.queue.includes(p);
        return !isProcessing && !isQueued;
    });

    if (uniquePaths.length > 0) {
        this.queue.push(...uniquePaths);
        if (!this.isProcessing) {
            this.processNextInQueue();
        }
    }

    return {
        queued: uniquePaths.length,
        skipped: paths.length - uniquePaths.length,
        total: this.queue.length + (this.isProcessing ? 1 : 0)
    };
  }

  clearQueue() {
    this.queue = [];
    return { success: true };
  }

  private async processNextInQueue() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.currentJob = null;
      sseService.broadcastEvent("processing_complete", {});
      return;
    }

    this.isProcessing = true;
    const path = this.queue.shift()!;

    // Check if file still exists
    try {
        const fullPath = CONFIG.DATA_DIR + "/" + path;
        await Deno.stat(fullPath);
    } catch {
        // File doesn't exist, skip it
        console.warn(`Skipping missing file: ${path}`);
        this.processNextInQueue();
        return;
    }

    this.currentJob = { path, progress: 0, status: "Starting..." };
    sseService.broadcastEvent("processing_started", {
      path,
      queueLength: this.queue.length,
    });

    try {
      const response = await fetch(`${CONFIG.WORKER_URL}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        throw new Error(`Worker returned ${response.status}`);
      }

      // Read NDJSON stream for progress updates
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.status === "progress") {
              this.currentJob = {
                path,
                progress: data.progress,
                status: `Frame ${data.frame}/${data.total_frames}`,
              };
              sseService.broadcastEvent("processing_progress", this.currentJob);
            } else if (data.status === "complete") {
              sseService.broadcastEvent("processing_done", {
                path,
                detections: data.detections,
              });
            }
          } catch {
            // Ignore malformed JSON lines
          }
        }
      }

      sseService.broadcastEvent("video_processed", { path });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      sseService.broadcastEvent("processing_error", { path, error: errMsg });
    }

    // Process next in queue
    this.processNextInQueue();
  }
}

export const processingService = new ProcessingService();

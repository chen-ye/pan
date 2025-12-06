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
            isProcessing: this.isProcessing
        };
    }

    addToQueue(paths: string[]) {
        this.queue.push(...paths);
        if (!this.isProcessing) {
            this.processNextInQueue();
        }
        return { queued: paths.length, total: this.queue.length };
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

        this.currentJob = { path, progress: 0, status: "Starting..." };
        sseService.broadcastEvent("processing_started", { path, queueLength: this.queue.length });

        try {
            const response = await fetch(`${CONFIG.WORKER_URL}/process`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path })
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
                                status: `Frame ${data.frame}/${data.total_frames}`
                            };
                            sseService.broadcastEvent("processing_progress", this.currentJob);
                        } else if (data.status === "complete") {
                            sseService.broadcastEvent("processing_done", { path, detections: data.detections });
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

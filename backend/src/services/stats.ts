import { CONFIG } from "../config.ts";
import { sseService } from "./sse.ts";

class StatsService {
    private pollInterval: number | null = null;

    start() {
        // Poll worker stats every 5 seconds and broadcast via SSE
        this.pollInterval = setInterval(() => this.fetchAndBroadcast(), 5000);
        // Initial fetch
        this.fetchAndBroadcast();
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async fetchAndBroadcast() {
        try {
            const res = await fetch(`${CONFIG.WORKER_URL}/stats`);
            if (res.ok) {
                const stats = await res.json();
                sseService.broadcastEvent("gpu_stats", stats);
            }
        } catch {
            // Worker might be down, ignore
        }
    }
}

export const statsService = new StatsService();

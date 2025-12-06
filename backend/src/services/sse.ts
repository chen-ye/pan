import { ServerSentEvent, ServerSentEventTarget } from "jsr:@oak/oak";

export class SSEService {
    private clients = new Set<ServerSentEventTarget>();

    addClient(target: ServerSentEventTarget) {
        this.clients.add(target);
        // Oak's ServerSentEventTarget doesn't have addEventListener
        // Cleanup happens automatically when connection closes
    }

    notifyUpdate() {
        for (const target of this.clients) {
            try {
                target.dispatchEvent(new ServerSentEvent("update", { data: JSON.stringify({ timestamp: Date.now() }) }));
            } catch (e) {
                // Client disconnected, remove from set
                this.clients.delete(target);
            }
        }
    }
}

export const sseService = new SSEService();

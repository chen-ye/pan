import { ServerSentEvent, ServerSentEventTarget } from "@oak/oak";

export class SSEService {
  private clients = new Set<ServerSentEventTarget>();

  addClient(target: ServerSentEventTarget) {
    this.clients.add(target);
    // Oak's ServerSentEventTarget doesn't have addEventListener
    // Cleanup happens automatically when connection closes
  }

  notifyUpdate() {
    this.broadcastEvent("update", { timestamp: Date.now() });
  }

  broadcastEvent(eventType: string, data: unknown) {
    for (const target of this.clients) {
      try {
        target.dispatchEvent(
          new ServerSentEvent(eventType, { data: JSON.stringify(data) }),
        );
      } catch {
        // Client disconnected, remove from set
        this.clients.delete(target);
      }
    }
  }
}

export const sseService = new SSEService();

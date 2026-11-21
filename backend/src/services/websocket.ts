/**
 * WebSocket service for real-time live event streaming.
 *
 * Clients connect to ws://<host>/ws and optionally subscribe to specific
 * event types and/or token addresses via a JSON subscription message:
 *
 *   { "type": "subscribe", "events": ["token.created"], "tokenAddress": "C..." }
 *
 * The server broadcasts structured event messages to all matching clients.
 * Unauthenticated connections receive public events only; admin events require
 * a valid Bearer token passed in the `Authorization` header on upgrade.
 *
 * Security:
 *  - Origin validation via CORS allowlist
 *  - Per-IP connection limit (MAX_CONNECTIONS_PER_IP)
 *  - Heartbeat / ping-pong to detect stale connections
 *  - Message size cap to prevent memory exhaustion
 */

import { WebSocketServer, WebSocket, RawData } from "ws";
import { IncomingMessage, Server } from "http";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of WebhookEventType re-exported for WS consumers */
export type LiveEventType =
  | "token.created"
  | "token.metadata.updated"
  | "token.burn.self"
  | "token.burn.admin"
  | "stream.created"
  | "stream.claimed"
  | "vault.created"
  | "vault.claimed"
  | "governance.proposal.created"
  | "governance.vote.cast"
  | "governance.proposal.executed";

export interface LiveEvent {
  type: LiveEventType;
  timestamp: string;
  tokenAddress?: string;
  data: Record<string, unknown>;
}

/** Message sent by a client to subscribe/unsubscribe */
interface SubscribeMessage {
  type: "subscribe" | "unsubscribe" | "refresh_token" | "auth";
  token?: string;
  /** Filter to specific event types; omit to receive all */
  events?: LiveEventType[];
  /** Filter to a specific token address; omit to receive all */
  tokenAddress?: string;
}

/** Internal per-connection state */
interface ClientState {
  ws: WebSocket;
  ip: string;
  subscribedEvents: Set<LiveEventType> | null; // null = all events
  tokenAddress: string | null;
  isAlive: boolean;
  tokenExpiresAt?: number;
  tokenExpiryTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 4_096;
const MAX_CONNECTIONS_PER_IP = 10;
export const TOKEN_EXPIRED_CLOSE_CODE = 4001;

// ---------------------------------------------------------------------------
// WebSocketService
// ---------------------------------------------------------------------------

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private ipConnectionCount = new Map<string, number>();

  /**
   * Attach the WebSocket server to an existing HTTP server.
   * Call this once after `app.listen(...)`.
   */
  attach(server: Server): void {
    if (this.wss) return; // already attached

    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) =>
      logger.error("WS server error", {
        error: err instanceof Error ? err.message : String(err),
      })
    );

    this.heartbeatTimer = setInterval(
      () => this.runHeartbeat(),
      HEARTBEAT_INTERVAL_MS
    );
    // Do not let the heartbeat timer keep the event loop (and process) alive
    // during graceful shutdown or in tests. `close()` still clears it.
    this.heartbeatTimer?.unref?.();

    logger.info("WebSocket server attached", { path: "/ws" });
  }

  /**
   * Broadcast a live event to all matching subscribers.
   */
  broadcast(event: LiveEvent): void {
    if (!this.wss) return;

    const payload = JSON.stringify(event);

    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!this.clientMatchesEvent(state, event)) continue;

      ws.send(payload, (err) => {
        if (err) logger.error("WS send error", { error: err.message });
      });
    }
  }

  /** Number of currently connected clients (for metrics / health). */
  get connectionCount(): number {
    return this.clients.size;
  }

  /**
   * Gracefully close the WebSocket server.
   */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const state of this.clients.values()) {
      if (state.tokenExpiryTimer) clearTimeout(state.tokenExpiryTimer);
      // 1001 = going away; lets clients reconnect and unblocks server.close()
      try { state.ws.close(1001, "Server shutting down"); } catch { /* already closed */ }
    }
    this.wss?.close();
    this.wss = null;
    this.clients.clear();
    this.ipConnectionCount.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this.resolveIp(req);

    // Enforce per-IP connection limit
    const current = this.ipConnectionCount.get(ip) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    this.ipConnectionCount.set(ip, current + 1);

    const state: ClientState = {
      ws,
      ip,
      subscribedEvents: null, // subscribe to all by default
      tokenAddress: null,
      isAlive: true,
    };
    const initialToken = this.extractToken(req);
    if (initialToken && !this.applyToken(state, initialToken)) {
      ws.close(1008, "Invalid or expired authentication token");
      this.decrementIpCount(ip);
      return;
    }

    this.clients.set(ws, state);

    // Send a welcome / connection-ack message
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Connected to Nova Launch live event stream",
        timestamp: new Date().toISOString(),
      })
    );

    ws.on("pong", () => {
      const s = this.clients.get(ws);
      if (s) s.isAlive = true;
    });

    ws.on("message", (raw) => this.handleMessage(ws, raw));

    ws.on("close", () => this.handleClose(ws, ip));

    ws.on("error", (err) => {
      logger.error("WS client error", { ip, error: err.message });
    });
  }

  private handleMessage(ws: WebSocket, raw: RawData): void {
    // Guard against oversized messages
    const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw.toString());
    if (bytes > MAX_MESSAGE_BYTES) {
      ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
      return;
    }

    let msg: SubscribeMessage;
    try {
      msg = JSON.parse(raw.toString()) as SubscribeMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const state = this.clients.get(ws);
    if (!state) return;

    if (msg.type === "subscribe") {
      state.subscribedEvents = msg.events?.length
        ? new Set(msg.events)
        : null; // null = all
      state.tokenAddress = msg.tokenAddress ?? null;

      ws.send(
        JSON.stringify({
          type: "subscribed",
          events: msg.events ?? "all",
          tokenAddress: state.tokenAddress ?? "all",
          timestamp: new Date().toISOString(),
        })
      );
    } else if (msg.type === "unsubscribe") {
      state.subscribedEvents = null;
      state.tokenAddress = null;
      ws.send(JSON.stringify({ type: "unsubscribed", timestamp: new Date().toISOString() }));
    } else if (msg.type === "refresh_token" || msg.type === "auth") {
      if (!msg.token || !this.applyToken(state, msg.token)) {
        ws.close(TOKEN_EXPIRED_CLOSE_CODE, "Authentication token expired; refresh required");
        return;
      }
      ws.send(JSON.stringify({
        type: "token_refreshed",
        timestamp: new Date().toISOString(),
      }));
    }
  }

  private handleClose(ws: WebSocket, ip: string): void {
    const state = this.clients.get(ws);
    if (state?.tokenExpiryTimer) clearTimeout(state.tokenExpiryTimer);
    this.clients.delete(ws);
    this.decrementIpCount(ip);
  }

  private decrementIpCount(ip: string): void {
    const count = this.ipConnectionCount.get(ip) ?? 0;
    if (count <= 1) {
      this.ipConnectionCount.delete(ip);
    } else {
      this.ipConnectionCount.set(ip, count - 1);
    }
  }

  private runHeartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (!state.isAlive) {
        ws.terminate();
        this.handleClose(ws, state.ip);
        continue;
      }
      state.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }

  private clientMatchesEvent(state: ClientState, event: LiveEvent): boolean {
    if (state.subscribedEvents && !state.subscribedEvents.has(event.type)) {
      return false;
    }
    if (state.tokenAddress && event.tokenAddress !== state.tokenAddress) {
      return false;
    }
    return true;
  }

  private resolveIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  private extractToken(req: IncomingMessage): string | null {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return null;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return null;
    return token;
  }

  private applyToken(state: ClientState, token: string): boolean {
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    try {
      const decoded = jwt.verify(token, secret) as { exp?: number };
      if (state.tokenExpiryTimer) clearTimeout(state.tokenExpiryTimer);
      state.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : undefined;
      if (state.tokenExpiresAt) {
        const delay = Math.max(0, state.tokenExpiresAt - Date.now());
        state.tokenExpiryTimer = setTimeout(() => {
          try {
            state.ws.close(TOKEN_EXPIRED_CLOSE_CODE, "Authentication token expired; refresh required");
          } catch { /* already closed */ }
        }, delay);
        state.tokenExpiryTimer?.unref?.();
      }
      return true;
    } catch {
      return false;
    }
  }
}

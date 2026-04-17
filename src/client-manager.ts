/**
 * client-manager.ts — Lifecycle-safe wrapper around GannClient.
 *
 * Owns the GannClient instance, heartbeat loop, signaling channel,
 * and a cache of open peer sessions (direct or relay).
 */

import {
  GannClient,
  LoadTracker,
  type AgentSearchResponse,
  type AgentSchemaResponse,
  type QuicDirectFirstResult,
  type QuicDirectFirstSessionHandle,
  type SignalingEvent,
} from "gann-sdk";

import type { GannJsPluginConfig } from "./config.js";
import { isNativeQuicAvailable, transportModeLabel } from "./transport.js";

/**
 * Handler invoked for each inbound message from a remote GANN agent.
 * Receives the parsed JSON payload and the sender's agent ID.
 * Must return a JSON-serializable response to send back.
 */
export type InboundMessageHandler = (
  payload: Record<string, unknown>,
  fromAgentId: string,
) => Promise<Record<string, unknown>>;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type SessionEntry = {
  handle: QuicDirectFirstSessionHandle;
  peerAgentId: string;
  mode: "direct" | "relay";
  createdAt: number;
};

// ── Registration types ───────────────────────────────────────────────

export type CapabilityDescriptor = {
  name: string;
  description?: string;
};

export type RegisterAgentParams = {
  agentName: string;
  description: string;
  capabilities: CapabilityDescriptor[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  version?: string;
  agentType?: string;
  summary?: string;
  appId?: string;
};

export type RegisterAgentResponse = {
  agent_id: string;
  status: string;
  heartbeat_interval: number;
};

export class ClientManager {
  private client: GannClient | null = null;
  private loadTracker: LoadTracker | null = null;
  private connected = false;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly config: GannJsPluginConfig;
  private readonly logger: Logger;
  private responderRunning = false;
  private responderAbort: AbortController | null = null;
  private inboundHandler: InboundMessageHandler | null = null;

  constructor(config: GannJsPluginConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // ── Register agent ────────────────────────────────────────────────

  /**
   * Register a new agent on the GANN server.
   * Calls POST /.gann/register directly (the JS SDK does not expose this).
   * Returns the assigned agent_id and heartbeat interval.
   */
  async registerAgent(params: RegisterAgentParams): Promise<RegisterAgentResponse> {
    const baseUrl = (this.config.baseUrl ?? "https://api.gnna.io").replace(/\/$/, "");
    const url = `${baseUrl}/.gann/register`;

    const body = {
      agent_name: params.agentName,
      version: params.version ?? "1",
      agent_type: params.agentType ?? "agent_chat",
      capabilities: params.capabilities,
      inputs: params.inputs,
      outputs: params.outputs,
      description: params.description,
      summary: params.summary ?? null,
      app_id: params.appId ?? null,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "GANN-API-KEY": this.config.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Agent registration failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as RegisterAgentResponse;
    this.logger.info(
      `[gann-js] agent registered — agent_id=${result.agent_id} status=${result.status}`,
    );
    return result;
  }

  // ── Connect ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;

    const client = new GannClient({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      agentId: this.config.agentId,
    });

    const tracker = new LoadTracker(this.config.capacity ?? 4);
    client.useLoadTracker(tracker);

    await client.connectAgent(this.config.agentId, {
      heartbeatIntervalMs: this.config.heartbeatIntervalMs ?? 30_000,
      onSignal: (event: SignalingEvent) => {
        this.logger.info(`[gann-js] signaling event: ${event.payload?.kind} from=${event.from}`);
      },
      onError: (err: Error) => {
        this.logger.error(`[gann-js] signaling error: ${err.message}`);
      },
    });

    this.client = client;
    this.loadTracker = tracker;
    this.connected = true;

    this.logger.info(
      `[gann-js] agent ${this.config.agentId} connected — transport: ${transportModeLabel()}`,
    );
  }

  // ── Search ───────────────────────────────────────────────────────────

  async searchAgents(params: {
    q: string;
    status?: "online" | "offline" | "degraded" | "blocked";
    limit?: number;
  }): Promise<AgentSearchResponse> {
    const client = this.requireClient();
    return client.searchAgents({
      q: params.q,
      status: params.status,
      limit: params.limit ?? 10,
    });
  }

  // ── Schema ───────────────────────────────────────────────────────────

  async fetchSchema(agentId: string): Promise<AgentSchemaResponse> {
    const client = this.requireClient();
    return client.fetchAgentSchema(agentId);
  }

  // ── Open session ─────────────────────────────────────────────────────

  async openSession(peerAgentId: string): Promise<SessionEntry> {
    const existing = this.sessions.get(peerAgentId);
    if (existing) return existing;

    const client = this.requireClient();

    const handle = await client.dialQuicDirectFirst(peerAgentId, {
      directTimeoutMs: isNativeQuicAvailable()
        ? (this.config.directTimeoutMs ?? 5_000)
        : 1, // skip direct attempt when native is absent
    });

    const entry: SessionEntry = {
      handle,
      peerAgentId,
      mode: handle.result.mode,
      createdAt: Date.now(),
    };
    this.sessions.set(peerAgentId, entry);

    this.logger.info(
      `[gann-js] session opened to ${peerAgentId} — mode=${entry.mode} session=${handle.result.sessionId}`,
    );
    return entry;
  }

  // ── Send message ─────────────────────────────────────────────────────

  async sendMessage(
    peerAgentId: string,
    payload: Record<string, unknown>,
    timeoutMs: number = 30_000,
  ): Promise<unknown> {
    const release = this.loadTracker?.begin();
    try {
      let entry = this.sessions.get(peerAgentId);
      if (!entry) {
        entry = await this.openSession(peerAgentId);
      }

      const { result } = entry.handle;

      let response: unknown;
      if (result.mode === "direct") {
        response = await this.sendDirect(result, payload, timeoutMs);
      } else {
        response = await this.sendRelay(result, payload, timeoutMs);
      }

      // Exchange complete — disconnect session (same flow as Claude-Gann)
      // 1. Signal GANN server  2. Close QUIC transport  3. Close signaling channel
      this.disconnectSessionSignaling(entry.handle, peerAgentId, "request_completed");
      this.closeSessionResources(entry.handle);
      this.sessions.delete(peerAgentId);

      return response;
    } finally {
      release?.();
    }
  }

  // ── Inbound responder ─────────────────────────────────────────────────

  /**
   * Set the handler that processes inbound messages from remote GANN agents.
   * Must be set before calling startResponder().
   */
  setInboundHandler(handler: InboundMessageHandler): void {
    this.inboundHandler = handler;
  }

  /**
   * Start the responder loop — continuously accepts inbound QUIC sessions
   * from remote GANN agents, reads their payload, runs the handler, and
   * sends the response back.
   */
  startResponder(): void {
    if (this.responderRunning) return;
    this.responderRunning = true;
    this.responderAbort = new AbortController();
    this.responderLoop().catch((err) => {
      if (this.responderRunning) {
        this.logger.error(`[gann-js] responder loop crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.logger.info("[gann-js] inbound responder loop started.");
  }

  /**
   * Stop the responder loop gracefully.
   */
  stopResponder(): void {
    this.responderRunning = false;
    this.responderAbort?.abort();
    this.responderAbort = null;
    this.logger.info("[gann-js] inbound responder loop stopped.");
  }

  private async responderLoop(): Promise<void> {
    const client = this.requireClient();

    while (this.responderRunning) {
      let handle: QuicDirectFirstSessionHandle;
      try {
        handle = await client.acceptQuicDirectFirst({
          offerTimeoutMs: 60_000, // re-loop every 60s to check if still running
          directTimeoutMs: isNativeQuicAvailable()
            ? (this.config.directTimeoutMs ?? 5_000)
            : 1,
        });
      } catch (err) {
        // Timeout just means no offer arrived — loop again
        if (this.responderRunning && err instanceof Error && !err.message.includes("Timed out")) {
          this.logger.error(`[gann-js] responder accept error: ${err.message}`);
        }
        continue;
      }

      if (!this.responderRunning) {
        // Shutting down — close the just-accepted session
        handle.channel.close();
        break;
      }

      // Handle this session in the background so we can accept the next one
      this.handleInboundSession(handle).catch((err) => {
        this.logger.error(
          `[gann-js] inbound session error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  private async handleInboundSession(handle: QuicDirectFirstSessionHandle): Promise<void> {
    const release = this.loadTracker?.begin();
    const { result } = handle;
    const fromAgentId = result.peerAgentId;
    let exchangeError = false;

    try {
      this.logger.info(
        `[gann-js] inbound session from ${fromAgentId} — mode=${result.mode} session=${result.sessionId}`,
      );

      // Read the inbound payload
      let payload: Record<string, unknown>;
      if (result.mode === "direct") {
        payload = await this.readDirect(result);
      } else {
        payload = await this.readRelay(result);
      }

      this.logger.info(`[gann-js] inbound payload from ${fromAgentId}: ${JSON.stringify(payload).slice(0, 200)}`);

      // Process via handler
      let response: Record<string, unknown>;
      if (this.inboundHandler) {
        response = await this.inboundHandler(payload, fromAgentId);
      } else {
        response = {
          type: "ack",
          request_id: (payload as any).request_id ?? null,
          status: "received",
          message: "No inbound handler configured.",
        };
      }

      // Send response back
      if (result.mode === "direct") {
        await this.replyDirect(result, response);
      } else {
        await this.replyRelay(result, response);
      }

      this.logger.info(`[gann-js] replied to ${fromAgentId} session=${result.sessionId}`);
    } catch (err) {
      exchangeError = true;
      this.logger.error(
        `[gann-js] failed handling inbound from ${fromAgentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      release?.();
      // Same disconnect flow as Claude-Gann _close_pending_session:
      // 1. Signal GANN server  2. Close QUIC transport  3. Close signaling channel
      this.disconnectSessionSignaling(
        handle,
        fromAgentId,
        exchangeError ? "error" : "reply_sent",
      );
      this.closeSessionResources(handle);
    }
  }

  private async readDirect(
    result: Extract<QuicDirectFirstResult, { mode: "direct" }>,
  ): Promise<Record<string, unknown>> {
    const stream = await result.connection.acceptBi();
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = await stream.read();
      if (chunk === null) break;
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    return JSON.parse(raw);
  }

  private async readRelay(
    result: Extract<QuicDirectFirstResult, { mode: "relay" }>,
  ): Promise<Record<string, unknown>> {
    const frame = await result.transport.recvRelayData();
    const payload = (frame as any).payload ?? frame;
    return typeof payload === "string" ? JSON.parse(payload) : payload;
  }

  private async replyDirect(
    result: Extract<QuicDirectFirstResult, { mode: "direct" }>,
    response: Record<string, unknown>,
  ): Promise<void> {
    const stream = await result.connection.openBi();
    const data = Buffer.from(JSON.stringify(response), "utf-8");
    await stream.write(data);
    await stream.finish();
  }

  private async replyRelay(
    result: Extract<QuicDirectFirstResult, { mode: "relay" }>,
    response: Record<string, unknown>,
  ): Promise<void> {
    await result.transport.relaySend(result.token, result.sessionId, response);
  }

  // ── Disconnect ───────────────────────────────────────────────────────

  disconnect(): void {
    this.stopResponder();

    for (const [peerId, entry] of this.sessions) {
      try {
        this.disconnectSessionSignaling(entry.handle, entry.peerAgentId, "plugin_disconnect");
        this.closeSessionResources(entry.handle);
      } catch {
        // best-effort
      }
      this.sessions.delete(peerId);
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this.logger.info("[gann-js] disconnected — all sessions closed.");
  }

  // ── Status ───────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  getActiveSessions(): Array<{ peerAgentId: string; mode: string; createdAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      peerAgentId: s.peerAgentId,
      mode: s.mode,
      createdAt: s.createdAt,
    }));
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async sendDirect(
    result: Extract<QuicDirectFirstResult, { mode: "direct" }>,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const stream = await result.connection.openBi();
    const data = Buffer.from(JSON.stringify(payload), "utf-8");
    await stream.write(data);
    await stream.finish();

    const chunks: Buffer[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chunk = await stream.read();
      if (chunk === null) break;
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    return raw ? JSON.parse(raw) : null;
  }

  private async sendRelay(
    result: Extract<QuicDirectFirstResult, { mode: "relay" }>,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    await result.transport.relaySend(result.token, result.sessionId, payload);

    const recvPromise = result.transport.recvRelayData();
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Relay recv timeout")), timeoutMs),
    );
    const frame = await Promise.race([recvPromise, timer]);
    return (frame as any).payload ?? frame;
  }

  /**
   * Step 1: Signal the GANN server that this session is done.
   * Matches Claude-Gann's `channel.disconnect_session(session_id, peer_id, reason)`.
   */
  private disconnectSessionSignaling(
    handle: QuicDirectFirstSessionHandle,
    peerAgentId: string,
    reason: string,
  ): void {
    try {
      handle.channel.disconnectSession(
        handle.result.sessionId,
        peerAgentId,
        reason,
      );
      this.logger.info(
        `[gann-js] disconnect signal sent — session=${handle.result.sessionId} peer=${peerAgentId} reason="${reason}"`,
      );
    } catch (err) {
      this.logger.warn(
        `[gann-js] disconnect signal failed for session=${handle.result.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Steps 2 & 3: Close QUIC transport, then close signaling channel.
   * Matches Claude-Gann's `_close_session_resources(channel, result)`.
   */
  private closeSessionResources(handle: QuicDirectFirstSessionHandle): void {
    const { result } = handle;

    // Close QUIC peer connection (direct mode)
    if (result.mode === "direct") {
      try {
        result.connection.close();
      } catch { /* best-effort */ }
    }

    // Close relay transport (relay mode)
    if (result.mode === "relay") {
      try {
        result.transport.close();
      } catch { /* best-effort */ }
    }

    // Close signaling channel
    try {
      handle.channel.close();
    } catch { /* best-effort */ }
  }

  private requireClient(): GannClient {
    if (!this.client) {
      throw new Error("[gann-js] Not connected. The plugin must connect before using tools.");
    }
    return this.client;
  }
}

/**
 * index.ts — OpenClaw GANN JS plugin entry point.
 *
 * Startup sequence:
 * 1. OpenClaw calls register(api) when the gateway starts.
 * 2. Config is read and validated (apiKey, agentId, transport options).
 * 3. A ClientManager is created — wraps GannClient from gann-sdk.
 * 4. connectAgent() runs asynchronously (heartbeat + signaling channel).
 * 5. Four agent tools are registered (search, schema, open-session, send-message).
 * 6. registerService stop() disconnects cleanly on shutdown.
 *
 * No Python subprocess — everything runs in the Node.js event loop.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";
import { ClientManager } from "./client-manager.js";
import { registerTools } from "./tools.js";
import { transportModeLabel } from "./transport.js";
import { createSubagentInboundHandler } from "./inbound-handler.js";

export default definePluginEntry({
  id: "gann-js",
  name: "GANN (JS)",
  description:
    "Connects OpenClaw agents to the Global Agentic Neural Network (GANN) " +
    "via P2P QUIC with relay fallback. Pure Node.js — no Python required.",

  register(api) {
    const logger = api.logger;
    const cfg = resolveConfig(api.pluginConfig ?? {});

    logger.info(`[gann-js] starting — agentId=${cfg.agentId} transport=${transportModeLabel()}`);

    const manager = new ClientManager(cfg, logger);

    // Connect asynchronously — register() must be synchronous.
    manager
      .connect()
      .then(() => {
        logger.info("[gann-js] agent connected — online on the GANN network.");

        // Start accepting inbound sessions from remote GANN agents.
        // Uses the subagent runtime to process inbound requests through the
        // Openclaw agent and return responses over the QUIC session.
        manager.setInboundHandler(
          createSubagentInboundHandler(api.runtime, cfg.agentId, logger),
        );
        manager.startResponder();
      })
      .catch((err: unknown) => {
        logger.error(
          `[gann-js] connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Register tools backed by the client manager
    registerTools(api, manager);
    logger.info(
      "[gann-js] tools registered: gann_register_agent (optional), gann_search_agents, " +
        "gann_get_schema, gann_open_session (optional), gann_send_message (optional)",
    );

    // Lifecycle hook — clean shutdown
    api.registerService({
      id: "gann-js-client",
      async start() {
        // Client is already connecting above — nothing extra needed.
      },
      async stop() {
        logger.info("[gann-js] shutting down — closing sessions and heartbeat.");
        manager.disconnect();
      },
    });
  },
});

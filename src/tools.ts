import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ClientManager } from "./client-manager.js";

export function registerTools(api: OpenClawPluginApi, manager: ClientManager): void {
  // ── 1. Search agents ─────────────────────────────────────────────────

  api.registerTool({
    name: "gann_search_agents",
    label: "Search GANN Agents",
    description:
      "Search the GANN network for registered agents by capability keyword. " +
      "Returns agent IDs, names, statuses, capabilities, and relevance scores.",
    parameters: Type.Object({
      query: Type.String({
        description:
          'Capability search term, e.g. "image generation", "data analysis", or "code review".',
      }),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("online"),
            Type.Literal("offline"),
            Type.Literal("degraded"),
            Type.Literal("blocked"),
          ],
          { description: "Filter by agent status. Omit to return all." },
        ),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)." }),
      ),
    }),
    async execute(_id, params) {
      const result = await manager.searchAgents({
        q: params.query,
        status: params.status ?? undefined,
        limit: params.limit ?? 10,
      });
      return {
        details: null,
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  });

  // ── 2. Get agent schema ──────────────────────────────────────────────

  api.registerTool({
    name: "gann_get_schema",
    label: "Get GANN Agent Schema",
    description:
      "Fetch the declared input/output schema of a GANN agent by its agent_id. " +
      "Use this before sending a message to understand the expected payload shape.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "UUID of the target GANN agent." }),
    }),
    async execute(_id, params) {
      const result = await manager.fetchSchema(params.agent_id);
      return {
        details: null,
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  });

  // ── 3. Open session ──────────────────────────────────────────────────

  api.registerTool(
    {
      name: "gann_open_session",
      label: "Open GANN Session",
      description:
        "Establish a QUIC direct-first (with relay fallback) session to a target agent. " +
        "Sessions are cached — calling again for the same agent reuses the existing session. " +
        "Returns the session mode (direct or relay) and session ID.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "UUID of the target GANN agent." }),
      }),
      async execute(_id, params) {
        const entry = await manager.openSession(params.agent_id);
        return {
          details: null,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                agent_id: params.agent_id,
                mode: entry.mode,
                session_id: entry.handle.result.sessionId,
              }),
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ── 4. Send message ──────────────────────────────────────────────────

  api.registerTool(
    {
      name: "gann_send_message",
      label: "Send GANN Message",
      description:
        "Send a JSON payload to a GANN agent and wait for the response. " +
        "Opens a session automatically if one isn't already open. " +
        "Returns the peer agent's response payload.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "UUID of the target GANN agent." }),
        payload: Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON payload to deliver to the target agent.",
        }),
        timeout_ms: Type.Optional(
          Type.Number({ description: "Response timeout in ms (default 30000)." }),
        ),
      }),
      async execute(_id, params) {
        const response = await manager.sendMessage(
          params.agent_id,
          params.payload as Record<string, unknown>,
          params.timeout_ms ?? 30_000,
        );
        return {
          details: null,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },
    { optional: true },
  );
}

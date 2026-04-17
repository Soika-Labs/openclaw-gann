/**
 * inbound-handler.ts — Bridge inbound GANN messages to the Openclaw agent.
 *
 * When a remote GANN agent sends a message to this agent, the responder loop
 * in ClientManager reads the payload and calls this handler.  The handler:
 *
 * 1. Extracts the task/message from the inbound payload.
 * 2. Runs the Openclaw agent via runtime.subagent.run().
 * 3. Waits for the agent to finish.
 * 4. Reads the agent's last response message.
 * 5. Returns a GANN-protocol response payload.
 */

import type { InboundMessageHandler, Logger } from "./client-manager.js";

/**
 * Minimal subset of PluginRuntime.subagent that we need.
 * Declared here to avoid importing the full Openclaw types at the module level.
 */
interface SubagentRuntime {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
}

/**
 * Create an InboundMessageHandler that routes inbound GANN payloads
 * through the Openclaw subagent runtime and returns the agent's response.
 */
export function createSubagentInboundHandler(
  runtime: { subagent: SubagentRuntime },
  selfAgentId: string,
  logger: Logger,
): InboundMessageHandler {
  return async (payload, fromAgentId) => {
    const requestId =
      (payload.request_id as string) ?? `inbound-${Date.now()}`;

    // Extract the user message from the GANN payload.
    // Convention: payload.task is the natural-language instruction.
    // Fallback: stringify the whole payload.
    const task =
      typeof payload.task === "string"
        ? payload.task
        : typeof payload.message === "string"
          ? payload.message
          : JSON.stringify(payload);

    // Use a deterministic session key per remote agent so conversations persist.
    const sessionKey = `gann:${fromAgentId}`;

    logger.info(
      `[gann-js] routing inbound request_id=${requestId} from=${fromAgentId} to subagent session=${sessionKey}`,
    );

    try {
      // 1. Run the Openclaw agent with the inbound message
      const { runId } = await runtime.subagent.run({
        sessionKey,
        message: task,
        extraSystemPrompt:
          `This message was received from a remote GANN agent (agent_id: ${fromAgentId}). ` +
          `Respond helpfully. Your response will be sent back to the remote agent automatically.`,
        deliver: false, // don't push to UI — this is agent-to-agent
      });

      // 2. Wait for the agent to finish processing
      const waitResult = await runtime.subagent.waitForRun({
        runId,
        timeoutMs: 60_000,
      });

      if (waitResult.status !== "ok") {
        logger.error(`[gann-js] subagent run failed: ${waitResult.error ?? waitResult.status}`);
        return {
          type: "task_response",
          request_id: requestId,
          answer: null,
          error: waitResult.error ?? `Agent run failed (${waitResult.status})`,
          from: selfAgentId,
        };
      }

      // 3. Read the agent's last response message
      const { messages } = await runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 5,
      });

      // Find the last assistant message
      const lastAssistant = [...messages]
        .reverse()
        .find((m: any) => m.role === "assistant" || m.type === "assistant");

      const answer =
        (lastAssistant as any)?.content ??
        (lastAssistant as any)?.text ??
        (lastAssistant as any)?.message ??
        null;

      return {
        type: "task_response",
        request_id: requestId,
        answer: typeof answer === "string" ? answer : JSON.stringify(answer),
        error: null,
        from: selfAgentId,
      };
    } catch (err) {
      logger.error(
        `[gann-js] inbound handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        type: "task_response",
        request_id: requestId,
        answer: null,
        error: err instanceof Error ? err.message : String(err),
        from: selfAgentId,
      };
    }
  };
}

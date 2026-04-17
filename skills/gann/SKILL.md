---
name: gann
description: Use GANN tools to discover agents on the Global Agentic Neural Network and communicate with them via QUIC P2P or relay.
---

You are connected to the **Global Agentic Neural Network (GANN)**.
Your tools let you discover other agents and exchange messages with them in real time.

## Available tools

| Tool | Purpose |
|------|---------|
| `gann_search_agents` | Find agents by capability keyword (e.g. "text generation", "code review") |
| `gann_get_schema` | Fetch an agent's declared input/output schema |
| `gann_open_session` | Establish a P2P QUIC session (with relay fallback) to a peer agent |
| `gann_send_message` | Send a JSON payload to a peer agent and receive the response |

## Workflow

1. **Discover** — Call `gann_search_agents` with a descriptive query to find agents that can help.
2. **Inspect** — Call `gann_get_schema` on a discovered agent to understand what payload it expects.
3. **Communicate** — Call `gann_send_message` with the target `agent_id` and a properly structured `payload`.
   - A session is opened automatically if one doesn't exist yet.
   - The transport negotiates direct QUIC P2P first and falls back to relay if needed.

## Payload convention

Unless the target agent's schema says otherwise, use this standard request format:

```json
{
  "type": "task_request",
  "request_id": "<unique-id>",
  "task": "<the user's question or instruction>",
  "asked_by": "<your agent id>"
}
```

## Response handling

- The response JSON is returned directly from `gann_send_message`.
- Check the `type` field — common values: `task_response`, `ack`, `error`.
- If the response contains an `answer` field, present it to the user.
- If the response indicates an error, report it clearly.

## Rules

- ALWAYS search for agents before assuming an agent_id.
- NEVER fabricate agent IDs — only use IDs returned by `gann_search_agents`.
- Prefer online agents (pass `status: "online"` when searching).
- If `gann_send_message` times out, retry once before reporting failure.

## Inbound messages (automatic)

Other GANN agents can also send messages **to you**. The plugin automatically:
1. Accepts inbound QUIC sessions from remote agents.
2. Routes their `task` payload to your agent for processing.
3. Sends your response back to the remote agent.

You do NOT need to call any tools to handle inbound requests — the responder loop
runs in the background. When a remote agent contacts you, the message appears as a
normal conversation turn with context about the sender's agent ID.

### Inbound payload convention (what remote agents send to you)

```json
{
  "type": "task_request",
  "request_id": "<unique-id>",
  "task": "<their question or instruction>",
  "asked_by": "<their agent id>"
}
```

Your response is automatically packaged as:

```json
{
  "type": "task_response",
  "request_id": "<matching-id>",
  "answer": "<your response text>",
  "error": null,
  "from": "<your agent id>"
}
```

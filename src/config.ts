export interface GannJsPluginConfig {
  apiKey: string;
  agentId: string;
  baseUrl?: string;
  heartbeatIntervalMs?: number;
  capacity?: number;
  directTimeoutMs?: number;
  stunServers?: string[];
}

export function resolveConfig(raw: Record<string, unknown>): GannJsPluginConfig {
  const apiKey = raw["apiKey"];
  const agentId = raw["agentId"];

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("[gann-js] plugins.entries.gann-js.config.apiKey is required.");
  }
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("[gann-js] plugins.entries.gann-js.config.agentId is required.");
  }

  let stunServers: string[] | undefined;
  const stunRaw = raw["stunServers"];
  if (typeof stunRaw === "string" && stunRaw.trim()) {
    stunServers = stunRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return {
    apiKey,
    agentId,
    baseUrl: typeof raw["baseUrl"] === "string" ? raw["baseUrl"] : undefined,
    heartbeatIntervalMs:
      typeof raw["heartbeatIntervalMs"] === "number" ? raw["heartbeatIntervalMs"] : 30_000,
    capacity: typeof raw["capacity"] === "number" ? raw["capacity"] : 4,
    directTimeoutMs:
      typeof raw["directTimeoutMs"] === "number" ? raw["directTimeoutMs"] : 5_000,
    stunServers,
  };
}

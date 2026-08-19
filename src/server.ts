import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { defaultAppServices } from "./services.js";
import type { AppServices } from "./services.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerCandidateTools } from "./tools/candidates.js";
import { registerExplorerTool } from "./tools/explorer.js";
import { registerGameTools } from "./tools/game.js";

const { version: SERVER_VERSION } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

export function buildServer(services: AppServices = defaultAppServices): McpServer {
  const server = new McpServer(
    { name: "llm-chess-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerGameTools(server, services);
  registerAnalysisTools(server, services);
  registerCandidateTools(server, services);
  registerExplorerTool(server, services);
  return server;
}

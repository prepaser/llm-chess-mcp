import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { acquireDefaultAppServices } from "./services.js";
import type { AppServices, DefaultAppServicesLease } from "./services.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerCandidateTools } from "./tools/candidates.js";
import { registerExplorerTool } from "./tools/explorer.js";
import { registerGameTools } from "./tools/game.js";

const { version: SERVER_VERSION } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

function buildServerWithServices(services: AppServices): McpServer {
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

function buildServerWithLease(lease: DefaultAppServicesLease): McpServer {
  try {
    const server = buildServerWithServices(lease.services);
    const closeServer = server.close.bind(server);
    let shutdown: Promise<void> | undefined;
    server.close = (): Promise<void> =>
      (shutdown ??= closeServer().finally(() => lease.release()));
    return server;
  } catch (error) {
    void lease.release();
    throw error;
  }
}

export function buildServer(services?: AppServices): McpServer {
  if (services !== undefined) return buildServerWithServices(services);
  return buildServerWithLease(acquireDefaultAppServices());
}

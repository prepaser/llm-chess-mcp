import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { acquireDefaultAppServices, defaultAppServices } from "./services.js";
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

function buildServerWithLease(
  server: McpServer,
  lease: DefaultAppServicesLease,
): McpServer {
  const closeServer = server.close.bind(server);
  let shutdown: Promise<void> | undefined;
  server.close = (): Promise<void> =>
    (shutdown ??= closeServerWithLease(closeServer, lease));
  return server;
}

async function closeServerWithLease(
  closeServer: () => Promise<void>,
  lease: DefaultAppServicesLease,
): Promise<void> {
  const closeResult = await settle(closeServer);
  const releaseResult = await settle(() => lease.release());
  if (closeResult.status === "rejected" && releaseResult.status === "rejected") {
    throw new AggregateError(
      [closeResult.reason, releaseResult.reason],
      "MCP server close and service release failed",
    );
  }
  if (closeResult.status === "rejected") throw closeResult.reason;
  if (releaseResult.status === "rejected") throw releaseResult.reason;
}

async function settle(work: () => Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await work();
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

export function buildServer(services?: AppServices): McpServer {
  if (services !== undefined) return buildServerWithServices(services);
  const server = buildServerWithServices(defaultAppServices);
  return buildServerWithLease(server, acquireDefaultAppServices());
}

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { acquireDefaultAppServices, defaultAppServices } from "./services.js";
import type { AppServices, DefaultAppServicesLease } from "./services.js";
import { ANONYMOUS_GAME_SCOPE, createScopedGameRepository } from "./games.js";
import { decorateAppServices } from "./service-decorator.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerCandidateTools } from "./tools/candidates.js";
import { registerExplorerTool } from "./tools/explorer.js";
import { registerGameTools } from "./tools/game.js";
import { orderedTeardown } from "./lifecycle.js";

const { version: SERVER_VERSION } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

function buildServerWithServices(services: AppServices): McpServer {
  let source: AppServices["games"] | undefined;
  let scoped: AppServices["games"] | undefined;
  const scopedServices = decorateAppServices(services, {
    get games() {
      const games = services.games;
      if (games !== source) {
        source = games;
        scoped = games?.forScope
          ? createScopedGameRepository(games, ANONYMOUS_GAME_SCOPE)
          : games;
      }
      return scoped ?? games;
    },
  });
  const server = new McpServer(
    { name: "llm-chess-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerGameTools(server, scopedServices);
  registerAnalysisTools(server, scopedServices);
  registerCandidateTools(server, scopedServices);
  registerExplorerTool(server, scopedServices);
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
  await orderedTeardown(
    [closeServer, () => lease.release()],
    "MCP server close and service release failed",
  );
}

export function buildServer(services?: AppServices): McpServer {
  if (services !== undefined) return buildServerWithServices(services);
  const server = buildServerWithServices(defaultAppServices);
  return buildServerWithLease(server, acquireDefaultAppServices());
}
